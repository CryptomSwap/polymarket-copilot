# Executed Order Lifecycle Durability

## Purpose

When the paper order manager places and acks an order, it can persist an **ExecutedOrder** in the execution ledger linked to the **OrderIntent**, and append **ExecutedOrderEvent** records for major lifecycle transitions. This makes the executed-order lifecycle auditable and replay-friendly.

## How paper orders map into ExecutedOrder / ExecutedOrderEvent

- **When:** After the paper adapter (or equivalent) returns success and the runtime applies ack to the order store, the manager calls the optional **onOrderPlaced** callback with `orderIntentId` (ledger intent id), `clientOrderId`, `exchangeOrderId`, funder, assetId, marketId, side, size, price.
- **ExecutedOrder:** Created with `venue: "paper"`, `polymarketOrderId` and `venueOrderId` set to the paper order id (e.g. `paper_<clientOrderId>`), `orderIntentId` set to the ledger intent id, and `status: "open"`. Other fields (marketId, assetId, side, orderType, price, size, originalSize, remainingSize) are set from the callback params.
- **ExecutedOrderEvent:** The first event appended is **SUBMITTED** (with payload such as `{ exchangeOrderId, at }`). Further events (OPEN, PARTIALLY_FILLED, FILLED, CANCEL_REQUESTED, CANCELED, REJECTED, FAILED) can be appended as the paper or exchange lifecycle evolves.

## Lifecycle event meanings

| Event type       | Meaning |
|------------------|--------|
| CREATED          | ExecutedOrder row created (optional; SUBMITTED often suffices for “order placed”). |
| SUBMITTED        | Order submitted to venue (paper or exchange); ack received. |
| OPEN             | Order is open on the book. |
| PARTIALLY_FILLED | Partial fill; payload can include fill size/price. |
| FILLED           | Order fully filled. |
| CANCEL_REQUESTED | Cancel requested. |
| CANCELED         | Order canceled. |
| REJECTED         | Order rejected by venue. |
| FAILED           | Submission or other failure. |

Not all transitions exist in the current paper flow; the durable model is extended as needed. Current runtime wiring appends **SUBMITTED** when the paper order is placed and acked.

## Linkage to fills and order intents

- **OrderIntent → ExecutedOrder:** `ExecutedOrder.orderIntentId` references `OrderIntent.id`. The timeline for an intent (`getIntentTimeline(orderIntentId)`) returns the intent, its **OrderIntentEvent** rows, linked **ExecutedOrder** rows, their **ExecutedOrderEvent** rows, and any **FillLedgerEntry** rows for those orders.
- **Fills:** Fill ledger entries can reference `executedOrderId` and/or `orderIntentId`. Applied fills are used for position rebuild and replay; linkage to ExecutedOrder/OrderIntent supports audit and attribution.

## Known gaps still remaining

- **Cancel/replace:** Paper cancel (and replace) paths do not yet append CANCEL_REQUESTED / CANCELED or equivalent events to the ledger; they can be added when those flows are stabilized.
- **Fills:** Fill ledger is populated from the fill ingestion path; the paper order manager does not currently append fill events to the executed order. Linkage of fills to ExecutedOrder (e.g. by `exchangeOrderId` or venue trade id) is done in the fill-ledger layer where applicable.
- **Status updates:** ExecutedOrder status (e.g. open → filled) is not yet updated on every lifecycle event; the primary audit trail is the append-only ExecutedOrderEvent table. Status can be updated for convenience (e.g. `markExecutedOrderStatus`) when desired.
