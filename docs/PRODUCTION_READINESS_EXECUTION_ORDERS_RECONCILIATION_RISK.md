# Production Readiness Review: Execution, Orders, Reconciliation, and Risk

**Scope:** Execution pipeline and risk controls as if the system may soon handle real money.  
**Focus:** Execution correctness and loss-prevention. Portfolio truth-model work is out of scope unless it directly affects execution safety.

---

## A. Architecture: Execution + Reconciliation Flow

### High-level data flow

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│  SIGNAL / INTENT                                                                 │
│  BotRuntime → order.intent.created (eventBus)                                    │
└─────────────────────────────────────────────────────────────────────────────────┘
                                        │
                                        ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│  GUARDRAILS + POLICY                                                             │
│  StreamRuntime.wireIntentAndFillHandlers:                                        │
│  - isAutomationAllowed() (status === "ready")                                     │
│  - getTradingExecutionPolicy() → isExecutionAllowed("runtime_automated")         │
│  - updateRiskExposureFromStores() → riskEngine.updateExposure()                  │
│  - guardrails.evaluate(context, riskState, proposedAction, { freshness })         │
└─────────────────────────────────────────────────────────────────────────────────┘
                                        │ allowed
                                        ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│  ORDER MANAGER (PaperOrderManager.reconcileIntents([intent]))                     │
│  - assertNoLiveOrderPlacement()                                                  │
│  - adapter.getHealth() must not be "live"                                        │
│  - workingOrders = store.listOpenByAsset(funder, asset)                           │
│  - reconciler.reconcile(intents, workingOrders) → KEEP | PLACE | CANCEL |        │
│    CANCEL_REPLACE                                                                 │
│  - For each action: applyAction() → store.create / adapter.submitOrder /          │
│    adapter.cancelOrder → lifecycleHandler.applyAck | applyReject | applyCancelAck  │
└─────────────────────────────────────────────────────────────────────────────────┘
                                        │
          ┌─────────────────────────────┼─────────────────────────────┐
          ▼                             ▼                             ▼
┌──────────────────┐         ┌──────────────────┐         ┌──────────────────┐
│ In-memory        │         │ OrderLifecycle   │         │ OrderExchange    │
│ OrderLifecycle   │         │ Handler         │         │ Adapter (paper/   │
│ Store            │         │ (store +        │         │ noop/live stub)   │
│ (byClientId,     │         │  eventBus +     │         │ submitOrder /     │
│  byExternalId)   │         │  journalAppend) │         │ cancelOrder       │
└──────────────────┘         └──────────────────┘         └──────────────────┘
          │                             │
          │                             │ order.ack | order.partial_fill |
          │                             │ order.filled | order.canceled |
          │                             │ order.rejected
          │                             ▼
          │                 ┌──────────────────┐
          │                 │ Fill ledger      │  (user-feed path: recordFill
          │                 │ (Prisma)         │   before lifecycle; skip if
          │                 │ (funder,         │   duplicate exchangeFillId)
          │                 │  exchangeFillId) │
          │                 └──────────────────┘
          │                             │
          │         order.partial_fill / order.filled
          │                             ▼
          │                 ┌──────────────────┐
          │                 │ Position updater │  delta = filledSize - appliedPositionFilledSize
          │                 │ (positionStore.  │  when exchangeFillId: isFillAppliedToPosition
          │                 │  applyFill)      │  → skip if already applied; else apply + mark
          │                 └──────────────────┘
          │
          │  User WebSocket (live): normalizeUserFeedMessage → feedUserFeedResultToRuntime
          │  → recordFill (if fill + exchangeFillId) → applyLifecycle (ack/partial_fill/fill/cancel/reject)
          │  → order store + eventBus → position updater (same path as above)
          │
          ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│  RECONCILIATION                                                                  │
