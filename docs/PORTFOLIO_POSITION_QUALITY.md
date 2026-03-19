# Portfolio Position Quality Metadata

## Summary

Position quality metadata is built in `lib/portfolio/canonical-position-view.ts` and exposed in the positions API (canonical and legacy). Quality flags are **truthful and precise**: they distinguish "linked to catalog" from "has all display metadata" and "market has ended."

---

## Quality Semantics (Current)

| Field | Meaning |
|-------|--------|
| **isResolved** | `true` when the position is linked to a canonical market record (`matchedBy != null`). |
| **hasCompleteDisplayMetadata** | `true` only when all required display fields are present (see below). |
| **marketEndDatePassed** | `true` when the market's end date is in the past. Use for "Resolved" in time-to-resolution display. |
| **matchedBy** | How the position was resolved: `"marketId"` \| `"conditionId"` \| `"assetId"` \| `null`. |
| **hasPriceContext** | `true` when lastPrice or avgEntry is available. |
| **warnings** | Human-readable list (e.g. "Market not resolved to catalog", "Category missing.", "Theme missing."). |

---

## Completeness Criteria

`hasCompleteDisplayMetadata` is `true` only when **all** of the following are present and non-empty:

- **Canonical market id** – from resolved enrichment (non-empty when `matchedBy != null`).
- **Title** – non-empty (from enrichment or position row).
- **Slug** – non-empty (required for market detail link).
- **Category** – non-empty.
- **Theme** – non-empty.
- **End date** – non-null and non-empty.

If any of these are missing or empty, `hasCompleteDisplayMetadata` is `false` and specific warnings are added (e.g. "Category missing.", "Theme missing.", "End date missing.").

---

## Old vs New Semantics

| Aspect | Before | After |
|--------|--------|-------|
| **isResolved** | `endDate != null && endDate <= now` (market ended) | `matchedBy != null` (linked to canonical market). |
| **Market ended** | Implicit in old `isResolved` | Explicit **marketEndDatePassed** for time-to-resolution display. |
| **Warnings** | Generic "Market not resolved" or "Market slug missing" | Specific warnings per missing field when matched (slug, category, theme, end date). |

---

## Response Shape (Examples)

**Resolved, full metadata:**

```json
{
  "quality": {
    "isResolved": true,
    "matchedBy": "assetId",
    "hasCompleteDisplayMetadata": true,
    "marketEndDatePassed": false,
    "hasPriceContext": true,
    "warnings": []
  }
}
```

**Resolved, incomplete metadata (e.g. null category/theme):**

```json
{
  "quality": {
    "isResolved": true,
    "matchedBy": "marketId",
    "hasCompleteDisplayMetadata": false,
    "marketEndDatePassed": false,
    "hasPriceContext": true,
    "warnings": ["Category missing.", "Theme missing.", "End date missing."]
  }
}
```

**Unresolved:**

```json
{
  "quality": {
    "isResolved": false,
    "matchedBy": null,
    "hasCompleteDisplayMetadata": false,
    "marketEndDatePassed": false,
    "hasPriceContext": true,
    "warnings": ["Market not resolved to catalog; link to market detail unavailable."]
  }
}
```

---

## UI / Consumers

- **Time to resolution:** Use `quality.marketEndDatePassed` to show "Resolved" when the market has ended; otherwise show hours/days to resolution.
- **Resolution source / link to market:** Use `quality.hasCompleteDisplayMetadata` to decide whether to show resolution source and allow link to market detail.
- **Unresolved badge / catalog link:** Use `quality.isResolved` for "linked to catalog"; use `hasCompleteDisplayMetadata` for "can link to market" (requires slug and full display metadata).

---

## Unresolved semantics

For canonical **unresolved** (no synced market resolution) and count alignment, see **`docs/PORTFOLIO_UNRESOLVED_SEMANTICS.md`**. All unresolved/resolved counts use the same classifier (`getResolutionCounts`) so summary and diagnostics stay aligned.

## Files

- **Build:** `lib/portfolio/canonical-position-view.ts` – completeness criteria and quality flags.
- **Enrichment:** `lib/portfolio/enrich-positions.ts` – unchanged; still returns enrichment per position.
- **Adapter:** `lib/portfolio/position-display.ts` – maps canonical quality to `PositionView` (including `marketEndDatePassed`).
- **Insight:** `lib/portfolio/canonical-position-insight.ts` – uses `quality.isResolved` for `unresolvedCatalog`.
- **API:** `app/api/portfolio/positions/route.ts` – canonical path uses view; legacy path computes same quality shape.
- **UI:** `app/(dashboard)/portfolio/page.tsx` – uses `marketEndDatePassed` for time display, `hasCompleteDisplayMetadata` for resolution and warnings.
