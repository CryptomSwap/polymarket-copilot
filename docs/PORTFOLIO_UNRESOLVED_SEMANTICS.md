# Portfolio: Canonical Unresolved-Position Semantics

## Canonical definition

**Unresolved position** = a position with **no canonical synced market resolution**.  
That is, the position was not matched to any `SyncedMarket` by `marketId`, `conditionId`, or `assetId` during enrichment.

Equivalently:

- `quality.isResolved === false`
- `quality.matchedBy == null`
- `quality.resolutionSource === "unresolved"`

**Resolved position** = linked to a canonical market record (`matchedBy !== null`).

All summary and diagnostic counts that refer to “unresolved” or “resolved” positions **must** use this same classification so that:

- Intelligence `summary.unresolvedPositions` and `diagnostics.unresolvedPositions` agree.
- Positions route `diagnostics.unresolvedPositions` is the canonical unresolved count.
- Counts are derived from the **same source**: the canonical position view’s `quality.isResolved` (or the shared classifier), not from separate enrichment vs insight logic.

---

## Single source of truth

- **Classification:** `lib/portfolio/resolution-classifier.ts`  
  - `isPositionUnresolved(quality)`  
  - `getResolutionCounts(qualities)` → `{ unresolvedCount, resolvedCount, total }`

- **Per-position quality:** Built in `lib/portfolio/canonical-position-view.ts`:  
  - `isResolved` = `enrichment.matchedBy != null`  
  - `resolutionSource` = `matchedBy ?? "unresolved"`  
  - `unresolvedReason` = when `!isResolved`, e.g. `"No canonical synced market resolution"`

- **Counts:**  
  - Intelligence: `getResolutionCounts(views.map(v => v.quality))` → use `unresolvedCount` for both `summary.unresolvedPositions` and `diagnostics.unresolvedPositions`.  
  - Positions route (canonical and legacy): `getResolutionCounts(positions.map(p => p.quality))` → use for `resolvedPositions` / `unresolvedPositions` and `resolved` in diagnostics (canonical unresolved count is `unresolvedPositions`).

---

## Exposed fields (API / UI)

| Field | Meaning |
|-------|--------|
| **isResolved** | `true` when position is linked to a canonical synced market (`matchedBy != null`). |
| **resolutionSource** | `"marketId"` \| `"conditionId"` \| `"assetId"` \| `"unresolved"`. Use for counts and UI. |
| **unresolvedReason** | When `!isResolved`, canonical reason string (e.g. "No canonical synced market resolution"); otherwise `null`. |
| **isCatalogComplete** | Same as `hasCompleteDisplayMetadata`: all required display fields (id, title, slug, category, theme, endDate) present. |

“Unresolved” is only about **resolution to the catalog** (synced market). It is independent of:

- **Catalog completeness** – resolved positions can have incomplete metadata (e.g. null category).
- **Market end date** – whether the market has ended is `marketEndDatePassed`.

---

## Count alignment

- **Intelligence:** `summary.unresolvedPositions` and `diagnostics.unresolvedPositions` are both set from the same `getResolutionCounts(views.map(v => v.quality))` result. So they always match.
- **Positions route:** Canonical and legacy paths both use `getResolutionCounts(...)` on the returned positions’ quality objects for `resolvedPositions` / `unresolvedPositions` and `resolved` in diagnostics.
- **Enrichment diagnostics:** `enrichPositionsBatch` still returns `diagnostics.unresolved` (count of positions that did not match in the enrichment step). That count is **not** used as the authoritative unresolved count in intelligence or positions responses; the authoritative count is the one from `getResolutionCounts` on the **views/positions** actually returned. (The enrichment `unresolved` has a different meaning and is left unchanged.)

---

## Files

| File | Role |
|------|------|
| `lib/portfolio/resolution-classifier.ts` | Canonical definition and `getResolutionCounts` / `isPositionUnresolved`. |
| `lib/portfolio/canonical-position-view.ts` | Builds `quality.isResolved`, `resolutionSource`, `unresolvedReason`. |
| `lib/portfolio/intelligence.ts` | Uses `getResolutionCounts(views.map(v => v.quality))` for summary and diagnostics. |
| `app/api/portfolio/positions/route.ts` | Uses `getResolutionCounts` on canonical positions (and legacy position list) for diagnostics. |
| `lib/portfolio/canonical-position-insight.ts` | `unresolvedCatalog` = `!(quality?.isResolved)` (same semantics). |
| `lib/portfolio/enrich-positions.ts` | Produces `matchedBy` per position; `diagnostics.unresolved` = count of `matchedBy == null`. |