│  (1) Runtime (periodic, 60s): runRuntimeReconciliation({ applyRepairs: false })   │
│      - fetchOpenOrdersL2() → exchange snapshot                                   │
│      - compareRuntimeWithExchange(exchangeIds, localOpen) → missingLocal,        │
│        missingExchange (staleWorking), missingFills                               │
│      - If applyRepairs: orderStore.updateStatus(..., "canceled") for stale     │
│      - Currently applyRepairs is false → no auto-repair                           │
│  (2) DB (POST /api/orders/reconcile): reconcileOrders(funder)                   │
│      - ExecutedOrder vs UserOrder (synced); OrderReconciliationSnapshot          │
│      - No write-back to runtime order store                                      │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### Order lifecycle (in-memory store)

- **Create:** `store.create(params)` → status `pending_submit`, `exchangeOrderId = null`.
- **Ack:** `store.applyAck(clientOrderId, exchangeOrderId)` only from `pending_submit` → `working`, set `lastAckAt`.
- **Partial fill:** `store.applyPartialFill(clientOrderId, fillSize, fillPrice)` from `working`|`partially_filled` → `filledSize += fillSize` (capped at `size`), status → `partially_filled` or `filled`.
- **Cancel:** `store.applyCancel(clientOrderId)` from open statuses → `canceled`.
- **Reject:** `store.applyReject(clientOrderId)` only from `pending_submit` → `rejected`.
- **Terminal:** `filled` | `canceled` | `rejected` | `expired` (and ambiguous statuses) are immutable; no further lifecycle mutations.
- **Invariants (enforced in store):** `filledSize <= size`, `remainingSize = size - filledSize`, `appliedPositionFilledSize <= filledSize` (monotonic, capped in `setAppliedPositionFilledSize`).

### Two parallel “order” worlds

1. **Runtime (execution plane):** In-memory `OrderLifecycleStore` + optional `OrderLifecycleJournalEntry` (append-only). Used by StreamRuntime, guardrails, exposure, and position updater. Rebuilt on startup from exchange open orders + fill ledger.
2. **DB (manual/API):** `OrderIntent` + `ExecutedOrder` (from `lib/polymarket/trading.ts` placeLimitOrder/cancelOrderByPolymarketId), `UserOrder` (synced from Polymarket), `OrderReconciliationSnapshot`. Used by manual place/cancel API and DB reconcile. **Not** the source of truth for the runtime order store; runtime store is repopulated from exchange + ledger on startup.

### Exposure and risk

- **Exposure:** `getExposureFromStores(positionStore, orderStore)` → grossExposure (sum position notionals), netExposure (signed), workingOrderCount (orders in pending_submit | working | partially_filled | pending_cancel). Pushed to `riskEngine.updateExposure()` before guardrail evaluation.
- **Risk limits:** In `RuntimeRiskState` (limits, grossExposure, netExposure, workingOrderCount, haltedAssetIds, globalAutomationEnabled). Guardrails block or require_reduction when limits are breached.
- **Kill switch:** In-memory; `applyToRiskState` sets `globalAutomationEnabled = false` and haltedAssetIds. No DB persistence; resets on process restart unless operator sets again.

---

## B. Production Risks (Ordered by Severity)

### Critical

1. **Stale sweeper never applies cancels in production**  
   **Where:** `worker/stream-runtime.ts` line ~499: `this.deps.staleSweeper.sweep()` only.  
   **Risk:** Stale orders (pending_submit no ack, working too old) are only *detected*; `sweepAndApply()` is never called, so no `order.stale` emission and no `applyCancelAck()`. Ghost/stale orders remain in the store, continue to count toward workingOrderCount and exposure, and can block new orders or misrepresent risk.  
   **Evidence:** `lib/runtime/order-manager/order-stale-sweeper.ts`: `sweepAndApply()` both emits and calls `lifecycleHandler.applyCancelAck()`; interval only calls `sweep()`.

