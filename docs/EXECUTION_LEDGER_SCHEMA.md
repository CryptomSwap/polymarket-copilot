# Execution Ledger Schema

**Purpose:** Durable, auditable data model for order intents, executed orders, fills, and cancel/replace requests. Supports idempotent intent creation, crash recovery, and replay-safe reconciliation without changing current runtime behavior.

---

## 1. Model Overview

| Model | Purpose | Replay / idempotency role |
|-------|---------|----------------------------|
| **OrderIntent** | One row per trading intent (API or future runtime). | `idempotencyKey` (unique per funder) prevents duplicate intent creation across retries/restarts. |
| **OrderIntentEvent** | Append-only events for an intent (created, gated, submitted, rejected). | Audit trail; future replay of intent lifecycle. |
| **ExecutedOrder** | One row per order sent to a venue. | `venueOrderId` unique for dedupe; link to intent and fills. |
| **ExecutedOrderEvent** | Append-only events for an executed order (ack, fill, cancel, reject). | Audit trail; future replay of order lifecycle. |
| **FillLedgerEntry** | One row per fill/trade from venue. | `exchangeFillId` (legacy) or `venueTradeId` unique; prevents double-apply to position; replay-safe. |
| **CancelRequest** | One row per cancel sent to venue. | Durable record of cancel request and status. |
| **ReplaceRequest** | One row per cancel-replace sent to venue. | Durable record of replace request and status. |

---

## 2. What Existed Before This Change

- **OrderIntent** — Already present. Used by API `place` flow (`lib/polymarket/trading.ts`). Had: id, funderAddress, recommendationId, marketId, assetId, outcome, side, orderType, limitPrice, size, status, riskPreviewJson, createdAt, updatedAt. **No** idempotency key or source.
- **ExecutedOrder** — Already present. Used by API place flow. Had: id, funderAddress, orderIntentId, polymarketOrderId, marketId, assetId, side, price, size, status, rawJson, createdAt, updatedAt. **No** venue-agnostic id or event child table.
- **FillLedgerEntry** — Already present. Used by runtime user-feed path (`lib/live/fill-ledger.ts`). Had: funderAddress, exchangeFillId (unique with funder), clientOrderId, exchangeOrderId, assetId, marketId, side, size, price, filledAt, source, appliedToRuntimePosition, appliedAt, payloadJson. **No** link to ExecutedOrder or venueTradeId.
- **OrderLifecycleJournalEntry** — Already present. Append-only by clientOrderId/exchangeOrderId; used by runtime for journaling. **Not** modified in this step; remains separate from ExecutedOrder/ExecutedOrderEvent.
- **RuntimeControl, stream_sync_state** — Unchanged; not part of execution ledger.

---

## 3. What Was Added or Extended

### 3.1 OrderIntent (extended)

| Field | Type | New | Purpose |
|-------|------|-----|---------|
| source | String? | Yes | e.g. "api" \| "runtime_automated" \| "approval_queue". |
| idempotencyKey | String? | Yes | Unique per funder; dedupe intent creation. |
| decisionSnapshotId | String? | Yes | Optional link to decision snapshot. |
| riskCheckSnapshotJson | String? | Yes | Snapshot of risk check at intent creation. |
| executionPolicySnapshotJson | String? | Yes | Snapshot of execution policy at intent creation. |
| metadataJson | String? | Yes | Arbitrary metadata. |

**Constraint:** `@@unique([funderAddress, idempotencyKey])`.  
**Indexes added:** assetId, marketId, createdAt.

### 3.2 OrderIntentEvent (new)

| Field | Type | Purpose |
|-------|------|---------|
| id | String (cuid) | Primary key. |
| orderIntentId | String | FK to OrderIntent (CASCADE delete). |
| eventType | String | e.g. created, gated, submitted, rejected. |
| payloadJson | String? | Event payload. |
| createdAt | DateTime | Append-only ordering. |

**Indexes:** orderIntentId, eventType, createdAt.

### 3.3 ExecutedOrder (extended)

| Field | Type | New | Purpose |
|-------|------|-----|---------|
| venue | String? | Yes | e.g. "polymarket". |
| venueOrderId | String? | Yes | Unique venue-specific order id. |
| orderType | String? | Yes | e.g. GTC. |
| originalSize | String? | Yes | Requested size at submit. |
| remainingSize | String? | Yes | Remaining open size. |
| metadataJson | String? | Yes | Arbitrary metadata. |

