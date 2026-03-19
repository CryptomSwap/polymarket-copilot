# Execution Ledger Service

**Purpose:** Production-grade repository and service layer for the persistent execution ledger. All future execution lifecycle writes and timeline/unapplied-fill reads should go through this API. Current runtime and API routes are **not** rewired yet; this layer is additive and ready for future use.

---

## 1. Repository Responsibilities

The **repository** (`lib/execution-ledger/repository.ts`) is the single Prisma-backed data access layer for:

| Area | Functions | Responsibility |
|------|-----------|----------------|
| **OrderIntent** | `createOrderIntent`, `createOrderIntentIdempotent`, `getOrderIntentById`, `getOrderIntentByIdempotencyKey`, `appendOrderIntentEvent`, `markOrderIntentStatus` | Create intent (with optional idempotent dedupe by funder+idempotencyKey), read by id or idempotency key, append events, update status. |
| **ExecutedOrder** | `createExecutedOrder`, `getExecutedOrderById`, `getExecutedOrderByVenueOrderId`, `linkExecutedOrderToIntent`, `appendExecutedOrderEvent`, `markExecutedOrderStatus` | Create/link/update executed orders; append order events. |
| **Fill ledger** | `recordFillLedgerEntry`, `getFillLedgerEntryByVenueTradeId`, `getUnappliedFills`, `markFillApplied` | Record fill (dedupe by funder+exchangeFillId or venueTradeId); list unapplied; mark applied once. |
| **Cancel/Replace** | `createCancelRequest`, `createReplaceRequest` | Persist cancel and replace requests. |
| **Timeline** | `getExecutionTimelineForIntent` | Return intent + intent events + executed orders + order events + fills in a single ordered timeline. |

- **Strongly typed:** Inputs and outputs use app-layer types from `types.ts`, not raw Prisma models.
- **Transaction boundaries:** Single-operation functions; no multi-table transactions in this step. Callers can wrap in `prisma.$transaction` if needed.
- **Duplicate handling:** Intent: `createOrderIntentIdempotent` uses create-or-get by (funderAddress, idempotencyKey). Fill: `recordFillLedgerEntry` checks (funderAddress, exchangeFillId) and venueTradeId before insert; returns existing record and `duplicate: true` when already present.
- **Single-apply for fills:** `markFillApplied` updates only rows where `appliedToRuntimePosition = false`; returns `true` if at least one row was updated. Second call returns `false` (no row updated).

---

## 2. Service Responsibilities

The **service** (`lib/execution-ledger/service.ts`) is a thin orchestration layer that:

- Exposes a **clean API** for future runtime: create intent with first event, create executed order and link to intent, record fill with dedup result, mark fill applied safely, create cancel/replace requests, get intent timeline, get replayable unapplied fills.
- Adds **domain semantics** where useful (e.g. “create intent with event” in one call; “record fill and return dedup result”).
- Does **not** contain business rules beyond “call repository in the right order”; no trading logic, no policy.

| Service function | Repository calls | Use case |
|------------------|------------------|----------|
| `createIntentWithEvent` | createOrderIntentIdempotent, appendOrderIntentEvent | Create intent idempotently and append first event (e.g. "created"). |
| `getIntentTimeline` | getExecutionTimelineForIntent | Audit/replay: intent + events + orders + fills in order. |
| `createExecutedOrderForIntent` | createExecutedOrder, linkExecutedOrderToIntent, getOrderIntentById | Create executed order and optionally link to intent. |
| `appendExecutedOrderEventForOrder` | appendExecutedOrderEvent | Append ack/fill/cancel/reject event. |
| `getExecutedOrder` | getExecutedOrderById | Read executed order by id. |
| `recordFillAndReturnDedupResult` | recordFillLedgerEntry | Record fill; get back record + duplicate flag. |
| `markFillAppliedSafely` | markFillApplied | Mark fill applied (single-apply safe). |
| `getFillByVenueTradeId` | getFillLedgerEntryByVenueTradeId | Read fill by venue trade id. |
| `getReplayableUnappliedFills` | getUnappliedFills | List unapplied fills for replay. |
| `createCancelRequestForOrder` | createCancelRequest | Persist cancel request. |
| `createReplaceRequestForOrder` | createReplaceRequest | Persist replace request. |

