# Cancel/Replace Durability

## Purpose

Cancel and replace (cancel-replace) flows now persist **CancelRequest** and **ReplaceRequest** records in the execution ledger and append **ExecutedOrderEvent** entries for lifecycle transitions. The execution ledger is the primary audit trail for order modification.

## Current paper semantics

- **Cancel:** Reconciler may emit a CANCEL action for an open order. The paper order manager calls the adapter’s `cancelOrder`; on success it applies cancel ack to the store and emits `order.canceled`. There is no native “cancel order” on a paper venue; the adapter simulates success (or timeout/ambiguous for tests).
- **Replace:** Paper models replace as **cancel then place**: reconcile emits CANCEL_REPLACE (cancel one order, place another). The manager cancels the existing order, then creates and submits a new order with the new size/price. There is no single “replace” API; the ledger records a ReplaceRequest on the **old** order and REPLACE_REQUESTED / REPLACED (or REPLACE_FAILED) events on that order.

## How cancel is persisted

1. **Before** calling the adapter’s `cancelOrder`, the paper order manager calls **onCancelStarted** with `exchangeOrderId` (or `paper_<clientOrderId>` if no exchange id yet).
2. The runtime implementation of **onCancelStarted**:
   - Looks up **ExecutedOrder** by `getExecutedOrderByVenueOrderId(exchangeOrderId)`.
   - If found: creates **CancelRequest** (status `pending`, reason e.g. `runtime_cancel`), appends **ExecutedOrderEvent** `CANCEL_REQUESTED` with payload `{ cancelRequestId, at }`, and returns `{ executedOrderId, cancelRequestId }`.
3. **After** the adapter returns, the manager calls **onCancelCompleted** with `{ executedOrderId, cancelRequestId, success, ambiguous }`.
4. The runtime implementation:
   - If **ambiguous:** appends `CANCEL_SUBMITTED` (payload `ambiguous: true`), marks CancelRequest status `ambiguous`.
   - If **success:** appends `CANCELED`, marks CancelRequest status `completed`, and calls **markExecutedOrderStatus**(executedOrderId, `"canceled"`).
   - If **failure:** appends `CANCEL_FAILED`, marks CancelRequest status `failed`.

So the ledger sees: **CANCEL_REQUESTED** → then one of **CANCELED** | **CANCEL_FAILED** | **CANCEL_SUBMITTED** (ambiguous).

## How replace is persisted

1. **Before** cancel in a CANCEL_REPLACE action, the manager calls **onReplaceStarted** with `exchangeOrderId` of the order being canceled.
2. The runtime implementation:
   - Finds **ExecutedOrder** by venue order id.
   - Creates **ReplaceRequest** (status `pending`, reason e.g. `runtime_replace`).
   - Appends **ExecutedOrderEvent** `REPLACE_REQUESTED` on that order.
   - Returns `{ executedOrderId, replaceRequestId }`.
3. **After** cancel completes, the manager calls **onReplaceCancelCompleted** with `{ executedOrderId, replaceRequestId, cancelSuccess, ambiguous }`.
4. The runtime implementation:
   - If **!cancelSuccess:** appends `REPLACE_FAILED` on the old order, marks ReplaceRequest status `failed`.
   - If **ambiguous:** appends `REPLACE_SUBMITTED` (ambiguous), marks ReplaceRequest status `ambiguous`.
   - If cancel succeeded and not ambiguous, the flow continues to place the new order; no event on the old order yet.
5. When the **new** order is placed and acked, **onOrderPlaced** is called with **replaceContext** `{ replaceRequestId, oldExecutedOrderId }`.
6. The runtime then:
   - Creates the new ExecutedOrder and appends SUBMITTED as usual.
   - Appends **REPLACED** on the **old** ExecutedOrder with payload `{ newExecutedOrderId, replaceRequestId, at }`.
   - Marks ReplaceRequest status `completed`.

So the old order’s events look like: **REPLACE_REQUESTED** → (optional **REPLACE_FAILED** or **REPLACE_SUBMITTED**) or, on success, **REPLACED** when the new order is acked.

## Event meanings

| Event | Meaning |
|-------|--------|
| CANCEL_REQUESTED | Cancel intent recorded; CancelRequest created. |
| CANCEL_SUBMITTED | Cancel was sent but outcome ambiguous (e.g. timeout). |
| CANCELED | Order canceled successfully. |
| CANCEL_FAILED | Cancel rejected or failed. |
| CANCEL_SKIPPED | (Optional) Order already terminal; skip cancel. |
| REPLACE_REQUESTED | Replace intent recorded; ReplaceRequest created on old order. |
| REPLACE_SUBMITTED | Replace (cancel step) in progress or ambiguous. |
| REPLACED | New order acked; replace flow completed for that old order. |
| REPLACE_FAILED | Replace failed (e.g. cancel failed). |
| REPLACE_SKIPPED | (Optional) Skip replace (e.g. order already terminal). |

## Known limitations

- **Paper replace = cancel + place:** There is no single “replace” API; the ledger reflects that with ReplaceRequest on the old order and a new ExecutedOrder for the new order.
- **Duplicate cancel:** If the reconciler emits cancel for an order that is already canceled (e.g. terminal), **onCancelStarted** may still create a new CancelRequest if the ExecutedOrder exists; the adapter may then report success again. Consider skipping CancelRequest creation when ExecutedOrder status is already terminal (future improvement).
- **Reconciliation repair:** When reconciliation applies “mark_local_canceled”, it updates the runtime store only; if **onRepairApplied** is provided (and applyRepairs is true), the ledger is updated (CANCELED event and ExecutedOrder status). Currently stream-runtime runs with **applyRepairs: false**; when enabled, the callback keeps the ledger in sync.
- **Journal vs ledger:** The runtime journal still records CANCEL_REQUESTED, CANCEL_AMBIGUOUS, REPAIR_APPLIED, etc. The execution ledger is the source of truth for cancel/replace lifecycle; journal entries are supplementary.
