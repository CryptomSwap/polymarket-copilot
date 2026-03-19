# Portfolio API: Live Truth Response Contract

## Summary

When portfolio endpoints use **live official data**, the response must not expose **persisted DB snapshot metadata** (e.g. `snapshot.id`, `snapshot.createdAt`) as if it were the live snapshot. The "last updated" timestamp for the UI must come from **top-level `asOf`** (and `freshnessMs`), not from any persisted row.

---

## Before vs After (Overview)

### Before

- **`GET /api/portfolio/overview`** returned a single `snapshot` object that **mixed**:
  - Live-computed totals (totalCurrentValue, openPositionsCount, etc.)
  - Persisted DB row fields: `id`, `createdAt`
- Frontends could mistakenly use `snapshot.createdAt` for "last updated", which is **stale** (when the last recompute ran), not when the live data was fetched.
- Top-level `asOf` and `freshnessMs` were already present but the hybrid object was misleading.

### After

- **`snapshot`** contains **only live-computed totals** (no `id`, no `createdAt`).
- **Persisted DB row** (when present) is under **`persistedSnapshotMeta`**: `{ id, createdAt }` for audit/debug only. Never use for "last updated" when using live data.
- **Top-level** `sourceOfTruth`, `asOf`, `freshnessMs` (and orders: `orderSourceOfTruth`, `ordersAsOf`, `ordersFreshnessMs`) are the **canonical** live timestamps and source labels.
- Frontend freshness UI uses **only** `asOf` / `freshnessMs` / `sourceOfTruth`; it does not use `snapshot.createdAt`.

---

## Exact Response Contract (Overview)

| Location | Field | Meaning |
|----------|--------|--------|
| **Top level** | `sourceOfTruth` | `"official"` \| `"derived"` \| `"mixed_fallback"` for positions. |
| **Top level** | `asOf` | ISO string when **this response** was computed (live timestamp). Use for "last updated". |
| **Top level** | `freshnessMs` | `0` = fresh fetch, `> 0` = cached age (ms), `null` = unknown. See [Freshness Contract](./PORTFOLIO_FRESHNESS_CONTRACT.md). |
| **Top level** | `freshnessState` | `"fresh"` \| `"cached"` \| `"unknown"`. Explicit; do not treat unknown as fresh. |
| **Top level** | `orderSourceOfTruth`, `ordersAsOf`, `ordersFreshnessMs`, `ordersFreshnessState` | Same for open orders. |
| **`snapshot`** | All numeric/total fields | Live-computed from current positions/orders. **No `id` or `createdAt`.** |
| **`snapshot`** | `topThemeConcentrationPct` | Largest **theme** % of portfolio (by exposure). One theme can span many markets. |
| **`snapshot`** | `topMarketConcentrationPct` | Largest **single market** % of portfolio (by exposure). |
| **`persistedSnapshotMeta`** (optional) | `id`, `createdAt` | Persisted PortfolioSnapshot row; audit/debug only. Do **not** use for UI "last updated". |

**Concentration semantics:** Theme concentration is the share of portfolio value in the single largest theme (e.g. "Elections"). Market concentration is the share in the single largest market. Top theme concentration can exceed top market concentration when many positions belong to one theme but different markets. DB columns are `topThemeConcentrationPct` and `topMarketConcentrationPct` (see concentration naming migration).

---

## Other Routes

- **`GET /api/portfolio/positions`** and **`GET /api/portfolio/intelligence`** do not return a hybrid snapshot object with DB id/createdAt. They expose `sourceOfTruth`, `asOf`, `freshnessMs` at top level (or in diagnostics).
- **`GET /api/portfolio/intelligence`** returns `intelligence.summary.topThemeConcentrationPct` and `intelligence.summary.topMarketConcentrationPct`. The HIGH_CONCENTRATION flag and messages refer explicitly to **theme** concentration where applicable.
- **`GET /api/portfolio/behavior-flags`** returns top-level **`asOf`** (ISO string when the response was built). Flags are from a **separate fetch** from overview; the dashboard must not imply they share the same timestamp. Overview widget shows "Flags as of X" and, when materially different from overview.asOf, "Separate refresh — may not match overview snapshot."

---

## Frontend