---

## 3. Idempotency Semantics

- **Intent:** When `idempotencyKey` is set, `createOrderIntentIdempotent` (and thus `createIntentWithEvent`) returns the existing intent if (funderAddress, idempotencyKey) already exists. No second row is created. Key is normalized (trim, collapse whitespace) via `normalizeIdempotencyKey`.
- **Fill:** `recordFillLedgerEntry` treats (funderAddress, exchangeFillId) as the legacy unique key and venueTradeId as an additional unique key. If either matches an existing row, the existing record is returned and `duplicate: true`. No second row.
- **Mark fill applied:** `markFillApplied` uses `updateMany` with `appliedToRuntimePosition: false` in the where clause. Only unapplied rows are updated. So the transition to “applied” happens at most once per row.

Idempotency helpers live in `lib/execution-ledger/idempotency.ts`: `normalizeIdempotencyKey`, `buildIdempotencyKey`, `isPrismaUniqueViolation`, `createOrGetByUniqueKey`.

---

## 4. What Is Safe Now

- **Creating intents** with or without idempotency key; appending intent events.
- **Creating executed orders** and linking to intents; appending order events.
- **Recording fills** with legacy exchangeFillId and/or venueTradeId; dedupe is explicit and safe.
- **Marking fills applied** once per row; safe to call repeatedly (second call no-ops and returns false).
- **Creating cancel/replace requests**; no dedupe semantics yet (add later if needed).
- **Reading** intent by id or idempotency key; executed order by id or venueOrderId; fill by venueTradeId; unapplied fills; timeline for an intent.

---

## 5. What Is Still Not Wired Into Runtime

- **StreamRuntime / paper order manager** still use in-memory order store and existing `OrderLifecycleJournalEntry` + `fill-ledger.ts` only. They do **not** call this execution-ledger service or repository.
- **API place/cancel** (`lib/polymarket/trading.ts`) still creates OrderIntent and ExecutedOrder directly via Prisma; it does **not** use `createIntentWithEvent` or `createExecutedOrderForIntent`.
- **User feed → fill** still goes through `lib/live/fill-ledger.ts` (`recordFill`, `markFillAppliedToPosition`). The execution-ledger `recordFillLedgerEntry` and `markFillApplied` are the same schema but a different API; migration of call sites is a later step.
- **Startup rebuild / replay** does not yet use `getReplayableUnappliedFills` or timeline from this layer; `replayUnappliedFills` in StreamRuntime is still not invoked.

---

## 6. How Future Runtime Code Should Use This Layer

1. **Intent creation (e.g. from bot or approval queue):** Call `createIntentWithEvent` with a deterministic `idempotencyKey` (e.g. from `buildIdempotencyKey(funder, recommendationId, slot)` or similar). Use the returned `intent.id` and respect `existing` to avoid double-submit.
2. **After placing an order with the venue:** Call `createExecutedOrderForIntent` with venue order id and link to the intent; then `appendExecutedOrderEventForOrder` for ack (and later fill/cancel/reject).
3. **When a fill is received:** Call `recordFillAndReturnDedupResult`; if `duplicate` is true, skip applying to position. If false, apply to position then call `markFillAppliedSafely` with the record id or venueTradeId.
4. **Cancel/replace:** Call `createCancelRequestForOrder` or `createReplaceRequestForOrder` when sending the request to the venue.
5. **Replay / audit:** Use `getIntentTimeline` for a given intent; use `getReplayableUnappliedFills(funder)` for cold-start replay of unapplied fills.

Import from `@/lib/execution-ledger` or from `@/lib/execution-ledger/service` and `@/lib/execution-ledger/repository` as needed.
