# Truth-Model Hardening: Final Consistency Cleanup Report

**Date:** Post–hardening pass  
**Scope:** Stale references, docs, comments, compatibility shims. No behavior changes.

---

## 1. Files Changed (this pass)

| File | Change |
|------|--------|
| **docs/LIVE_TRUTH_ARCHITECTURE.md** | `freshnessMs` row: clarified `0` = fresh, `> 0` = cached, `null` = unknown; linked to PORTFOLIO_FRESHNESS_CONTRACT. Fallback bullet: `freshnessMs` = null (unknown), not 0. |
| **docs/LIVE_TRUTH_FALLBACK_BEHAVIOR.md** | Note that `freshnessMs` = null means unknown (do not treat as fresh); link to PORTFOLIO_FRESHNESS_CONTRACT. |
| **docs/NEXT_PHASE_IMPLEMENTATION_PLAN.md** | Clarified `topConcentrationPct` as DB column (theme only); API uses `topThemeConcentrationPct`/`topMarketConcentrationPct`. |
| **docs/PORTFOLIO_LIVE_TRUTH_RESPONSE_CONTRACT.md** | Added **Compatibility shims** section: DB `topConcentrationPct`, deprecated `hasFullMarketMetadata`, diagnostics `unresolved`. |
| **app/api/portfolio/positions/route.ts** | Comment: `hasFullMarketMetadata` marked as deprecated alias in quality shape. |
| **lib/portfolio/__tests__/portfolio-api-regression-tests.ts** | Comments on `hasFullMarketMetadata` assertions: deprecated alias. |
| **docs/TRUTH_MODEL_CLEANUP_REPORT.md** | This report. |

---

## 2. Old Fields Kept for Compatibility

| Field / artifact | Where | Action |
|------------------|--------|--------|
| **DB column `topConcentrationPct`** | — | **Migrated.** Schema uses `topThemeConcentrationPct` and `topMarketConcentrationPct`. See CONCENTRATION_NAMING_MIGRATION_REPORT. |
| **`hasFullMarketMetadata`** | — | **Removed.** Canonical completeness field is `hasCompleteDisplayMetadata` only. |
| **Diagnostics `unresolved`** | Intelligence and positions diagnostics | **Keep.** Same value as `unresolvedPositions`; backward-compatible. |

---

## 3. Stale References Not Changed (intentional)

- **audit-dumps/** (all bundles, live-truth-audit): Historical snapshots; left as-is.
- **tools/create-live-truth-audit-dumps.ts**: Logs `freshnessMs`; no semantic change needed.
- **Concentration:** All reads/writes now use `topThemeConcentrationPct` / `topMarketConcentrationPct` (DB migration completed; see CONCENTRATION_NAMING_MIGRATION_REPORT). No remaining `topConcentrationPct` (e.g. `lib/polymarket/analytics.ts`, `lib/ml/dataset.ts`, `lib/decision/recompute.ts`, `lib/polymarket/recommendations-recompute.ts`, `lib/ml/score-live.ts`, `app/api/analytics/data/route.ts`): Already documented with “DB column” comments; no change.

---

## 4. Known Follow-Up Items

- **Done:** DB concentration naming migration completed (`topConcentrationPct` → `topThemeConcentrationPct` + `topMarketConcentrationPct`). See CONCENTRATION_NAMING_MIGRATION_REPORT.
- **Done:** `hasFullMarketMetadata` removed; UI and API use only `hasCompleteDisplayMetadata`.
- **Regression:** Keep running `lib/portfolio/__tests__/portfolio-api-regression-tests.ts` (includes truth-model invariants) in CI.

---

## 5. Test Status

- **Portfolio regression + invariants:** Run  
  `npx ts-node --project tsconfig.tests.json -r tsconfig-paths/register lib/portfolio/__tests__/portfolio-api-regression-tests.ts`  
  Expected: all passed (no behavior change in this cleanup).
- **Truth-model invariants:** Covered in same suite; 40 invariants.

No new tests added in this cleanup; existing tests confirm deprecated alias and contract semantics.
