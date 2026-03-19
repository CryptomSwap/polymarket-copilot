# Runtime Reconciliation (Runtime vs Exchange Truth)

## Goal

Compare runtime order lifecycle state against exchange truth (CLOB open orders and optionally fills) so we can:

- Detect missing local open orders (exchange has an order we don’t track).
- Detect local working orders absent on exchange (we think an order is open but it isn’t).
- Detect fill/lifecycle drift (e.g. exchange `size_matched` vs our `filledSize`).
- Emit diagnostics and repair recommendations without introducing unsafe live execution.

## Repair Policy (Paper-Safe)

- **No live execution.** Reconciliation never places or cancels orders on the exchange.
- **Diagnostics:** Every run records success/failure, drift, and repair recommendations.
- **Recommendations:**  
  - `mark_local_canceled`: local working/partially_filled order not on exchange → recommend (or optionally apply) in-memory status update to `canceled`.  
  - `sync_order_from_exchange`: exchange order not in runtime store → recommend syncing (not auto-applied by default).
- **Optional in-memory repairs:** When `applyRepairs: true` is passed to `runRuntimeReconciliation`, we apply only:
  - **mark_local_canceled:** For each local working order whose `exchangeOrderId` is not in the exchange open-orders set, we call `orderStore.updateStatus(clientOrderId, "canceled")`. This keeps runtime state aligned with exchange truth without touching the exchange.
- We do **not** auto-create local orders from exchange-only orders (no automatic `sync_order_from_exchange`); that would require careful mapping and is left for an explicit sync flow or manual process.

## Result Shape

`RuntimeReconciliationResult` includes:

- `missingLocalOrders`: exchange order ids we have no local open order for.
- `missingExchangeOrders` / `staleWorkingOrders`: local open orders whose exchange id is not on the exchange.
- `missingFills`: pairs where local `filledSize` ≠ exchange `size_matched`.
- `repairedOrders` / `repairedPositions`: ids we applied in-memory repair to (when `applyRepairs` was true).
- `driftDetected`: true if any of the above lists are non-empty.
- `repairRecommendations`: list of recommended actions (mark_local_canceled, sync_order_from_exchange).
- `reconcileDurationMs`, `asOf`, `success`, `error`.

## Integration

- **StreamRuntime** runs reconciliation on a fixed interval (default 60s). It uses `applyRepairs: false` so only diagnostics and recommendations are produced; no in-memory repairs unless explicitly enabled.
- **Degraded:** If runtime reconciliation fails repeatedly (e.g. ≥3 failures after at least one run), `computeDegraded` adds reason `runtime_reconciliation_repeated_failure`.
- **Health:** Health and ops routes expose `reconciliation.lastAt`, `reconciliation.status`, `reconciliation.freshness` (ok | stale | never_run), and `reconciliation.driftDetected`.

## Files

- `lib/runtime/reconciliation/runtime-reconciliation-types.ts` – result and recommendation types.
- `lib/runtime/reconciliation/runtime-reconciliation.ts` – fetch open orders via L2, compare with order store, optional repairs.
- `lib/runtime/telemetry/runtime-diagnostics.ts` – counters for runs, failures, drift, repairs.
- `lib/runtime/runtime-degraded.ts` – `runtime_reconciliation_repeated_failure` reason.
- `worker/stream-runtime.ts` – periodic reconciliation loop and health reconciliation section.
- Ops routes: dashboard, snapshot, health – expose reconciliation and diagnostics.

## Tests

- `lib/runtime/__tests__/runtime-reconciliation-tests.ts`: compare logic (local missing on exchange, exchange missing locally), degraded when failures ≥ threshold, successful reconcile does not add repeated_failure, health exposes drift and freshness, diagnostics counters.

Run: `npm run test:runtime-reconciliation`