- **PortfolioFreshnessIndicator** and any "last updated" UI use **only** top-level `asOf` / `ordersAsOf` and freshness fields. They do **not** accept or display `snapshot.createdAt`. Freshness states (fresh / cached / unknown) are rendered distinctly; unknown is not implied to be fresh. See [Freshness Contract](./PORTFOLIO_FRESHNESS_CONTRACT.md).
- **Mixed-time:** Positions and orders can have different `asOf` and freshness. The UI contract **allows** (and encourages) separate "Positions: X" and "Orders: Y" labels when they differ; do not pretend a single unified snapshot exists. When they match, a unified "Last updated" line is acceptable.
- **PortfolioSnapshot** type in the overview widget: `id` and `createdAt` are **optional** and deprecated for display; prefer `overview.asOf` / `overview.ordersAsOf` for last-updated.
- **Behavior flags**: Fetched in parallel with overview; each response has its own `asOf`. The overview widget labels flags with "Flags as of X" and does not visually imply they are from the same snapshot as the overview totals.

---

## Regression Tests

- **Overview route**: `snapshot` object does not include `id` or `createdAt`; persisted row is under `persistedSnapshotMeta`; top-level `asOf`/`freshnessMs`/`freshnessState` are present; fresh fetch returns `freshnessMs: 0` (not null).
- **Freshness indicator**: Uses `asOf` for the display label; accepts `freshnessState`; distinguishes fresh / cached / unknown; does not treat unknown as fresh.
- **Display timestamp contract**: Canonical "last updated" is `asOf` when present; never `snapshot.createdAt` (tested in live-truth-tests).
- **Behavior flags**: Route returns top-level `asOf`; overview widget stores `flagsAsOf` and shows flags timing; when flags and overview timestamps differ by > 5s, widget shows "Separate refresh — may not match overview snapshot."

---

## Truth Model Invariants (production-readiness)

The suite in `lib/portfolio/__tests__/truth-model-invariants.ts` enforces the following invariants. Violations indicate impossible or inconsistent states.

| Invariant | Meaning |
|-----------|--------|
| **Overview from open set only** | Overview totals are computed only from the open official position set; closed rows are excluded by status/endDate. |
| **Closed official rows excluded** | Closed official rows must not appear in open positions; positions route and intelligence filter by openOnly / status / endDate. |
| **Concentration bounds** | `topThemeConcentrationPct` and `topMarketConcentrationPct` are ≤ 100; `topMarketConcentrationPct` ≤ `topThemeConcentrationPct` (single market is subset of its theme). |
| **hasCompleteDisplayMetadata ⇒ fields present** | If `hasCompleteDisplayMetadata` is true, required display fields (market id, title, slug, category, theme, endDate) are non-null. |
| **Unresolved counts aligned** | Summary unresolved counts match diagnostics unresolved counts; both use the same canonical classifier (`getResolutionCounts`). |
| **Freshness contract** | `freshnessMs = 0` ⇒ fresh; `freshnessMs > 0` ⇒ cached; `freshnessMs = null` ⇒ unknown. No null-as-fresh. |
| **Mixed-time UI** | When positions and orders timestamps differ, the UI contract supports separate display (Positions: X · Orders: Y). |
| **Snapshot no persisted metadata** | Overview snapshot object must not contain persisted row metadata (`id`, `createdAt`); those live under `persistedSnapshotMeta`. |
| **Flags timing separate** | Behavior flags response has its own `asOf`; widget does not imply flags share overview timestamp. |
| **Resolution quality** | `isResolved` false ⇒ `resolutionSource` "unresolved" and `unresolvedReason` set; resolved ⇒ `unresolvedReason` null. |

Run: `npx ts-node --project tsconfig.tests.json -r tsconfig-paths/register lib/portfolio/__tests__/portfolio-api-regression-tests.ts` (includes invariants).

---

## Compatibility Shims (post–truth-model hardening)

| Item | Status | Notes |
|------|--------|--------|
| **DB columns** | **Migrated.** Schema uses `topThemeConcentrationPct` and `topMarketConcentrationPct`; no legacy `topConcentrationPct`. |
| **`hasFullMarketMetadata`** | **Removed.** Canonical completeness field is `hasCompleteDisplayMetadata` only. |
| **Diagnostics `unresolved`** | **Removed.** Canonical field is `diagnostics.unresolvedPositions` only. |
