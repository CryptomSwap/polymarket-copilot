# Reconciliation and Ledger Alignment

## Purpose

Reconciliation compares exchange open orders with the runtime order store and can recommend or apply repairs (e.g. mark local orders as canceled when they are absent on the exchange). This document describes how reconciliation now interacts with durable order records and how the ledger stays aligned.

## How reconciliation interacts with durable order records

- **Reconciliation** (e.g. `runRuntimeReconciliation`) fetches open orders from the exchange (L2 API), compares them with the runtime **order store** (in-memory), and produces:
  - **missingLocalOrders:** exchange order ids not present locally.
  - **missingExchangeOrders:** local open orders whose exchange id is not on the exchange (stale working).
  - **staleWorkingOrders:** subset of missingExchangeOrders that are working/partially_filled (candidates for “mark as canceled”).
  - **repairRecommendations:** e.g. `mark_local_canceled` for each stale working order, `sync_order_from_exchange` for missing local.

- **Apply repairs:** When `applyRepairs` is true, for each stale working order the runtime:
  1. Updates the **order store**: `orderStore.updateStatus(clientOrderId, "canceled")`.
  2. Optionally journals **REPAIR_APPLIED**.
  3. Calls **onRepairApplied** (if provided) with `{ exchangeOrderId, repairKind: "mark_local_canceled" }`.

- **Ledger alignment:** The **onRepairApplied** callback (e.g. in stream-runtime) looks up **ExecutedOrder** by `getExecutedOrderByVenueOrderId(exchangeOrderId)`. If found, it:
  1. Appends **ExecutedOrderEvent** `CANCELED` with payload `{ source: "reconciliation_repair", at }`.
  2. Calls **markExecutedOrderStatus**(executedOrderId, `"canceled"`).

So when repairs are applied, the execution ledger is updated so that the ExecutedOrder row and its event log match the repaired state. Reconciliation does **not** create intents or place/cancel orders on the exchange; it only updates local state and, via the callback, the ledger.

## What durable records are authoritative

- **OrderIntent**, **OrderIntentEvent**, **ExecutedOrder**, **ExecutedOrderEvent**, **CancelRequest**, **ReplaceRequest**, **FillLedgerEntry** in the execution ledger are the **authoritative** audit trail for order lifecycle.
- The **runtime order store** is the in-memory view used by the reconciler and the paper order manager. After repairs (or after cancel/replace in the manager), the store and the ledger should agree for any order that exists in both.
- **Reconciliation** does not read from the ledger to decide repairs; it only compares exchange snapshot vs order store. The callback is used to **write** ledger updates when repairs are applied, so the ledger remains the source of truth for “this order was canceled (by repair).”

## What mismatches are still possible

- **Orders only in the store:** If an order was created before durable ExecutedOrder was implemented, or by a path that does not write to the ledger, there is no ExecutedOrder row. **onRepairApplied** will not find it and will not append CANCELED; the store will still be updated. So the store can show “canceled” while the ledger has no record of that order.
- **Orders only on the exchange:** “Missing local” (exchange order not in store) does not currently create an ExecutedOrder or OrderIntent; reconciliation only recommends `sync_order_from_exchange`. So the ledger may not have a row for that exchange order until it is synced or created by another path.
- **applyRepairs: false:** Stream-runtime currently runs reconciliation with **applyRepairs: false**, so no repairs are applied and **onRepairApplied** is never called. When **applyRepairs** is set to true, the callback will run and the ledger will be updated for any repaired order that has an ExecutedOrder.
- **Timing:** Reconciliation runs periodically. Between runs, the store and exchange can diverge; the ledger is updated when the manager performs cancel/replace or when reconciliation applies repairs (and callback is set).

## What remains for future cleanup

- **Prefer ledger when available:** Reconciler could optionally consider ExecutedOrder status (e.g. already canceled) to avoid recommending cancel for orders that are already terminal in the ledger.
- **Duplicate cancel:** If the same order is recommended for cancel multiple times (e.g. repeated reconciliation before store update propagates), the callback may append multiple CANCELED events. Idempotency (e.g. skip if ExecutedOrder status is already `canceled`) can be added.
- **Missing local / sync_order_from_exchange:** No ledger write is done today for “add missing exchange order to local store”; that would require creating or linking an ExecutedOrder when we sync from exchange (future work).
- **Reconciliation reading from ledger:** For diagnostics or repair decisions, reconciliation could optionally read ExecutedOrder or CancelRequest state (e.g. to avoid duplicate cancel requests). Not implemented yet.
