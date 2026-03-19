# Concentration Naming Migration Report

**Date:** 2025-03-13  
**Scope:** DB-backed migration from legacy `topConcentrationPct` to explicit theme/market naming.

---

## 1. Migration strategy chosen

**Chosen: Rename column + add optional market column (single migration).**

- **Why not Option A (add new columns, backfill, switch, drop old):** We had a full audit of usages; a single rename in PostgreSQL is metadata-only (no data copy), preserves all data, and avoids a dual-write/dual-read period. Risk of missing a reference was mitigated by updating all code in one pass and adding regression tests that assert no legacy field name remains in active paths.
- **Why rename over additive then drop:** Simpler deployment: one migration, one code deploy. No temporary dual columns or backfill logic. Historical rows keep their theme value (the column is renamed, not copied). Optional `topMarketConcentrationPct` was added for future persistence; existing rows have it null.

---

## 2. Files changed

| File | Change |
|------|--------|
| **prisma/schema.prisma** | `PortfolioSnapshot`: `topConcentrationPct` → `topThemeConcentrationPct`, added `topMarketConcentrationPct String?`. `MlTrainingExample`: same. |
| **prisma/migrations/20250313120000_concentration_explicit_theme_market_naming/migration.sql** | RENAME COLUMN `topConcentrationPct` → `topThemeConcentrationPct` on both tables; ADD COLUMN `topMarketConcentrationPct` TEXT on both. |
| **lib/polymarket/analytics.ts** | `persistSnapshot`: write `topThemeConcentrationPct` and `topMarketConcentrationPct` (removed `topConcentrationPct`). |
| **lib/ml/dataset.ts** | All reads: `snapshot.topThemeConcentrationPct`, `ex.topThemeConcentrationPct`. All writes: `topThemeConcentrationPct`. |
| **lib/ml/score-live.ts** | Read `snapshot.topThemeConcentrationPct`. |
| **lib/ml/features.ts** | Removed fallback to `raw.topConcentrationPct`; use `raw.topThemeConcentrationPct` only. Comments updated. |
| **lib/decision/recompute.ts** | Read `snapshot.topThemeConcentrationPct`. |
| **lib/polymarket/recommendations-recompute.ts** | Read `snapshot.topThemeConcentrationPct`. |
| **app/api/analytics/data/route.ts** | Map `snapshot.topThemeConcentrationPct` and `snapshot.topMarketConcentrationPct` to API response. |
| **lib/portfolio/__tests__/portfolio-api-regression-tests.ts** | Overview: no legacy `topConcentrationPct`. New block: Prisma schema, analytics, ML dataset, score-live, recompute, analytics data route do not use legacy field name. |
| **docs/TRUTH_MODEL_COMPATIBILITY_SHIM_REMOVAL_PLAN.md** | Section 1 updated to MIGRATED; summary table and migration order updated. |
| **docs/PORTFOLIO_LIVE_TRUTH_RESPONSE_CONTRACT.md** | Compatibility shims and concentration semantics updated. |
| **docs/CONCENTRATION_NAMING_MIGRATION_REPORT.md** | This report. |

**Not changed:** `audit-dumps/`, `audit_dumps/` (historical snapshots).

---

## 3. Contract before / after

| Location | Before | After |
|----------|--------|--------|
| **PortfolioSnapshot** | `topConcentrationPct String` (theme only) | `topThemeConcentrationPct String`, `topMarketConcentrationPct String?` |
| **MlTrainingExample** | `topConcentrationPct String?` (theme only) | `topThemeConcentrationPct String?`, `topMarketConcentrationPct String?` |
| **persistSnapshot** | Wrote `topConcentrationPct: data.topThemeConcentrationPct` | Writes `topThemeConcentrationPct`, `topMarketConcentrationPct` |
| **All reads** | `snapshot.topConcentrationPct` / `ex.topConcentrationPct` | `snapshot.topThemeConcentrationPct` / `ex.topThemeConcentrationPct` |
| **Analytics API** | `topThemeConcentrationPct: snapshot.topConcentrationPct`, `topMarketConcentrationPct: null` | `topThemeConcentrationPct: snapshot.topThemeConcentrationPct`, `topMarketConcentrationPct: snapshot.topMarketConcentrationPct ?? null` |

---

## 4. ML / historical data

- **Historical snapshot rows:** Renamed column keeps existing theme concentration values; no backfill needed. `topMarketConcentrationPct` is null for existing rows.
- **Historical ML rows:** Same: `topThemeConcentrationPct` holds the previous theme value (column rename). `topMarketConcentrationPct` is null. Feature pipeline and training continue to use theme concentration; no silent semantic change. Old training data remains valid (same numeric values, new column name).
- **New writes:** Analytics `computeSnapshot` already produces both theme and market; `persistSnapshot` now stores both. ML dataset still only receives theme from snapshot when building examples; market can be added to the pipeline later if needed.

---

## 5. Dual-write / dual-read period

**None.** Single migration and single code deploy. No temporary compatibility layer.

---

## 6. Follow-up before dropping old column

**Not applicable.** The old column was renamed, not left in place. There is no "old column" to drop. If in the future we add a second migration that, for example, added a new column and then dropped another, we would document it here—but in this migration the only change is rename + add optional column.

---

## 7. Regression coverage

- Overview route does not use legacy `topConcentrationPct`.
- Prisma schema uses `topThemeConcentrationPct` and does not contain `topConcentrationPct`.
- Analytics persist, ML dataset, ML score-live, decision recompute, analytics data route: source checks assert no occurrence of `topConcentrationPct` in active code paths.

Run: `npx ts-node --project tsconfig.tests.json -r tsconfig-paths/register lib/portfolio/__tests__/portfolio-api-regression-tests.ts`

---

## 8. Deployment

1. Run Prisma migration: `npx prisma migrate deploy` (or `prisma migrate dev` in development).
2. Deploy application code that uses the new schema field names. Prisma client will be regenerated from the updated schema (`prisma generate`).

No backfill script required. No downtime for additive rename + new nullable column.
