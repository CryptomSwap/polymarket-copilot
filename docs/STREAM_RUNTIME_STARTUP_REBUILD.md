# Stream Runtime Startup Rebuild

## Goal

Make the runtime **reconstructable after restart** so that automation is only trusted once in-memory state has been rebuilt from exchange and ledger truth. Explicit phases and gating ensure health endpoints show not-ready truthfully and no automated order admission occurs during rebuild.

## Runtime Phases

| Phase         | Meaning |
|---------------|--------|
| **stopped**   | Runtime not started or has been stopped. |
| **starting**  | Components (event bus, stores, risk, order manager, bot) are being created. |
| **rebuilding**| Fetching exchange open orders and durable fills; rebuilding order and position stores; recomputing exposure. |
| **reconciling**| Rebuild complete; brief transition before ready (optional). |
| **ready**     | Rebuild complete; automation allowed; WS and bot running. |
| **degraded**  | Rebuild failed or other degraded conditions; automation may be blocked. |

## Startup Rebuild Sequence (in `StreamRuntime.start()`)

1. **Resolve funder** (from options or `getFunderForRecompute()`).
2. Create all components (event bus, market state, position store, order store, risk, kill switch, order manager, bot, etc.).
3. Set **status = "rebuilding"**.
4. **Fetch exchange open orders** via `getStoredCredentials()` + `fetchOpenOrdersL2()`.
5. **Fetch durable fills** via `getFillsForRebuild(funder)` (all ledger entries for funder, ordered by `filledAt`).
6. **Rebuild order store:** `rebuildOrderStoreFromTruth(orderStore, exchangeOrders, funder)` — clears store and repopulates with one working (or partially filled) order per exchange order.
7. **Rebuild position store:** `rebuildPositionStoreFromTruth(positionStore, positionUpdater, ledgerFills)` — clears store and applies each fill in order.
8. **Recompute exposure:** `recomputeRiskExposure(riskEngine, positionStore, orderStore)`.
9. On **failure:** set `status = "degraded"`, add reason `startup_rebuild_failed`, log and **return** (fail-closed; no WS or bot started).
10. On **success:** set `status = "reconciling"` then `status = "ready"`, set `startedAt`, wire intent/fill handlers, start intervals, bot, and WebSockets.

No DB canonical projections are mixed with execution-plane state; rebuild uses only exchange open orders and the durable fill ledger.

## Helpers (`lib/runtime/startup/stream-runtime-rebuild.ts`)

- **`rebuildOrderStoreFromTruth(orderStore, exchangeOrders, funderAddress)`**  
  Clears the order lifecycle store and repopulates from the list of exchange open orders. Each exchange order becomes a local order with `clientOrderId = "rebuild:" + exchangeId`, status working (or partially_filled if `size_matched` > 0).

- **`rebuildPositionStoreFromTruth(positionStore, positionUpdater, ledgerFills)`**  
  Clears the position store and applies each ledger fill in order via the position updater (so positions match the durable fill ledger).

- **`recomputeRiskExposure(riskEngine, positionStore, orderStore)`**  
  Calls `updateRiskExposureFromStores()` so risk state reflects current positions and orders.

- **`finalizeRuntimeReadiness()`**  
  Semantic marker; the caller sets `status = "ready"` and starts automation.

- **`parseExchangeOrderForRebuild(raw)`**  
  Parses a raw CLOB order into `ExchangeOpenOrderForRebuild` (returns null if invalid).

## Automation Gating

- **`isAutomationAllowed()`** returns `true` only when `status === "ready"`.
- The **order.intent.created** handler checks `isAutomationAllowed()` first; if false, it records intent blocked by mode `"rebuilding"` and returns (no `reconcileIntents`).
- During **starting / rebuilding / reconciling**, no automated new order admission occurs; health shows not-ready.

## Health

- **operationalReadiness** is `true` only when `status === "ready"` **and** streams are open and data flow healthy:  
  `operationalReadiness = this.status === "ready" && socketOpen && dataFlowHealthy`.
- **status** and **lifecycleStatus** expose the current phase (`starting`, `rebuilding`, `reconciling`, `ready`, `degraded`, `stopped`).
- On rebuild failure, **degradedReasons** includes `startup_rebuild_failed`.

## Fill Ledger

- **`getFillsForRebuild(funderAddress)`** in `lib/live/fill-ledger.ts` returns all fill ledger entries for the funder ordered by `filledAt`, used to rebuild the position store from scratch.

## Tests

- **`lib/runtime/__tests__/stream-runtime-rebuild-tests.ts`**  
  Covers: rebuild order store from exchange orders (including partially filled), rebuild position store from ledger fills (existing and unapplied), recompute risk exposure, parse exchange order, operationalReadiness false when rebuilding and true when ready, rebuild failure → degraded with reason.

Run: `npm run test:stream-runtime-rebuild`

## Files Touched

- **New:** `lib/runtime/startup/stream-runtime-rebuild.ts`, `lib/runtime/__tests__/stream-runtime-rebuild-tests.ts`, `docs/STREAM_RUNTIME_STARTUP_REBUILD.md`
- **Updated:** `lib/runtime/runtime-health.ts` (phases `rebuilding`, `reconciling`), `lib/live/fill-ledger.ts` (`getFillsForRebuild`), `worker/stream-runtime.ts` (rebuild sequence, `isAutomationAllowed`, intent gate, operationalReadiness, degraded reason on rebuild failure), `package.json` (test script)