**Constraint:** `venueOrderId` unique.  
**Indexes added:** venueOrderId, assetId, marketId, status, createdAt.  
**Legacy:** polymarketOrderId remains required for backward compatibility with existing API.

### 3.4 ExecutedOrderEvent (new)

| Field | Type | Purpose |
|-------|------|---------|
| id | String (cuid) | Primary key. |
| executedOrderId | String | FK to ExecutedOrder (CASCADE delete). |
| eventType | String | e.g. ack, fill, cancel, reject. |
| payloadJson | String? | Event payload. |
| createdAt | DateTime | Append-only ordering. |

**Indexes:** executedOrderId, eventType, createdAt.

### 3.5 FillLedgerEntry (extended)

| Field | Type | New | Purpose |
|-------|------|-----|---------|
| executedOrderId | String? | Yes | FK to ExecutedOrder (SET NULL on delete). |
| orderIntentId | String? | Yes | Optional link to intent. |
| venueTradeId | String? | Yes | Unique venue-specific trade/fill id. |
| fillPrice | Float? | Yes | Alias for price. |
| fillSize | Float? | Yes | Alias for size. |
| fee | Float? | Yes | Fee if known. |
| fillTimestamp | DateTime? | Yes | Alias for filledAt. |
| appliedToPosition | Boolean | Yes | Same semantics as appliedToRuntimePosition. |
| rawPayloadJson | String? | Yes | Raw venue payload. |

**Constraint:** `venueTradeId` unique.  
**Indexes added:** executedOrderId, orderIntentId, venueTradeId, assetId, marketId, filledAt.  
**Legacy:** funderAddress + exchangeFillId unique kept; existing code unchanged.

### 3.6 CancelRequest (new)

| Field | Type | Purpose |
|-------|------|---------|
| id | String (cuid) | Primary key. |
| executedOrderId | String | FK to ExecutedOrder (CASCADE delete). |
| status | String | e.g. pending, acked, rejected. |
| reason | String? | Optional reason. |
| venueRequestId | String? | Venue-specific request id. |
| createdAt, updatedAt | DateTime | Timestamps. |

**Indexes:** executedOrderId, status, createdAt.

### 3.7 ReplaceRequest (new)

| Field | Type | Purpose |
|-------|------|---------|
| id | String (cuid) | Primary key. |
| executedOrderId | String | FK to ExecutedOrder (CASCADE delete). |
| newPrice | String? | New limit price. |
| newSize | String? | New size. |
| status | String | e.g. pending, acked, rejected. |
| reason | String? | Optional reason. |
| venueRequestId | String? | Venue-specific request id. |
| createdAt, updatedAt | DateTime | Timestamps. |

**Indexes:** executedOrderId, status, createdAt.

---

## 4. What Remains Unfixed Until Runtime Rewiring

- **Runtime in-memory order store** is still the source of truth for the paper/live flow; no code writes to OrderIntent/ExecutedOrder/ExecutedOrderEvent from the runtime yet.
- **Intent idempotency** in the runtime path is not enforced: the bot still emits intents without persisting or checking idempotencyKey.
- **Startup rebuild** still uses only exchange open orders + fill ledger; it does not yet use OrderIntentEvent/ExecutedOrderEvent or journal replay for order state.
- **replayUnappliedFills** is still not called in StreamRuntime.start().
- **CancelRequest / ReplaceRequest** are not yet written by any code path; they are schema-only for future use.

---

## 5. Query Hints

- **Intent timeline:** OrderIntentEvent by orderIntentId, order by createdAt.
- **Executed order timeline:** ExecutedOrderEvent by executedOrderId, order by createdAt.
- **Unapplied fills:** FillLedgerEntry where appliedToRuntimePosition = false (and optionally appliedToPosition = false).
- **Orders for market/asset:** ExecutedOrder by assetId or marketId; OrderIntent by assetId or marketId.
- **Lifecycle for a recommendation:** OrderIntent by recommendationId; then ExecutedOrder by orderIntentId; then ExecutedOrderEvent / FillLedgerEntry as needed.