2. **Runtime reconciliation never applies repairs**  
   **Where:** `worker/stream-runtime.ts` line ~549: `runRuntimeReconciliation({ ..., applyRepairs: false })`.  
   **Risk:** When the exchange says an order is gone but the runtime still has it as working, we never mark it canceled. Ghost working orders persist until the next restart (rebuild from exchange). They keep reserving exposure and can cause over-counting of working orders.  
   **Evidence:** `lib/runtime/reconciliation/runtime-reconciliation.ts`: `applyRepairs` controls `orderStore.updateStatus(o.clientOrderId, "canceled")` for `staleWorkingOrders`.

3. **Manual place/cancel API and runtime store are disconnected**  
   **Where:** `lib/polymarket/trading.ts` (placeLimitOrder, cancelOrderByPolymarketId) write to `OrderIntent` / `ExecutedOrder` / `UserOrder`; runtime uses in-memory `OrderLifecycleStore` only.  
   **Risk:** Orders placed or canceled via API do not appear in the runtime order store. Exposure and working-order counts can be wrong; guardrails see an incomplete picture. After restart, runtime is rebuilt from exchange + fill ledger, so state can “fix” itself only then.

4. **No idempotency on manual place API**  
   **Where:** `app/api/orders/place/route.ts` → `placeLimitOrder()`; no idempotency key.  
   **Risk:** Duplicate submissions (e.g. double-click, retry) can create multiple orders and multiple `OrderIntent`/`ExecutedOrder` rows for the same logical intent.  
   **Evidence:** `lib/polymarket/trading.ts`: each call creates new OrderIntent and, on success, new ExecutedOrder; no unique constraint on (funderAddress, idempotencyKey) for place.

5. **ExecutedOrder has no unique on (funderAddress, polymarketOrderId)**  
   **Where:** `prisma/schema.prisma`: `ExecutedOrder` has `@@index([polymarketOrderId])` but no `@@unique`.  
   **Risk:** Bug or duplicate flow could insert two ExecutedOrders for the same exchange order id; reconciliation and analytics could double-count or behave inconsistently.

### High

6. **OrderIntent created before CLOB call; no transaction with exchange outcome**  
   **Where:** `lib/polymarket/trading.ts`: `prisma.orderIntent.create()` then `client.createAndPostOrder()`. On CLOB failure, intent is updated to "failed" but already exists.  
   **Risk:** Orphan intents and possible confusion; on partial failure (e.g. timeout after send), we may not have ExecutedOrder but order might exist on exchange. No atomic “intent + result” boundary.

7. **Cancel API updates UserOrder but not ExecutedOrder**  
   **Where:** `lib/polymarket/trading.ts` cancelOrderByPolymarketId: updates `UserOrder` status to "cancelled" via `prisma.userOrder.update()`; no update to `ExecutedOrder.status`.  
   **Risk:** ExecutedOrder and UserOrder can diverge; DB reconciliation and reporting will show inconsistent status.

8. **Place API allows bypassing risk and preflight**  
   **Where:** `app/api/orders/place/route.ts`: `skipBlockedCheck` and `skipPreflightCheck` in body schema.  
   **Risk:** If enabled (e.g. by integrator or bug), orders can be placed despite concentration/safety or preflight failures. Should be restricted (e.g. operator-only or removed for production).

9. **Fill ledger and position updater: race on “apply then mark”**  
   **Where:** `worker/stream-runtime.ts` order.filled/order.partial_fill handlers: they check `isFillAppliedToPosition`, then `positionUpdater.applyFill` + `orderStore.setAppliedPositionFilledSize` + `markFillAppliedToPosition`.  
   **Risk:** Two concurrent events for the same fill (e.g. replay + live) could both pass the “already applied?” check before either marks applied, leading to double-apply to position. Mitigated by fill ledger dedupe at record (exchangeFillId) so duplicate events skip lifecycle; but the position path that runs without exchangeFillId does not use ledger and could double-apply if the same fill is delivered twice without an id.

