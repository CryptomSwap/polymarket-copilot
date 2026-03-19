# API Order Path – Execution Ledger Migration

## Purpose

The API/manual order placement path (lib/polymarket/trading.ts) now uses the **execution-ledger service** as the primary persistence layer for OrderIntent and ExecutedOrder. This removes the previous bypass and aligns the API path with the runtime path for auditability and lifecycle semantics.

## Old direct-Prisma behavior

- **placeLimitOrder** created **OrderIntent** via `prisma.orderIntent.create` with status `"pending"`, then called the CLOB client. On success it updated the intent with `prisma.orderIntent.update` (status `"placed"`) and created **ExecutedOrder** via `prisma.executedOrder.create`. On failure it updated the intent to `"failed"`.
- No idempotency: every call created a new OrderIntent and, on success, a new ExecutedOrder.
- No OrderIntentEvent or ExecutedOrderEvent records.
- **cancelOrderByPolymarketId** still uses **prisma.userOrder** for local status; that model is separate from the execution ledger and unchanged.

## New execution-ledger–backed behavior

1. **Idempotent intent creation**  
   Before calling the CLOB, the code builds an **idempotency key** with `buildApiOrderIdempotencyKey` and calls **createIntentWithEvent** with `source: "api"` and status `"pending"`. If the key already exists, the existing intent is returned.

2. **Intent events**  
   - **CREATED** (first event from createIntentWithEvent).  
   - **API_REQUESTED** (append after create/get).  
   - On CLOB success: **READY_FOR_SUBMISSION** (payload includes polymarketOrderId).  
   - On CLOB failure or no order ID: **FAILED** (payload includes reason).  
   Intent status is updated via **markOrderIntentStatusInLedger** (`"placed"` or `"failed"`).

3. **Duplicate / already placed**  
   If the idempotency key matches an existing intent that already has an **ExecutedOrder** (found via **getIntentTimeline** and **getExecutedOrder**), the function returns success with the existing **orderIntentId**, **executedOrderId**, and **polymarketOrderId** without calling the CLOB again.

4. **ExecutedOrder and order events**  
   After a successful CLOB response, **createExecutedOrderForIntent** is called with `venue: "polymarket"`, `venueOrderId` and `polymarketOrderId` set to the CLOB order ID, and `linkToIntentId: intent.id`. Then **appendExecutedOrderEventForOrder** records a **SUBMITTED** event with payload `{ polymarketOrderId, at }`.

5. **Failure path**  
   If the CLOB returns no order ID or throws, the code appends **FAILED** to the intent, sets intent status to `"failed"`, and returns the same **PlaceOrderResult** shape as before (success: false, orderIntentId, error).

## Idempotency strategy

- **Key components:**  
  `funderAddress`, `"api"`, `recommendationId` (if present), `assetId`, `side`, `orderType` (e.g. GTC), normalized `limitPrice` (4 decimals), normalized `requestedSize` (4 decimals), optional `clientOrderId` (if ever passed).
- **Same key** → same intent. A duplicate request (e.g. retry or double submit) with the same parameters gets the same OrderIntent and, if that intent already has an ExecutedOrder, the same order is returned without a second CLOB call.
- **Different key** → new intent (e.g. different size, price, or recommendationId).
- Key is built by **buildApiOrderIdempotencyKey** in lib/execution-ledger/idempotency.ts; see that function and the execution-ledger types for the exact field list.

## Compatibility notes

- **PlaceOrderResult** is unchanged: `success`, `orderIntentId`, `executedOrderId`, `polymarketOrderId`, `error`.
- **PlaceOrderInput** and **PlaceOrderOptions** are unchanged.
- **cancelOrderByPolymarketId** is unchanged; it still updates **UserOrder** via Prisma for local state. Execution-ledger cancel (CancelRequest / ExecutedOrderEvent) is not yet used on this path; that can be added later if desired.
- API routes that call **placeLimitOrder** (e.g. **POST /api/orders/place**, approval-queue execute, place-exit) require no changes.

## Remaining gaps (if any)

- **Execution policy snapshot:** The API path does not run the full execution-policy evaluator before placing; it only checks **assertExecutionAllowed(executionSurface)**. So **executionPolicySnapshotJson** is not set on the OrderIntent. That is acceptable for the current manual/API gate; policy can be added later if needed.
- **Cancel path:** Canceling by Polymarket order ID does not create a **CancelRequest** or append **ExecutedOrderEvent** (e.g. CANCELED) in the ledger. Only **UserOrder** is updated. Adding ledger cancel events for the API cancel path would require resolving ExecutedOrder by polymarketOrderId and then creating CancelRequest and appending events.
