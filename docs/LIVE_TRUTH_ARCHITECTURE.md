# Live-Truth Architecture: Polymarket as Primary Source for User-Facing State

**Goal:** Remove reliance on manual sync for user-facing portfolio correctness. Use live Polymarket data as primary; keep local DB as cache, audit trail, reconciliation history, and fallback.

---

## A. Truth Model

| Data | Primary source | Fallback | When fallback is used |
|------|----------------|----------|------------------------|
| **Open positions (quantity)** | Polymarket Data API `GET /positions?user={address}` | Local derived positions (UserFill aggregation) | When official fetch fails (network, 4xx/5xx) or returns empty and we still want to show something |
| **Open orders** | Live Polymarket CLOB open-orders (e.g. `GET /data/orders` with L2 creds) | Local UserOrder / runtime order store | When live fetch unavailable (no creds, failure) or for backward compat |
| **Market metadata** | Gamma / canonical SyncedMarket mapping | Raw conditionId/assetId when unresolved | When market not in SyncedMarket catalog |
| **Prices (mark, best bid/ask)** | CLOB public price or live WS-fed cache | Derived lastPrice / avgEntry from local | When no live price available; always labeled by priceSource |
| **Basis / realized / unrealized PnL** | Official API values when present and sane | Derived from local fills | When official has no basis or derived is used for quantity; never silently mix without provenance |

**Invariants:**
- User-facing **quantity** for open positions comes from official API when the fetch succeeds; otherwise from derived, with response-level `sourceOfTruth` and row-level `quantitySource` so the UI can show "from Polymarket" vs "from our records (fallback)".
- We **never** show official quantity mixed with stale derived quantity without explicit provenance (e.g. row has quantitySource and basisSource).
- When official fetch **fails**, we degrade to derived-only and set `sourceOfTruth: "derived"` and expose `officialFetchFailed: true` in diagnostics so the UI can warn.

---

## B. Response Contract

All portfolio positions, overview, and intelligence responses include:

### Response-level (additive)

| Field | Type | Meaning |
|-------|------|--------|
| `sourceOfTruth` | `"official"` \| `"derived"` \| `"mixed_fallback"` | Overall source of the open set: official = from Polymarket API; derived = fallback only; mixed_fallback = official fetch failed but we merged/cached partial data (reserved for future) |
| `asOf` | ISO 8601 string | Timestamp when the primary data was captured (e.g. when we called the official API or when we read derived) |
| `freshnessMs` | number \| null | `0` = fresh fetch, `> 0` = cached age (ms), `null` = unknown. Do not treat null as fresh. See [PORTFOLIO_FRESHNESS_CONTRACT.md](./PORTFOLIO_FRESHNESS_CONTRACT.md). |

### Field-level provenance (per position/row)

| Field | Meaning |
|-------|--------|
| `quantitySource` | `"official"` \| `"derived"` — where size comes from |
| `priceSource` | `"official"` \| `"derived"` \| `"cache"` — where lastPrice/curPrice comes from |
| `basisSource` | `"official"` \| `"official_only"` \| `"derived"` \| `"unavailable"` |
| `pnlSource` | `"official"` \| `"derived"` \| `"unavailable"` |
| `rowSource` | `"official+derived"` \| `"official_only"` \| `"derived_only"` — whether row is from official list, derived list, or both |

### Diagnostics (existing + additive)

- `officialFetchFailed: boolean` — when true, we fell back to derived because the official positions request failed.
- `officialFetchStatus`, `officialFetchError` — when available, for debugging.
- Existing merge diagnostics (officialPositionsUsed, derivedOnlyExcluded, etc.) unchanged.

---

## C. Runtime Behavior

