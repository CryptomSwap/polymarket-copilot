# L2 Auth Production-Grade Fix

## Root cause

1. **False green validation:** Init and runtime relied on GET `/auth/api-keys` alone. That endpoint can return 200 while GET `/data/orders` and GET `/data/trades` return 401 for the same credential, so credentials were accepted at init but failed on real endpoints in the worker.
2. **No preflight:** The worker went straight into rebuild (e.g. GET `/data/orders`) without checking that the loaded credential was still valid on real endpoints, so startup failed late with 401.
3. **Duplicate signing logic:** The probe script and validation duplicated URL/requestPath construction and fetch; only `buildL2Headers` was shared, increasing the risk of path/query mismatch.
4. **No structured validation persistence:** Validation results were not stored, so we couldn’t see whether a credential last passed api-keys, trades, and orders.

## How the fix prevents recurrence

1. **Authoritative multi-endpoint validation:** Validation calls GET `/auth/api-keys`, GET `/data/trades`, and GET `/data/orders?next_cursor=MA==` (open-orders read; path-only signing to match SDK). `overallOk = strongAuthOk` (api-keys + trades); `dataOrdersOk` is reported for diagnostics. Init and preflight use this; no credential is accepted on `/auth/api-keys` alone.
2. **Startup auth preflight gate:** Before rebuild, the worker runs the same authoritative validation. If `!overallOk`, it logs `auth_preflight_failed` with diagnostics (no secrets), throws, and does not call open-orders fetch. Rebuild runs only after `auth_preflight_ok`.
3. **Single canonical L2 GET flow:** All L2-authenticated GETs go through `buildRequestPathForGet(path, params)` and `clobGetWithL2Raw` (or `clobGetWithL2` which uses it). Request path generation, query handling, headers, and fetch live in one place; the probe script and validation use the same helpers, so signed path and request always match.
4. **Validation result persistence:** Optional columns `validationApiKeysOk`, `validationTradesOk`, `validationOrdersOk` store the last authoritative result (no secrets). Init sets them when storing credentials.
5. **Credential selection and diagnostics:** `getStoredCredentials()` continues to take the newest row by `updatedAt` and now returns `selectionDiagnostics: { credentialCount, credentialUpdatedAt }` and the worker logs them, so we can confirm which credential was chosen and that only one is used.

## Exact files changed

| File | Change |
|------|--------|
| **lib/polymarket/l2-readonly.ts** | Exported `CLOB_HOST`. Added `buildRequestPathForGet(path, params)` (canonical URL + requestPath). Refactored `clobGetWithL2Raw` to use it and return `{ status, body, requestPath }`; made it exported. Refactored `clobGetWithL2` to use `clobGetWithL2Raw` and parse JSON. Added `validateCredentialsWithClobAuthoritative(creds)` (probes api-keys, trades, orders; returns `apiKeysOk`, `tradesOk`, `ordersOk`, `overallOk`, diagnostics). Replaced `validateCredentialsWithClob` to use authoritative validation; success only when `overallOk`. |
| **prisma/schema.prisma** | On `PolymarketApiCredential`: added `validationApiKeysOk`, `validationTradesOk`, `validationOrdersOk` (each `Boolean?`). |
| **prisma/migrations/20260312160957_add_authoritative_validation_columns/migration.sql** | New migration adding the three validation columns. |
| **app/api/polymarket/init-credentials/route.ts** | Switched to `validateCredentialsWithClobAuthoritative`. Proceed only when `validation.overallOk`. Response diagnostics include `apiKeysOk`, `tradesOk`, `ordersOk`, `overallOk`, and status codes. Upsert sets `validationApiKeysOk`, `validationTradesOk`, `validationOrdersOk` from the validation result. |
| **lib/polymarket/auth.ts** | Added `CredentialSelectionDiagnostics` and `selectionDiagnostics: { credentialCount, credentialUpdatedAt }` to `getStoredCredentials()`. Selection still `findFirst` with `orderBy: { updatedAt: "desc" }`; added a parallel `count()` for `credentialCount`. |
| **worker/stream-runtime.ts** | After loading creds, if creds exist: run `validateCredentialsWithClobAuthoritative(l2Creds)`. If `!preflight.overallOk`, log `auth_preflight_failed` (with apiKeysOk, tradesOk, ordersOk, status codes), throw, and do not run rebuild. On success log `auth_preflight_ok`. Added `selectionDiagnostics` to `startup_credentials_loaded` log. |
| **scripts/probe-polymarket-l2-credential.ts** | Removed local URL/requestPath/fetch logic; now uses exported `clobGetWithL2Raw` from l2-readonly. |
| **lib/polymarket/__tests__/l2-auth-validation-tests.ts** | New regression tests: requestPath includes query when params present; no params => path only; api-keys=200 and trades/orders=401 => `overallOk` false; all 200 => `overallOk` true; requestPath equals URL pathname+search; credential selection uses `orderBy: { updatedAt: "desc" }` (source inspection). |
| **package.json** | Added script `test:l2-auth-validation`. |

## Prisma migration

- **Name:** `20260312160957_add_authoritative_validation_columns`
- **Apply:** `npx prisma migrate deploy` (or `npx prisma migrate dev` in dev).
- **Rollback:** Not required for backward compatibility; new columns are optional.

## Backward compatibility

- Existing credential rows get `validationApiKeysOk`/`validationTradesOk`/`validationOrdersOk` = null; they still work. Init and preflight re-validate; if the credential fails authoritative validation, the user must re-init.
- Callers of `getStoredCredentials()` receive an extra `selectionDiagnostics` field; they can ignore it.
- `validateCredentialsWithClob` still exists and returns the same success/failure shape; it now uses authoritative validation under the hood, so success means all three endpoints returned 200.

## Tests added

- **test:l2-auth-validation:** Authoritative validation (no false green), requestPath matches request, credential selection by `updatedAt` desc.
- **test:auth-polyaddress:** Unchanged (polyAddress storage and init-credentials payload).
- **test:l2-trades:** Unchanged (trades pagination; still passes with canonical GET).

## Operator notes

- After deploy, run the new migration. Re-init credentials so they are validated against all three endpoints; if Polymarket rejects on orders/trades, init will now fail with clear diagnostics.
- Worker startup will log `auth_preflight_ok` before rebuild; if preflight fails, `auth_preflight_failed` and the process exit before any GET `/data/orders` call.