10. **Reconciliation snapshot upsert is not atomic**  
    **Where:** `lib/polymarket/reconcile.ts`: `findFirst` then `update` or `create`.  
    **Risk:** Two concurrent reconcile runs for the same order could both see no row and both create, or one update and one create, depending on ordering. Schema has no unique on (funderAddress, polymarketOrderId) for OrderReconciliationSnapshot, so duplicate rows are possible.

### Medium

11. **Order lifecycle journal has no idempotency key**  
    **Where:** `lib/runtime/journal/order-lifecycle-journal.ts`: `appendOrderLifecycleEvent` always creates a new row. No unique on (funderAddress, clientOrderId, eventType, occurredAt) or similar.  
    **Risk:** Duplicate events (e.g. reconnect replay) can create duplicate journal entries. Replay from journal (`rebuildOrderFromJournal`) is deterministic and transition-based so duplicate ack/fill might be idempotent by state machine, but journal bloat and ambiguous audit trail.

12. **order-lifecycle-store create() does not reject duplicate clientOrderId**  
    **Where:** `lib/runtime/order-manager/order-lifecycle-store.ts`: `create()` does `this.byClientId.set(params.clientOrderId, state)` without checking existence.  
    **Risk:** If something ever reuses a clientOrderId (e.g. bug or collision in nextClientOrderId), the previous order is overwritten. Currently clientOrderId is time+random so low probability.

13. **Kill switch and risk state are in-memory only**  
    **Where:** `lib/runtime/risk/kill-switch.ts`, `lib/runtime/risk/runtime-risk-engine.ts`.  
    **Risk:** Process restart clears kill switch and risk state. Operator must re-apply; until then, automation could run if restart happens during a “stop” intent.

14. **Stale sweeper interval only runs sweep(); no order.stale in production**  
    **Where:** Already covered in Critical #1; additionally, without sweepAndApply, no order.stale events for dashboards or downstream.

15. **Rebuild clears entire order store then repopulates from exchange**  
    **Where:** `lib/runtime/startup/stream-runtime-rebuild.ts`: `rebuildOrderStoreFromTruth` does `orderStore.clear()` then creates one order per exchange order with clientOrderId = `rebuild:${ex.id}`.  
    **Risk:** Any in-memory orders that were not yet on the exchange (e.g. pending_submit, or just acked but not in snapshot) are dropped. By design for “exchange is truth,” but if we ever had a lag between ack and exchange visibility, we could lose track of that order until it appears in a later snapshot.

### Lower

16. **Guardrails and execution policy are not persisted**  
    **Where:** Guardrail verdicts and execution policy are computed at evaluation time; no DB log of “order blocked because X.”  
    **Risk:** Harder to audit why an order was not placed after the fact.

17. **OrderReconciliationSnapshot has no unique constraint**  
    **Where:** `prisma/schema.prisma`: `OrderReconciliationSnapshot` has indexes but no @@unique([funderAddress, polymarketOrderId]).  
    **Risk:** Duplicate snapshots for same order if reconcile logic or concurrency creates multiple rows.

---

## C. Exact Files and Code Paths

