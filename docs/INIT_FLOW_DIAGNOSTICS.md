# Init-flow diagnostics and failure points

## What was added

- **Structured diagnostics** on init (success and failure): `connectedWalletEoa`, `funderAddress`, `storedPolyAddress`, `signatureType`, `createOrDeriveSucceeded`, validation status and status codes, **requestPath** for api-keys/trades/orders, and truncated body snippets. Returned in the API response and (on validation failure) logged server-side with `[init-credentials] Validation failed (no secrets)`.
- **Identity model** documented in the init-credentials route: single identity for create, validate, and store; we validate with the exact same `l2Creds` we then persist.
- **Authoritative validation** now returns `apiKeysRequestPath`, `tradesRequestPath`, `ordersRequestPath` in diagnostics so init (and the debug script) can log them.
- **Debug script** `scripts/debug-polymarket-init-flow.ts`: loads connection and stored credential, runs authoritative validation, prints identity and full validation diagnostics (request paths, status codes, body snippets). No secrets. Use after a failed init to see what the CLOB returned.

## Identity consistency (verified)

- **Create/derive**: We send `POLY_ADDRESS: eoaNorm` (from request `polygonAddress`) to Polymarket. The key is bound to that EOA.
- **Validate**: We call `validateCredentialsWithClobAuthoritative(l2Creds)` with `polyAddress: eoaNorm`, `funderAddress: funderNorm`, and the same `apiKey`/`secret`/`passphrase` returned by create/derive.
- **Store**: We persist the same `eoaNorm` as `polyAddress`, `funderNorm` as `funderAddress`, and the same credentials. No second credential or address is used.

So we do **not** validate one credential and store another, or validate with one address and store another.

## Most likely remaining failure point in fresh init

If a **brand-new** init (create/derive succeeds, then authoritative validation runs) still cannot produce a fully valid credential row, the most likely cause is **Polymarket/CLOB rejecting the key for the given identity** on one or more of the three endpoints:

1. **Key bound to a different address** – The client might be signing the L1 message with an EOA that does not match the `polygonAddress` (or the saved connection EOA). We send `POLY_ADDRESS = polygonAddress` to derive; if the user’s wallet is a different EOA, Polymarket could still return a key, but that key might be tied to the signer’s address. We use `polygonAddress` from the request as `POLY_ADDRESS` and as stored `polyAddress`; if the frontend sends a different address than the signer, we’d have a mismatch. **Check**: Ensure the client sends the same EOA that actually signs the L1 message as `polygonAddress`.

2. **Funder/polyAddress mismatch on CLOB** – Some CLOB endpoints might expect a specific relationship between POLY_ADDRESS and funder (e.g. proxy). If the account is not set up that way, `/data/orders` or `/data/trades` could 401 even when `/auth/api-keys` passes. **Check**: Run the debug script after a failed init and compare `ordersRequestPath` and response body with CLOB docs; confirm with Polymarket that the account/key is allowed for orders and trades.

3. **Timing or propagation** – Rarely, a newly created key might not be immediately valid on all endpoints. **Check**: Retry init after a short delay; if it still fails, treat as (1) or (2).

Use the **502 response diagnostics** (or server log `[init-credentials] Validation failed`) and **scripts/debug-polymarket-init-flow.ts** to see which endpoint failed and the exact request paths and responses.
