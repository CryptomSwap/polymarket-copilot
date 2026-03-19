# Polymarket open-orders endpoint investigation

## Implementation (current)

We align with the official SDK:

- **Open-orders read:** `GET /data/orders` with query `next_cursor=MA==` (first page). **Signed path is path-only:** `requestPath = "/data/orders"` (query params are sent in the URL but **not** included in the HMAC signature). This matches `@polymarket/clob-client` behavior.
- **GET /orders** is **not** used for reading open orders; the SDK uses it only for **POST** (create) and **DELETE** (cancel). Using GET on `/orders` returns 405.

Runtime and validation both use `GET /data/orders` with path-only signing (see `PATH_ONLY_SIGNING_GET_PATHS` and `clobGetWithL2Raw` in `lib/polymarket/l2-readonly.ts`).

**Trades (fills) pagination:** `GET /data/trades`. The SDK (`getTrades` / `getTradesPaginated`) signs **requestPath = "/data/trades"** only for both first page and paginated requests; query params (e.g. `next_cursor`) are sent in the URL but **not** in the signature. We include `GET_TRADES` in `PATH_ONLY_SIGNING_GET_PATHS` so first-page and paginated trades use path-only signing and no longer get 401 on the second page. See `scripts/compare-sdk-vs-raw-trades.ts` for a diagnostic script.

**Error classification:** 405 (Method Not Allowed) is never reported as "invalid or expired credentials". User-facing and log classification: auth (401/403), method_mismatch (405), server (5xx). The dashboard "Last error" is the last user-sync job's `errorMessage`; it is replaced on the next sync run (success or failure).

---

## Historical raw results (pre–path-only fix)

Same stored L2 credential, same signing logic:

| Operation | Path / requestPath | Method | Status | Note |
|-----------|-------------------|--------|--------|------|
| GET /auth/api-keys | /auth/api-keys | GET | 200 | OK |
| GET /data/trades | /data/trades | GET | 200 | OK |
| GET /orders | /orders | GET | **405** | Method Not Allowed |
| GET /orders?next_cursor=MA== | /orders?next_cursor=MA== | GET | **405** | Method Not Allowed |
| GET /data/orders?next_cursor=MA== | /data/orders?next_cursor=MA== | GET | **401** | Unauthorized / Invalid api key |

Selected credential: `selectionReason = "strong_auth_valid_orders_warning"`, `validationSummary = { apiKeysOk: true, tradesOk: true, ordersOk: false }`.

---

## Official SDK behavior (@polymarket/clob-client)

### Endpoints (from `node_modules/@polymarket/clob-client/dist/endpoints.js`)

- **Open orders (read):** `GET_OPEN_ORDERS = "/data/orders"` — used for **getting** user open orders.
- **Create orders:** `POST_ORDERS = "/orders"` — **POST** only.
- **Cancel orders:** `CANCEL_ORDERS = "/orders"` — **DELETE** only.

So in the SDK:

- **GET** is used only for **/data/orders** (with `next_cursor` etc.), not for `/orders`.
- **/orders** is used for **POST** (create) and **DELETE** (cancel), not for GET.

### getOpenOrders (from `client.js`)

- **Method:** `getOpenOrders(params?, only_first_page?, next_cursor?)`
- **Endpoint:** `GET_OPEN_ORDERS` → **/data/orders**
- **HTTP method:** GET
- **Params:** `next_cursor` (default `INITIAL_CURSOR` = `"MA=="`), plus optional `params`
- **Auth:** L2 via `createL2Headers(this.signer, this.creds, l2HeaderArgs, ...)`
- **Signed path:** `l2HeaderArgs.requestPath = endpoint` → **`"/data/orders"`** (path only; **no query string** in the signed value)
- **Actual request:** `this.get(this.host + endpoint, { headers, params: _params })` → URL is `https://clob.polymarket.com/data/orders?next_cursor=MA==` (axios adds query from `params`)

So the SDK:

1. Uses **GET /data/orders** with query `next_cursor=MA==` for the first page.
2. Signs with **requestPath = "/data/orders"** (no query in the signature).

---

## Comparison: our raw vs SDK

| Item | Our raw (l2-readonly) | Official SDK |
|------|----------------------|--------------|
| **Open-orders path** | We tried GET /orders and GET /data/orders | **GET /data/orders** only |
| **Signed path for /data/orders** | Full path + query: `/data/orders?next_cursor=MA==` | **Path only:** `/data/orders` |
| **Method** | GET | GET |
| **Params** | next_cursor=MA== (we use it) | next_cursor=MA== (same) |
| **Auth** | POLY_ADDRESS, POLY_SIGNATURE, POLY_TIMESTAMP, POLY_API_KEY, POLY_PASSPHRASE | Same L2 headers (from same creds + signer) |

Conclusion from SDK inspection:

- We are **wrong** to use **GET /orders** for **reading** open orders. The SDK does not use GET on `/orders` for that; it uses **GET /data/orders**. So **GET /orders → 405** is expected (that route is for POST/DELETE).
- For **GET /data/orders**, the only behavioral difference we know of is **signing**: we sign **path + query**, the SDK signs **path only**. If the CLOB validates the signature against the full URL path+query, the SDK would also fail; if it validates against path only, our 401 could be due to this mismatch.

---

## Likely conclusion

1. **Wrong endpoint for “canonical” read:** We had switched to **GET /orders** as the “canonical” open-orders read. The SDK does **not** use GET on `/orders` for that; it uses **GET /data/orders**. So:
   - **GET /orders** is the wrong operation for “get user open orders” and 405 is expected.
   - The **correct** operation for “get user open orders” in the SDK and likely on the server is **GET /data/orders** (with cursor).

2. **Request shape / signing for /data/orders:** The SDK signs **only the path** (`/data/orders`) for `getOpenOrders`, while we sign **path + query** (e.g. `/data/orders?next_cursor=MA==`). Our **401** on **GET /data/orders?next_cursor=MA==** could be due to this signing difference (server expecting path-only signed string for this endpoint). It could also be account/key or policy. Not changing auth in this investigation; only documenting.

3. **Implementation change (done):**
   - We use **GET /data/orders** (with `next_cursor=MA==`) for open-orders read and validation.
   - We sign **path only** for GET /data/orders (`requestPath = "/data/orders"`); query params are sent in the URL but not in the signature, matching the SDK.

4. **Evidence toward Polymarket-side vs our-side:**
   - **Our-side:** Using GET /orders for “open orders” was incorrect; the server correctly returns 405. Using GET /data/orders is correct; the remaining 401 may be signing (path vs path+query) or environment.
   - **Polymarket-side:** If, after aligning to GET /data/orders and (if applicable) path-only signing, the same key still gets 401 while api-keys and trades return 200, that would point to account/key or endpoint-specific policy on their side.

---

## Script

- **compare-sdk-vs-raw-orders.ts** — Runs raw probes (A–C) and, when signer is available, SDK getOpenOrders (D). Logs path, method, requestPath (for raw), status/result and truncated body/error. No secrets.  
  Run: `npx tsx scripts/compare-sdk-vs-raw-orders.ts`
