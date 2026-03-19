# Truth-Model Compatibility Shim Removal Plan

**Goal:** Identify what must be true before we can safely remove each temporary compatibility shim, and in what order.

**Scope:** Main codebase only. `audit-dumps/` and `audit_dumps/` are historical and not part of removal.

---

## 1. Shim: DB column `topConcentrationPct` — **MIGRATED**

**Status:** DB migration completed. Schema and code now use `topThemeConcentrationPct` and `topMarketConcentrationPct`. See `docs/CONCENTRATION_NAMING_MIGRATION_REPORT.md`. Previous role: Prisma/DB column name storing theme concentration only. All API responses and business logic use `topThemeConcentrationPct` / `topMarketConcentrationPct`; code that reads/writes the DB uses `topConcentrationPct` and maps it.

### 1.1 Occurrences (main codebase)

| File | Type | Classification |
|------|------|----------------|
| **prisma/schema.prisma** | Model `PortfolioSnapshot` line 299, `MlTrainingExample` line 774 | **DB schema** — defines column name. |
| **lib/polymarket/analytics.ts** | Line 116: `topConcentrationPct: data.topThemeConcentrationPct` | **DB write** — persists theme concentration into DB column. |
| **lib/ml/dataset.ts** | Lines 54, 136, 162, 222, 313, 420: read/write `snapshot.topConcentrationPct` / `ex.topConcentrationPct` | **DB/persistence** — reads from PortfolioSnapshot / MlTrainingExample; writes to MlTrainingExample. |
| **lib/ml/score-live.ts** | Lines 131–132: read `snapshot.topConcentrationPct` | **DB read** — snapshot from DB. |
| **lib/ml/features.ts** | Lines 42, 140, 176: comment + fallback `raw.topConcentrationPct` when building features from ML rows | **Persistence/backward compat** — ML rows in DB use column name. |
| **lib/decision/recompute.ts** | Lines 50–51: read `snapshot.topConcentrationPct` | **DB read** — snapshot from DB. |
| **lib/polymarket/recommendations-recompute.ts** | Lines 66–67: read `snapshot.topConcentrationPct` | **DB read** — snapshot from DB. |
| **app/api/analytics/data/route.ts** | Line 62: `topThemeConcentrationPct: snapshot.topConcentrationPct` | **DB read** — maps DB column to API field name. |
| **docs/** (PORTFOLIO_LIVE_TRUTH, NEXT_PHASE, POLYMARKET_DATA_COVERAGE, TRUTH_MODEL_CLEANUP_REPORT) | References to legacy column | **Docs** — explain current state / compatibility. |
| **lib/portfolio/__tests__/portfolio-api-regression-tests.ts** | Line 312: asserts overview does *not* return `topConcentrationPct: String` | **Test** — guards API contract. |

### 1.2 What blocks removal

- **Prisma schema** and existing DB data use the column name `topConcentrationPct`. Removal requires a **DB migration**: add new column(s) or rename, backfill if needed, then drop old column and update schema.

### 1.3 Safe / migrate next / remove when

- **Safe now:** All current uses are correct (DB-only or explicit mapping). No behavioral change.
- **Migrate next:** Nothing to “migrate” in app code until DB is changed.
- **Remove only after:**  
  1. Add a Prisma migration: e.g. rename `topConcentrationPct` → `topThemeConcentrationPct` on `PortfolioSnapshot` and `MlTrainingExample` (or add new column, backfill, drop old).  
  2. Update all reads/writes and schema to use the new name.  
  3. Update docs and tests to drop “legacy column” wording.

### 1.4 Recommended order for this shim

1. **Phase 1:** Keep as-is (current state is documented and correct).  
2. **Phase 2:** Create and run DB migration; update Prisma schema and every file in §1.1 to use the new column name; then remove compatibility comments.

---

## 2. Shim: Deprecated alias `hasFullMarketMetadata` — **REMOVED**

**Previous role:** Alias for `hasCompleteDisplayMetadata` in quality types and API/UI.

**Status:** Removed. Canonical completeness field is `hasCompleteDisplayMetadata` only. Types, positions route (canonical and legacy), portfolio page, position-display, and canonical-position-insight no longer reference `hasFullMarketMetadata`. Regression tests assert positions expose `hasCompleteDisplayMetadata` and do not expose `hasFullMarketMetadata`.

---

| File | Type | Classification |
|------|------|----------------|
| **lib/portfolio/canonical-position-view.ts** | Lines 118, 141, 268: JSDoc + interface + `hasFullMarketMetadata: hasCompleteDisplayMetadata` | **Type/implementation** — defines and sets the alias. |
| **lib/portfolio/position-display.ts** | Lines 153, 156, 185: comment, optional property, `hasFull = quality.hasCompleteDisplayMetadata ?? quality.hasFullMarketMetadata` | **API/display** — input shape and fallback for “has full” display. |
| **lib/portfolio/canonical-position-insight.ts** | Lines 17, 20: JSDoc + optional input `hasFullMarketMetadata` | **Type** — insight input. |
| **app/api/portfolio/positions/route.ts** | Lines 31, 434: comment + `hasFullMarketMetadata: hasCompleteDisplayMetadata` in legacy response | **API contract** — positions API (legacy path) returns the field. |
| **app/(dashboard)/portfolio/page.tsx** | Lines 71, 579, 580, 772, 777: interface + `(quality.hasCompleteDisplayMetadata ?? quality.hasFullMarketMetadata)` in Resolution and warnings UI | **UI/client** — portfolio page uses the alias for display logic. |
| **docs/PORTFOLIO_POSITION_QUALITY.md** | Multiple: table, examples, UI note | **Docs** — semantics and deprecation. |
| **docs/PORTFOLIO_LIVE_TRUTH_RESPONSE_CONTRACT.md** | Compatibility table | **Docs** — shim documented. |
| **lib/portfolio/__tests__/portfolio-api-regression-tests.ts** | Lines 130, 202, 218: assert `view.quality.hasFullMarketMetadata` for unresolved/full/incomplete | **Tests** — validate alias behavior. |

### 2.2 What blocks removal

- **app/(dashboard)/portfolio/page.tsx** uses `quality.hasCompleteDisplayMetadata ?? quality.hasFullMarketMetadata` in four places. Until the page uses only `hasCompleteDisplayMetadata`, removing the alias would require the API to keep sending it or the page to be updated first.
- **API contract:** Legacy positions response explicitly includes `hasFullMarketMetadata`. Any unknown external consumer might depend on it.

### 2.3 Safe / migrate next / remove when

- **Safe now:** No change; alias is intentional.
- **Migrate next:**  
  1. **app/(dashboard)/portfolio/page.tsx** — replace all `(quality.hasCompleteDisplayMetadata ?? quality.hasFullMarketMetadata)` with `quality.hasCompleteDisplayMetadata` and ensure the positions API (and any other source) sends `hasCompleteDisplayMetadata`.  
  2. **lib/portfolio/position-display.ts** — use only `hasCompleteDisplayMetadata` for `hasFull` (remove `?? quality.hasFullMarketMetadata`).
- **Remove only after:**  
  1. All in-repo UI and display logic use only `hasCompleteDisplayMetadata`.  
  2. Confirm no external clients rely on `hasFullMarketMetadata` (or add a short deprecation period).  
  3. Remove the field from: `CanonicalPositionQuality`, positions route legacy payload, `position-display` and insight input types, and tests; then update docs.

### 2.4 Recommended order for this shim

1. **Phase 1:** Migrate portfolio page and position-display to use only `hasCompleteDisplayMetadata`.  
2. **Phase 2:** Stop returning `hasFullMarketMetadata` from the positions route (or mark deprecated in API docs and wait one release).  
3. **Phase 3:** Remove the property from types, implementation, and tests; clean up docs.

---

## 3. Shim: Diagnostics alias `unresolved` — **REMOVED**

**Previous role:** In intelligence and positions API responses, `diagnostics.unresolved` had the same value as `diagnostics.unresolvedPositions`. It was a legacy alias.

**Status:** Removed. Canonical field is `diagnostics.unresolvedPositions` only. Intelligence and positions routes no longer set or expose `diagnostics.unresolved`.

### 3.1 Left unchanged (different semantics)

| File | Type | Classification |
|------|------|----------------|
| **lib/portfolio/intelligence.ts** | Lines 142–143, 403, 689: interface `unresolved?: number`; loader return `unresolved: diagnostics.unresolved`; final diagnostics `unresolved: unresolvedCount` | **API/implementation** — sets diagnostics.unresolved in intelligence. |
| **app/api/portfolio/positions/route.ts** | Lines 37, 378, 510: comment “total/resolved/unresolved … backward compatibility”; canonical and legacy responses `unresolved: canonicalUnresolved` / `unresolved: legacyUnresolved` | **API contract** — positions response diagnostics. |
| **app/api/portfolio/intelligence/route.ts** | Line 25: `unresolved: d.unresolvedPositions` in console.info only (top-level response does not expose diagnostics.unresolved directly; it’s inside `intelligence.diagnostics`) | **Logging** — uses unresolvedPositions for log. |
| **docs/PORTFOLIO_LIVE_TRUTH_RESPONSE_CONTRACT.md** | Compatibility table | **Docs** — shim documented. |
| **docs/PORTFOLIO_UNRESOLVED_SEMANTICS.md** | Multiple: diagnostics.unresolved same as unresolvedPositions | **Docs** — semantics. |
| **lib/portfolio/enrich-positions.ts** | Line 168: `diagnostics.unresolved++` | **Different meaning** — enrichment diagnostics “unresolved” count (positions that didn’t match). Not the same shim; do not remove. |
| **lib/polymarket/portfolio.ts** | Line 423: `diagnostics.unresolved++` | **Different context** — portfolio/reconcile diagnostics. Not response diagnostics shim. |

**Consumers of response diagnostics:** No in-repo references to `intelligence.diagnostics.unresolved` or positions response `diagnostics.unresolved`. Bot and recommendations use `summary.unresolvedPositions`. So the **diagnostics.unresolved** field is only in the JSON shape of GET /api/portfolio/intelligence and GET /api/portfolio/positions.

### 3.2 What blocks removal

- **Unknown external clients** might read `diagnostics.unresolved`. No in-repo consumer found.
- **Removal** would only change the JSON: omit `unresolved` from diagnostics. Clients that use `unresolvedPositions` are unaffected.

### 3.3 Safe / migrate next / remove when

- **Safe now:** No change; alias is intentional.
- **Migrate next:** Optional: document in API/changelog that `diagnostics.unresolved` is deprecated and will be removed, and that clients should use `diagnostics.unresolvedPositions`.
- **Remove only after:** Confirm no external clients use `diagnostics.unresolved` (or after a deprecation period). Then remove from: intelligence diagnostics object, positions route diagnostics (both canonical and legacy), and interface `PortfolioIntelligenceDiagnostics.unresolved`; update docs.

### 3.4 Recommended order for this shim

1. **Phase 1:** (Optional) Add API docs or changelog: “Prefer `diagnostics.unresolvedPositions`; `diagnostics.unresolved` deprecated and will be removed on YYYY-MM-DD.”  
2. **Phase 2:** Stop setting `unresolved` in intelligence and positions diagnostics; remove from types and docs. Easiest shim to remove once external usage is confirmed or deprecated.

---

## 4. Summary Table

| Shim | Can remove now? | Blocks removal | Recommended order |
|------|------------------|----------------|--------------------|
| **DB column `topConcentrationPct`** | **Done.** | — | Migrated to `topThemeConcentrationPct` / `topMarketConcentrationPct`. |
| **`hasFullMarketMetadata`** | **Done.** | — | Removed; canonical field is `hasCompleteDisplayMetadata`. |
| **Diagnostics `unresolved`** | **Done.** | — | Removed; canonical field is `unresolvedPositions`. |

---

## 5. Recommended overall migration order

1. **Done:** **diagnostics `unresolved`** — removed; canonical field is `unresolvedPositions`.  
2. **Done:** **`hasFullMarketMetadata`** — removed; canonical field is `hasCompleteDisplayMetadata`.  
3. **Done:** **DB column `topConcentrationPct`** — migrated to explicit `topThemeConcentrationPct` / `topMarketConcentrationPct` (see concentration naming migration report).

---

## 6. Files to touch per shim (for implementation)

**`topConcentrationPct`:**  
Completed: Prisma schema and migration, analytics, ML dataset/score-live/features, decision recompute, recommendations-recompute, analytics data route; regression tests assert no legacy field name in active code paths.

**`hasFullMarketMetadata`:** Removed. No further files to touch.

**`unresolved` (diagnostics):** Removed. No further files to touch.
