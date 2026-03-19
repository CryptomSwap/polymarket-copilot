# User WebSocket Auth Audit – MetaMask → CLOB → User WS

**Date:** 2025-03-11  
**Symptom:** User WebSocket fails with "Received network error or non-101 status code"; market WS connects; `PolymarketApiCredential` row exists with apiKey, encryptedSecret, encryptedPassphrase, funderAddress, signatureType.

---

## Root cause

The user WebSocket implementation did not match Polymarket’s current API:

1. **Wrong endpoint**  
   Code used `wss://clob.polymarket.com/ws`.  
   Correct user channel: `wss://ws-subscriptions-clob.polymarket.com/ws/user` (same host as market channel, `/ws/user` path).

2. **Wrong auth method**  
   Code sent `api_key` and `passphrase` as **query parameters** on the connection URL and did **not** send `secret`.  
   Per [Polymarket docs](https://docs.polymarket.com/developers/CLOB/websocket/wss-auth), the user channel expects:
   - **No** auth in the URL.
   - A **subscription message** immediately after connect with:
     - `auth: { apiKey, secret, passphrase }` (all three required)
     - `markets: []` (condition IDs; empty for all)
     - `type: "user"`

3. **Heartbeat**  
   Docs require PING every **10s** for the user channel; code used 30s. Aligned to 10s.

So the failure was **code/contract mismatch**, not invalid or stale credentials. Credentials created via init-credentials (L1 derive/create) are valid for the REST API and, with the corrected WS flow, for the user WS.

---

## What was not wrong

- **MetaMask / wallet auth:** EIP-712 `ClobAuth` in `lib/wallet/polymarket-l1-sign.ts` matches Polymarket; connection save and init-credentials flow are correct.
- **Credential creation:** `createOrDeriveApiKeyWithL1Headers` and init-credentials route correctly call derive then create, store encrypted secret/passphrase, and validate with CLOB.
- **Storage/decryption:** Prisma model and `getStoredCredentials()` (with decrypt) are correct; credential is selected by `updatedAt desc` and matches the single connection.
- **Funder/account matching:** `getFunderForRecompute()` uses the same credential’s `funderAddress`; worker and credential funder are aligned.

---

## Files changed

| File | Change |
|------|--------|
| `lib/polymarket/ws-user.ts` | Use `wss://ws-subscriptions-clob.polymarket.com/ws/user`; connect with no query params; on open send one JSON message `{ auth: { apiKey, secret, passphrase }, markets: [], type: "user" }`; heartbeat 10s and send `PING`; handle `PONG` in onmessage; add diagnostic logging (funderAddress, credentialId, authPresent, close code/reason). |
| `lib/polymarket/auth.ts` | `getStoredCredentials()` now returns `credentialId` (for logging only). |

---

## Logging added

- **On connect start:** `url`, `funderAddress`, `credentialId`, `authPresent: { apiKey, secret, passphrase }` (booleans only).
- **On constructor failure:** `error`, `funderAddress`, `credentialId`.
- **On auth subscription send failure:** `error`, `funderAddress`, `credentialId`.
- **On open success:** `funderAddress`, `credentialId`.
- **On error:** `message`, `funderAddress`, `credentialId`, short code hint for non-101.
- **On close:** `code`, `reason`, `wasClean`, `funderAddress`, `credentialId`; if code not 1000/1001, extra warn with same meta.

No secret, passphrase, or apiKey values are logged.

---

## Do you need to recreate credentials?

**No.** Existing `PolymarketApiCredential` rows are fine. The bug was only in how the user WS connected and authenticated. After deploying the code changes, restart the worker so it uses the new URL and subscription-based auth.

---

## Local steps after pulling

1. **Restart the worker** (so it loads the new ws-user logic):
   ```bash
   npm run worker
   ```
   Or restart whatever process runs the stream runtime.

2. **Watch logs** for user WS:
   - `[ws-user] Connecting user WS` with `url`, `funderAddress`, `credentialId`, `authPresent`.
   - `[ws-user] User WS connected and auth subscription sent` on success.
   - On failure: `User WS closed` / `User WS error` with `code`, `reason`, `funderAddress`, `credentialId`.

3. **Optional:** Re-run init-credentials from Settings → Polymarket if you want to refresh API keys; not required for the user WS to work.

4. **Sanity check:** Open dashboard/ops (or wherever WS status is shown) and confirm user-feed shows connected after worker start.