1. **On request:** Fetch live positions from Polymarket Data API via `getLiveOfficialPositions` in `lib/portfolio/live-portfolio-service.ts` (with optional short-lived server-side cache, default 60s TTL, to reduce API pressure).
2. **Join/enrich:** Resolve market metadata via SyncedMarket (Gamma/canonical); attach to each row.
3. **Cache:** Short-lived in-memory cache (e.g. 30–60s TTL) keyed by funderAddress so repeated requests within the window reuse the same official result and asOf/freshnessMs are consistent.
4. **Fallback:** If official fetch fails (network error, non-2xx), use derived positions only; set `sourceOfTruth: "derived"`, `officialFetchFailed: true`, and asOf to current time (derived is always "now" from DB read).
5. **No silent mixing:** When we show official quantity, we do not combine it with stale derived quantity for display without marking row/field provenance. Basis/PnL can still be derived when official has no basis, with basisSource/pnlSource set accordingly.

---

## D. Streaming / Caching

- **Positions:** Request-time fetch of official API; optional server-side cache (TTL configurable, default 60s) so rapid refreshes don’t hammer the Data API.
- **Prices:** Prefer CLOB public price or a live WS-fed cache (future). When we only have derived lastPrice, set priceSource to "derived". Persist snapshots only for audit/debug, not as the sole display truth.
- **Open orders:** Today open-orders count comes from local UserOrder (synced). When live open-orders endpoint is used (e.g. for runtime reconciliation), that can be the primary for an orders API; overview continues to expose openOrdersSource: "local" until we add a live orders read path for the dashboard.

---

## E. Reconciliation

- **Background jobs (existing or to add):**
  - **Official positions vs local derived:** Compare official positions (by asset/size) to derived; emit diagnostics and repair suggestions (e.g. "derived out of date", "official has position we don’t").
  - **Official open orders vs runtime/local:** Already partially done in runtime reconciliation (exchange vs runtime order store). Extend or document for dashboard open-orders source.
  - **Market metadata drift:** Ensure SyncedMarket is refreshed so conditionId/assetId resolve; no change to truth model.
- **Repair actions:** Log and alert when drift is detected; do not overwrite official truth with derived. Local DB is updated by sync jobs, not by "repair" that replaces official with derived.

---

## F. API Summary

| Endpoint | Primary data | Response additions |
|----------|--------------|--------------------|
| `GET /api/portfolio/positions` | Official positions (with fallback to derived) | sourceOfTruth, asOf, freshnessMs; quantitySource, priceSource, basisSource, pnlSource, rowSource per row; officialFetchFailed when fallback |
| `GET /api/portfolio/overview` | Same open set as positions | sourceOfTruth, asOf, freshnessMs; openPortfolioSource retained; officialFetchFailed |
| `GET /api/portfolio/intelligence` | Same open set as positions | sourceOfTruth, asOf, freshnessMs in diagnostics; openPortfolioSource retained |

---

## G. Fallback Behavior (Explicit)

1. **Official positions fetch fails (network or API error):**
   - Use only derived positions for the open set.
   - Set `sourceOfTruth: "derived"`, `asOf` = now, `freshnessMs` = null (unknown; do not use 0). See freshness contract.
   - Set `officialFetchFailed: true` in diagnostics; include `officialFetchError` if available.
   - All rows have quantitySource/basisSource/pnlSource/rowSource = derived or derived_only.

2. **Official positions fetch succeeds but returns empty:**
   - Treat as "user has no open positions per Polymarket"; open set is empty.
   - Set `sourceOfTruth: "official"`, asOf/freshnessMs from fetch time. Do not show derived-only positions in the open set (they are excluded by design when official is the open set).

3. **Official positions fetch succeeds with data:**
   - Open set = official list; merge with derived for basis/enrichment where needed.
   - Set `sourceOfTruth: "official"`, asOf/freshnessMs from fetch time.
   - Rows have quantitySource "official"; basisSource/pnlSource can be official or derived or unavailable per row.

4. **Never:** Use official quantity with derived quantity in the same row without clear rowSource/quantitySource. Never show stale derived quantity as if it were official.

---

*This document is the source of truth for the live-truth portfolio and trading read paths.*
