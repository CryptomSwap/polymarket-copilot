# Live-Truth Fallback Behavior

**See:** `docs/LIVE_TRUTH_ARCHITECTURE.md` for the full truth model and response contract.

This document summarizes when we use **official** vs **derived** data and how responses are marked.

---

## When official positions are used

- **Request:** `GET /api/portfolio/positions`, `GET /api/portfolio/overview`, or `GET /api/portfolio/intelligence`.
- **Flow:** We call Polymarket Data API `GET /positions?user={address}` (via `getLiveOfficialPositions`, which may serve from a short-lived cache).
- **If the fetch succeeds (HTTP 2xx, no error):**
  - Open set = list of positions returned by the API (possibly empty).
  - `sourceOfTruth: "official"`.
  - `asOf` = time of the fetch (or cache timestamp).
  - `freshnessMs` = 0 when not from cache; age in ms when from cache.
  - Rows have `quantitySource: "official"`; basis/PnL can be official or derived per row (`basisSource`, `pnlSource`).
- **If the fetch fails (network error, 4xx/5xx, or exception):**
  - We **fall back** to derived positions only (from local DB).
  - `sourceOfTruth: "derived"`.
  - `asOf` = current time (derived read time).
  - `freshnessMs` = null (unknown — do not treat as fresh). See [PORTFOLIO_FRESHNESS_CONTRACT.md](./PORTFOLIO_FRESHNESS_CONTRACT.md).
  - `officialFetchFailed: true` in diagnostics; `officialFetchError` / `officialFetchStatus` when available.
  - All rows have `quantitySource: "derived"`, `rowSource: "derived_only"`.

---

## When derived positions are used

1. **Fallback (above):** Official fetch failed → we use derived only and mark the response accordingly.
2. **Explicit empty official:** Official fetch succeeded but returned an empty list → we still set `sourceOfTruth: "official"` and return an empty open set (we do **not** show derived-only positions in that case).

---

## No silent mixing

- We **never** show a row where quantity is from official but we display it without `quantitySource` / `rowSource`.
- When basis or PnL is from derived (e.g. official has no basis), we set `basisSource` / `pnlSource` to `"derived"` or `"unavailable"` so the UI can show "cost basis from our records" or "unavailable".

---

## Caching

- `getLiveOfficialPositions` uses an in-memory cache with configurable TTL (default 60s).
- When a response is served from cache, `freshnessMs` is set to the age of the cached data; `asOf` is the cache timestamp.
- Cache is keyed by funder address. Clearing or TTL is controlled via `clearLivePortfolioCache()` / `setLivePortfolioCacheTtlMs()` (e.g. in tests).

---

## Open orders

- **Overview** `openOrdersCount` is from local `UserOrder` (synced). This is the **fallback** source until a live open-orders read path is added for the dashboard.
- When a live open-orders API is used (e.g. for runtime), that is the primary for execution; dashboard may later expose `openOrdersSource: "official"` when we add a live orders fetch for the UI.