| Risk / Area | File(s) | Relevant symbols / lines |
|-------------|---------|---------------------------|
| Stale sweeper only sweep() | `worker/stream-runtime.ts` | ~499: `staleSweeper.sweep()` |
| Stale sweeper apply | `lib/runtime/order-manager/order-stale-sweeper.ts` | `sweepAndApply()`, `applyCancelAck` |
| Runtime reconciliation applyRepairs | `worker/stream-runtime.ts` | ~407–411: `runRuntimeReconciliation({ applyRepairs: false })` |
| Runtime reconciliation repair logic | `lib/runtime/reconciliation/runtime-reconciliation.ts` | ~199–218: `if (applyRepairs)` |
| Manual API vs runtime store | `lib/polymarket/trading.ts`, `worker/stream-runtime.ts` | trading: placeLimitOrder, cancelOrderByPolymarketId; runtime: orderStore not updated by API |
| Place API idempotency | `app/api/orders/place/route.ts`, `lib/polymarket/trading.ts` | POST body has no idempotencyKey; placeLimitOrder always creates OrderIntent |
| ExecutedOrder uniqueness | `prisma/schema.prisma` | ExecutedOrder model |
| OrderIntent before CLOB | `lib/polymarket/trading.ts` | ~103–118 create intent, ~120–131 CLOB |
| Cancel updates UserOrder only | `lib/polymarket/trading.ts` | ~213–219: userOrder.update only |
| skipBlockedCheck / skipPreflightCheck | `app/api/orders/place/route.ts` | bodySchema, ~82–91, ~93–112 |
| Fill apply + mark race | `worker/stream-runtime.ts` | ~658–672 (partial_fill), ~696–711 (filled) |
| Reconcile snapshot upsert | `lib/polymarket/reconcile.ts` | ~88–114: findFirst then update/create |
| Order lifecycle journal append | `lib/runtime/journal/order-lifecycle-journal.ts` | appendOrderLifecycleEvent, create |
| Order store create | `lib/runtime/order-manager/order-lifecycle-store.ts` | create() |
| Kill switch / risk engine | `lib/runtime/risk/kill-switch.ts`, `lib/runtime/risk/runtime-risk-engine.ts` | InMemoryKillSwitch, InMemoryRuntimeRiskEngine |
| Rebuild clear + repopulate | `lib/runtime/startup/stream-runtime-rebuild.ts` | rebuildOrderStoreFromTruth: orderStore.clear() |
| OrderReconciliationSnapshot schema | `prisma/schema.prisma` | OrderReconciliationSnapshot |

---

## D. Recommended Fixes

### Must fix before real money

1. **Stale sweeper:** In `worker/stream-runtime.ts`, call `staleSweeper.sweepAndApply()` instead of `sweep()` on the interval so stale orders are actually marked canceled and emit order.stale. Ensure this is safe under paper (no exchange cancel) and document that for live, sweeper would need to call adapter.cancelOrder for orders we intend to cancel.
2. **Runtime reconciliation repairs:** Either enable `applyRepairs: true` for the periodic runtime reconciliation (with clear logging and metrics), or introduce a separate “repair” step that runs after reconciliation and applies mark_local_canceled for staleWorkingOrders, so ghost working orders do not persist until restart.
3. **Manual API and runtime store:** When manual place/cancel is allowed (execution policy), either (a) feed successful place/cancel into the runtime order store (e.g. create/update/applyCancel in orderStore and optionally emit events), or (b) formally document that manual orders are out-of-band and exposure/limits are conservative (e.g. include DB ExecutedOrder open count in exposure). Prefer (a) for a single source of truth.
4. **Place API idempotency:** Add an optional idempotency key (e.g. header or body) and enforce at least one of: (i) reject duplicate key with 409 and return existing result, or (ii) store idempotency key on OrderIntent and short-circuit place when key already exists with success. Ensure one logical request → at most one order on the exchange.
5. **ExecutedOrder uniqueness:** Add `@@unique([funderAddress, polymarketOrderId])` (or equivalent) to ExecutedOrder so one exchange order id maps to at most one row. Fix any code that could create a second row (e.g. place retries).

### Should fix soon

6. **Cancel API:** Update `ExecutedOrder.status` (and optionally OrderIntent) when cancelOrderByPolymarketId succeeds, so DB state stays consistent with UserOrder.
7. **skipBlockedCheck / skipPreflightCheck:** Restrict to a dedicated operator role or remove for production; if kept, log and audit every use.
8. **Fill double-apply:** Ensure the position-update path that uses exchangeFillId always goes through the fill ledger (record then apply then mark). For paths without exchangeFillId (e.g. paper), consider a local id (e.g. clientOrderId + fillSeq) to dedupe. Add a test that replays the same fill twice and asserts position updates once.
9. **OrderReconciliationSnapshot:** Use `upsert` with unique constraint on (funderAddress, polymarketOrderId), or `findFirst` + update in a transaction, and add the unique in schema to prevent duplicate rows.
10. **OrderIntent + CLOB atomicity:** Consider creating OrderIntent only after successful CLOB response (or move to “pending” and update to “placed”/“failed” in one place after CLOB). Reduces orphan intents and clarifies state.

