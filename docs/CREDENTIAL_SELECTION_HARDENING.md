# Validity-Aware Credential Selection

## Summary

Runtime credential selection now **prefers fully valid credentials** (authoritative validation all true) and **fails closed** when no such row exists. The previous "newest by `updatedAt`" policy could pick a stale or invalid row first and only fail at preflight.

## New Ranking Policy

1. **Fully valid** = `validationApiKeysOk === true && validationTradesOk === true && validationOrdersOk === true`.  
   `null` or `false` on any of these counts as not valid (legacy rows rank below).

2. **Ordering**: Among all candidate rows (up to `MAX_CANDIDATES` by `updatedAt` desc):
   - Fully valid rows are ranked above any not-fully-valid row.
   - Among fully valid rows: newest `updatedAt` first.
   - Among not-fully-valid rows: newest `updatedAt` first (used only for sort stability; we never choose one).

3. **Selection**:
   - If the best row after sort is fully valid → return that credential with `selectionReason: "fully_valid_newest"`.
   - If no row is fully valid → return **`credential: null`** (no fallback to invalid/stale).  
   Diagnostics still report `selectionReason: "no_fully_valid_credential"` or `"no_rows"`.

**Fallback when no fully valid credential exists:** We **return null and fail closed**. We do not return the newest row with a "fallback" reason. Rationale: using a credential that has not passed full authoritative validation risks 401s and wasted preflight; failing closed forces re-init or fixing the stored credential.

## Selection Diagnostics

Returned with every `getStoredCredentials()` call (no secrets):

- `credentialCount` – total credential rows.
- `chosenCredentialId` – id of chosen row, or null.
- `selectionReason` – `"no_rows"` | `"no_fully_valid_credential"` | `"fully_valid_newest"`.
- `credentialUpdatedAt` – `updatedAt` of chosen row when one is chosen.
- `validationSummary` – `{ apiKeysOk, tradesOk, ordersOk }` for the chosen row when one is chosen.
- `hadFullyValidAlternatives` – when a credential is chosen, whether another fully valid row existed.

## API Change

`getStoredCredentials()` now returns:

```ts
{
  credential: StoredCredential | null;
  selectionDiagnostics: CredentialSelectionDiagnostics;
}
```

Callers must use `.credential` (and optionally `.selectionDiagnostics`).  
`getStoredCredentialsForReadOnly()` still returns `StoredCredential | null` (it returns `(await getStoredCredentials()).credential`).

## Implementation Details

- **Comparator**: `rankCredentialRows(a, b)` in `lib/polymarket/auth.ts`. Fully valid first, then by `updatedAt` desc. Exported for tests.
- **Selection**: Fetch up to 20 rows by `updatedAt` desc, map to `CredentialRowForRanking`, sort with `rankCredentialRows`, then `selectBestCredentialIndex()`. If index ≥ 0, decrypt and return that row; else return null with diagnostics.
- **Backward compatibility**: Rows with `null` validation fields are treated as not fully valid and never chosen when a fully valid row exists.

## Worker Logging

`startup_credentials_loaded` now includes:

- `selectionReason`
- `validationSummary`
- `credentialCount`
- `chosenCredentialId`
- `hadFullyValidAlternatives`

Preflight gate is unchanged: if a credential is returned, preflight still runs and fails closed on auth failure.

## Files Changed

| File | Change |
|------|--------|
| `lib/polymarket/auth.ts` | `CredentialRowForRanking`, `isFullyValidCredentialRow`, `rankCredentialRows`, `selectBestCredentialIndex`, `CredentialSelectionDiagnostics` extended; `getStoredCredentials()` returns `{ credential, selectionDiagnostics }`, validity-aware selection, no fallback to invalid. |
| `worker/stream-runtime.ts` | Destructure `{ credential, selectionDiagnostics }`; log `selectionReason`, `validationSummary`, `credentialCount`, `chosenCredentialId`, `hadFullyValidAlternatives`. |
| `scripts/probe-polymarket-l2-credential.ts` | Destructure `{ credential, selectionDiagnostics }`; log selection diagnostics when present. |
| `lib/polymarket/user-sync.ts` | Use `{ credential: creds }` from `getStoredCredentials()`. |
| `lib/polymarket/ws-user.ts` | Use `{ credential: creds }`. |
| `lib/runtime/reconciliation/runtime-reconciliation.ts` | Use `{ credential: creds }`. |
| `lib/runtime/truth/exchange-truth-pull.ts` | Use `{ credential: creds }` in both fetch functions. |
| `lib/polymarket/trading.ts` | Use `{ credential: creds }`. |
| `lib/polymarket/recompute.ts` | Use `{ credential: creds }`. |
| `app/api/polymarket/sync-stats/route.ts` | Use `{ credential: creds }`. |
| `lib/polymarket/__tests__/credential-selection-tests.ts` | **New.** Unit tests for ranking and selection. |
| `lib/polymarket/__tests__/l2-auth-validation-tests.ts` | Assert auth uses validity-aware ranking (source check). |
| `package.json` | Script `test:credential-selection`. |

## Tests

- **credential-selection-tests.ts**: `isFullyValidCredentialRow`, `rankCredentialRows`, `selectBestCredentialIndex`; scenarios: newer invalid / older valid → older selected; both valid → newest; none valid → chosenIndex -1; no rows → no_rows; legacy null fields rank below valid.
- **l2-auth-validation-tests.ts**: Auth module uses `rankCredentialRows` / `selectBestCredentialIndex` / `isFullyValidCredentialRow`.

Run: `npm run test:credential-selection`, `npm run test:l2-auth-validation`.
