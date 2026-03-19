# Credential init + worker verification steps

## What was done

1. **Migration applied** – `npx prisma migrate deploy` so the DB has `validationApiKeysOk`, `validationTradesOk`, `validationOrdersOk` on `PolymarketApiCredential`.
2. **Worker run** – Started with `USE_STREAM_RUNTIME=true` and `RUNTIME_MODE=paper`. Startup logs were captured.

## Current run (before re-init)

- **selectionReason** is logged: `"selectionReason":"no_fully_valid_credential"` (your single credential row has null validation flags, so it is not chosen).
- **credentialsPresent: false** – Validity-aware selection correctly returned no credential (fail closed).
- **auth_preflight_ok** – Not emitted because no credential was selected (preflight only runs when `creds` is non-null).
- **Rebuild** – Completed without 401; orders were not fetched because no credential was used.

## How to get `selectionReason: "fully_valid_newest"` and `auth_preflight_ok`

Re-run credential init so the stored row gets full authoritative validation and the three booleans are set. Then start the worker again.

### 1. Start the app (if not already)

```bash
npm run dev
```

### 2. Clear existing credentials

With the app running on port 3000:

**PowerShell:**

```powershell
Invoke-WebRequest -Uri "http://localhost:3000/api/polymarket/clear-credentials" -Method POST -UseBasicParsing
```

**Or** use Settings → Polymarket and clear/delete API credentials there.

### 3. Re-init credentials

In the app: **Settings → Polymarket** → connect wallet (EOA + funder) → **Initialize API credentials**. Sign the L1 message with your wallet. The init flow will:

- Call Polymarket to create/derive the API key
- Run authoritative validation (GET /auth/api-keys, GET /data/trades, GET /orders; legacy GET /data/orders is diagnostic-only)
- Only store the credential if all three pass, and set `validationApiKeysOk`, `validationTradesOk`, `validationOrdersOk` to `true`

### 4. Start the worker

```powershell
cd c:\Users\User\Polymarket\polymarket-copilot
$env:USE_STREAM_RUNTIME="true"
$env:RUNTIME_MODE="paper"
npm run worker
```

### 5. Check startup logs

You should see:

- **selectionReason: "fully_valid_newest"** in `startup_credentials_loaded`
- **auth_preflight_ok** (with `funderAddress` and `credentialId`)
- **startup_rebuild_exchange_orders_success** (no 401; orders fetched)

Example:

```
[runtime] startup_credentials_loaded {"funderAddress":"0x...","credentialsPresent":true,"credentialId":"...","selectionReason":"strong_auth_valid_newest","validationSummary":{"apiKeysOk":true,"tradesOk":true,"ordersOk":true},...}
[runtime] auth_preflight_ok {"funderAddress":"0x...","credentialId":"..."}
[runtime] startup_rebuild_fetch_exchange_orders_begin {...}
[runtime] startup_rebuild_exchange_orders_success {"orderCount":...,"funderAddress":"0x..."}
```

If preflight fails (e.g. CLOB rejects the key), you will see `auth_preflight_failed` and the worker will throw; no orders will be fetched and no 401 will occur later in the rebuild.