### Nice to have

11. **Order lifecycle journal idempotency:** Add a unique constraint or idempotency key (e.g. funderAddress + clientOrderId + eventType + occurredAt round to ms) so duplicate events do not insert duplicate rows; or document that replay is idempotent by transition and accept journal growth.
12. **order-lifecycle-store create:** Reject or merge when clientOrderId already exists (e.g. return existing or throw) to avoid accidental overwrite.
13. **Kill switch persistence:** Persist kill switch state (e.g. in DB or RuntimeControl) so restart does not clear “stop”; operator can explicitly clear.
14. **Guardrail audit log:** Persist guardrail evaluations (verdict + reasonCodes) when an order is blocked or allowed, for post-incident review.

---

## E. Missing Tests That Are Critical

1. **Stale sweeper:** Integration test that advances time so orders become stale, then asserts that after `sweepAndApply()` the store has those orders in `canceled` and that order.stale was emitted (and, when applicable, that adapter.cancelOrder was not called in paper mode).
2. **Runtime reconciliation with applyRepairs:** Test that when exchange returns fewer orders than local working orders, runRuntimeReconciliation with applyRepairs: true marks the correct local orders as canceled and does not touch others.
3. **Fill ledger dedupe:** Test that the same (funderAddress, exchangeFillId) applied twice results in a single position update and a single row in FillLedgerEntry; and that replay of unapplied fills applies each fill exactly once.
4. **Concurrent fill apply:** Test that two handlers (or two replays) for the same fill do not double-apply to position (e.g. use exchangeFillId and ledger; assert final position size and single applied mark).
5. **Place idempotency:** Test that two place requests with the same idempotency key result in one order and one ExecutedOrder (or second returns 409 with same result).
6. **Manual cancel updates ExecutedOrder:** Test that after cancelOrderByPolymarketId, ExecutedOrder (and optionally OrderIntent) status reflects canceled.
7. **Exposure and working count:** Test that after place, workingOrderCount and exposure include the new order; after cancel/fill, they decrease; and that terminal orders do not count.

---

## F. Invariants to Document Explicitly

1. **Order store:** (a) `filledSize <= size`; (b) `remainingSize = size - filledSize`; (c) `0 <= appliedPositionFilledSize <= filledSize`; (d) terminal statuses are immutable; (e) `applyAck` only from `pending_submit`; (f) `applyReject` only from `pending_submit`.
2. **Fill ledger:** One row per (funderAddress, exchangeFillId); a fill is applied to position at most once (recorded then marked applied).
3. **Position store:** Position for (funder, asset) is the sum of applied fills (long/short); no negative size; realized PnL is computed on close.
4. **Exposure:** workingOrderCount = count of orders in pending_submit | working | partially_filled | pending_cancel; grossExposure = sum of position notionals; reserved exposure (if used) should be defined (e.g. sum of working order notional) and documented.
5. **Reconciliation:** Exchange open orders are the authoritative source for “what is live on the book”; local working orders absent on exchange should eventually be marked canceled (repair) or treated as stale.
6. **Execution policy:** No live order is placed or canceled unless the execution surface is allowed by getTradingExecutionPolicy(); runtime_automated is allowed only when mode is paper or live_stub in current rollout; manual_api/approval_queue/position_exit are currently not allowed (liveOrManualExecutionAllowed = false).
7. **Kill switch:** When global stop is on, globalAutomationEnabled in risk state is false and guardrails block new automated orders; state is in-memory only unless persisted elsewhere.

---

*End of production readiness review.*
