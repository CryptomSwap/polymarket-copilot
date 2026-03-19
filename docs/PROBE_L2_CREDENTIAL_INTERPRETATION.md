# L2 Credential Probe – Interpreting Results

Run the probe from repo root:

```bash
npx ts-node --project tsconfig.tests.json -r tsconfig-paths/register scripts/probe-polymarket-l2-credential.ts
```

It uses the **same** stored credential and **same** signing logic as the worker and init: `getStoredCredentials()` → `clobGetWithL2Raw()` with path-only signing for `/data/orders` and `/data/trades`.

## Endpoints tested

| Probe | Endpoint | Signed path | Purpose |
|-------|----------|-------------|----------|
| A | GET /auth/api-keys | `/auth/api-keys` | Key validity (often more permissive) |
| B | GET /data/orders | `/data/orders` (path only; `next_cursor=MA==` in URL only) | Open orders – **what the worker needs** |
| C | GET /data/trades | `/data/trades` (path only) | Fills/trades |

## How to interpret results

### 1. A=200, B=200, C=200  
**All pass.** Credential and signing are correct. Worker should succeed. If the worker still 401s, the worker is likely using different creds (e.g. different credential row or env).

---

### 2. A=200, B=401, C=200 (or A=200, B=401, C=401)  
**Validation false positive.**  
- Init/validation only requires **api-keys + trades** (`strongAuthOk = apiKeysOk && tradesOk`).  
- So init can succeed and store credentials even when **GET /data/orders** returns 401.  
- Worker then fails on startup when it calls GET /data/orders.

**Conclusion:** Likely **endpoint-specific rejection** or **signing mismatch for /data/orders**:
- CLOB may treat /data/orders differently (stricter key or different signing).
- Our path-only signing for `/data/orders` may not match what the CLOB expects (e.g. they expect query in signature, or different path).

**Next steps:**
- Require **dataOrdersOk** in validation so init fails if B fails (see code fix below).
- Compare with Polymarket docs/SDK: exact path to sign for GET /data/orders (path-only vs path+query).
- If possible, test the same key with Polymarket’s own client/SDK to see if /data/orders works there.

---

### 3. A=401, B=401, C=401  
**Credential rejected everywhere.**  
- **Credential creation bug:** key/secret/passphrase or polyAddress wrong at create time.  
- **Polymarket-side:** key revoked, wrong account, or key never valid for CLOB.  
- **Signing bug:** same signing is used for A, B, C – if all fail, either key is bad or the shared signing (timestamp, method, requestPath, HMAC) is wrong.

**Next steps:**
- Re-create credentials via Settings → Polymarket (init-credentials).
- Confirm POLY_ADDRESS is the EOA that derived the API key (polyAddress stored and sent in header).
- Check Polymarket account: key active, correct environment (prod/test).

---

### 4. A=200, B=401, C=401  
**Only api-keys accepts the key.**  
- Suggests **api-keys** is more permissive; **trades** and **orders** require something we’re not sending (e.g. correct POLY_ADDRESS, or different signing for those paths).
- **POLY_ADDRESS mismatch** is a strong candidate: if we send a different address than the one that derived the key, some endpoints may still 200 while others 401.

**Next steps:**
- Ensure `polyAddress` in DB and in L2 headers is exactly the EOA used when creating the key in Polymarket UI.
- Confirm init stores and uses `polyAddress` (not only funder) for POLY_ADDRESS header.

---

### 5. B and C show different status (e.g. B=401, C=200)  
**Path-specific behavior.**  
- Indicates **signing or endpoint rules** differ between /data/orders and /data/trades (e.g. one path-only, one with query).
- Check `PATH_ONLY_SIGNING_GET_PATHS` and that we sign exactly what the CLOB expects for each path (docs/SDK).

---

## Summary table

| A (api-keys) | B (data/orders) | C (trades) | Interpretation |
|--------------|-----------------|------------|-----------------|
| 200 | 200 | 200 | All good. |
| 200 | 401 | 200 | False positive; require dataOrdersOk in validation; check /data/orders signing. |
| 200 | 401 | 401 | POLY_ADDRESS or per-endpoint key permission; fix address / key scope. |
| 401 | 401 | 401 | Bad key or global signing bug; re-create key, check signing. |
| 200 | 200 | 401 | Trades path/signing or key scope; check /data/trades. |

---

## Code change: require GET /data/orders for validation

To prevent storing credentials that fail on the worker’s first call, require **dataOrdersOk** for success:

In `lib/polymarket/l2-readonly.ts`, change:

```ts
const strongAuthOk = apiKeysOk && tradesOk;
```

to:

```ts
const strongAuthOk = apiKeysOk && tradesOk && dataOrdersOk;
```

Then:
- **Init** will not store credentials if GET /data/orders returns 401.
- **Worker preflight** will already fail when `strongAuthOk` is false (it throws before calling fetchOpenOrdersL2).
- No more “validation passes but worker 401 on GET /data/orders” with the same credential.
