# Order Lifecycle, Fill Handling, and Idempotency Audit

**Project:** Polymarket Copilot  
**Scope:** Order state machine, lifecycle handlers, PaperOrderManager, position/fill application, exposure, user WS path, tests.  
**Goal:** Correctness, monotonicity, idempotency, and safety under replay/reconnect/retry.

---

## 1. Order Lifecycle State Model

### 1.1 Statuses and Store Transitions

| Status | Source | Allowed next (intended) |
|--------|--------|-------------------------|
| `pending_submit` | `create()` | working, rejected |
| `working` | `applyAck()` | partially_filled, filled, canceled, pending_cancel |
| `partially_filled` | `applyPartialFill()` | partially_filled, filled, canceled, pending_cancel |
| `pending_cancel` | (not set by current code) | canceled |
| `canceled` | `applyCancel()` | terminal |
| `filled` | `applyPartialFill` / `applyFill` when remaining=0 | terminal |
| `rejected` | `applyReject()` | terminal |
| `expired` | (not set by current code) | terminal |
| `unknown` | (placeholder) | — |

**Open statuses** (for listOpenByAsset): `pending_submit`, `working`, `partially_filled`, `pending_cancel`.

### 1.2 Explicit vs Implicit Transitions

- **Explicit:** `create` → pending_submit; `applyAck` → working; `applyPartialFill`/`applyFill` → partially_filled or filled; `applyCancel` → canceled; `applyReject` → rejected.
- **Implicit:** No state machine enum or central “allowed transition” check. Transitions are implied by which method is called.

### 1.3 Terminal State Protection

**Not protected.**

- `InMemoryOrderLifecycleStore` does **not** check current status before mutating:
  - `applyAck`: no check that status is `pending_submit`; can overwrite exchange id and set working again on an already working/canceled/filled order.
  - `applyPartialFill` / `applyFill`: only `if (!o || fillSize <= 0) return`. A canceled or filled order can receive more fill and move back to `partially_filled` or `filled`, and `filledSize` can grow beyond order size.
  - `applyCancel` / `applyReject`: no check that order is open; terminal state can be overwritten.

So **invalid transitions are possible** (e.g. fill after cancel, ack after fill, double fill).

### 1.4 Exact State Machine (Documented Intended)

```
                    create()
pending_submit ──────────────────────────────────────────► working
     │                    applyAck()                            │
     │                                                          │ applyPartialFill / applyFill
     │                                                          ▼
     │                                              partially_filled ◄──► filled
     │                                                          │
     │ applyReject()                                            │ applyCancel()
     ▼                                                          ▼
rejected                                                    canceled
```

No code enforces this; it is the intended design only.

---

## 2. Lifecycle Handlers

### 2.1 DefaultOrderLifecycleHandler Flows

| Method | Store call | Emits | Guard |
|--------|------------|--------|--------|
| `applyAck` | `applyAck(clientOrderId, exchangeOrderId)` | order.ack | order exists |
| `applyPartialFill` | `applyPartialFill(clientOrderId, fillSize, fillPrice)` | order.partial_fill; if updated.status===filled then order.filled | order exists, fillSize>0 |
| `applyFullFill` | `applyFill(clientOrderId, remaining, avgPrice)` if remaining>0 | order.filled (with input totalFilledSize/avgPrice) | order exists |
| `applyCancelAck` | `applyCancel(clientOrderId)` | order.canceled | order exists |
| `applyRejection` | `applyReject(clientOrderId)` | order.rejected | order exists |

- Handlers do **not** check that the order is in an allowed state (e.g. ack only from pending_submit, fill only from working/partially_filled). They only check existence and (for partial) fillSize>0.
- **applyFullFill**: Uses `remaining = order.remainingSize` and applies that amount to the store, then always emits `order.filled` with `input.totalFilledSize`. So duplicate full-fill events can be emitted (e.g. remaining=0 still emits).

### 2.2 Store Mutation and Events

- Each handler: get order → call store mutator → optionally emit. No rollback on later failure; event bus is fire-and-forget.
- Order is read again after store update only where needed (e.g. `applyPartialFill` for payload; `applyFullFill` for emit). No version/optimistic check.

---

## 3. PaperOrderManager Execution Path

### 3.1 reconcileIntents

1. Guard: no live placement; adapter not live.
2. Dedupe intents by `(funder, asset)` (one order per asset).
3. Load `workingOrders = store.listOpenByAsset(funder, asset)` per intent.
4. `reconciler.reconcile(intents, workingOrders)` → list of actions (KEEP | PLACE | CANCEL | CANCEL_REPLACE).
5. For each action, `applyAction(...)` (await).

No retry loop; no explicit handling of ambiguous outcome (e.g. submit failed vs timeout). Failed submit is treated as reject (lifecycle applyRejection).

### 3.2 applyAction: PLACE / CANCEL / CANCEL_REPLACE

- **PLACE:** create in store → adapter.submitOrder → on success: applyAck (handler or store), emit order.submitted; on failure: applyRejection.
- **CANCEL:** adapter.cancelOrder → on success: applyCancelAck (handler or store).
- **CANCEL_REPLACE:** cancel order (same as CANCEL) then create + submit new order (same as PLACE). No atomicity; cancel and place are separate steps.

### 3.3 Retry / Reconciliation Assumptions

- Single pass over actions; no automatic retry.
- Reconcile is idempotent in the sense that “same intents + same working orders” yields same actions; but if the exchange state changes between reconcile and apply (e.g. fill or cancel from WS), the “working orders” snapshot is stale and we can double-place or cancel an already filled order.
- Ambiguous outcomes (e.g. submit timeout with unknown exchange state) are not modeled; we do not persist “pending submit” for later reconciliation.

---

## 4. RuntimePositionUpdater / RuntimePositionStore

### 4.1 Fill Application Logic

- **Position store `applyFill(params)`**:  
  - BUY → positive delta to signed quantity; SELL → negative.  
  - New position: netShares = size, side = LONG|SHORT from BUY|SELL, avgEntryPrice = price, openedAt/lastFillAt set.  
  - Existing: prevSigned + signedSize → new signed; flip side when crossing zero; volume-weighted avg when adding; when closing/reducing, realized PnL = closeSize * (price - avgEntry) for long close, (avgEntry - price) for short close.  
  - No check that the fill is “new” (no idempotency key); same fill applied twice doubles the effect.

- **Updater `applyFill(fill)`**: calls `store.applyFill`, then emits `position.changed` if netShares or realizedPnl change is material (vs optional thresholds).

### 4.2 Positions Updated Only From Fills?

- Yes: position state is only changed by `applyFill` (and `patch` for mark/confidence). There is no other path that sets netShares/avgEntry/realized from non-fill data.
- But fills reach the position store from two places (see §5): (1) event-bus path (order.partial_fill / order.filled → stream-runtime → position updater with delta), (2) user-feed path (direct positionUpdater.applyFill from normalized trade). So the “only from fills” is true; the bug is applying the same logical fill twice.

### 4.3 LONG / SHORT and Exposure

- **Side:** BUY → LONG (netShares ≥ 0), SELL → SHORT (stored as netShares > 0 with side SHORT; internally signed = -netShares).
- **Exposure** (runtime-exposure.ts):  
  - grossExposure = sum of `exposureNotional` over positions.  
  - netExposure = sum of `(side === "LONG" ? exposureNotional : -exposureNotional)`.  
  - workingOrderCount = count of orders in open statuses.

- exposureNotional is updated in the store on applyFill (and in patch for mark). So exposure is derived from position state and is monotonic in the sense that each new fill changes position and thus exposure; but if fills are double-applied, exposure is wrong.

### 4.4 Monotonicity of Position Updates

- Each `applyFill` is additive to signed quantity and (when closing) to realized PnL. So for a correct sequence of distinct fills, position and exposure move monotonically in the sense “each fill changes state once.”
- Not monotonic under duplicate application: the same fill applied twice increases size and can flip side or distort avg/realized.

---

## 5. Partial-Fill Handling and Deduplication

### 5.1 order.partial_fill Path (Event Bus)

- **Source:** DefaultOrderLifecycleHandler.applyPartialFill (after store.applyPartialFill) emits order.partial_fill with cumulative `filledSize`, `remainingSize`, fillPrice, filledAt.
- **Consumer:** stream-runtime subscribes; keeps `lastAppliedFilledByOrderId` (Map<runtimeOrderId, number>).
  - delta = payload.filledSize - lastApplied; if delta <= 0 skip.
  - lastAppliedFilledByOrderId.set(runtimeOrderId, payload.filledSize); then apply delta to position via normalizedFillFromOrderPartialFill(..., delta).

So for **event-bus-sourced** partials, dedup is by cumulative filledSize: we only apply the delta. Re-delivery of the same event (same cumulative size) yields delta=0 and is safe.

### 5.2 order.filled Path After Prior Partials

- Handler: applyFullFill updates store with remaining, then emits order.filled(totalFilledSize, avgPrice).
- Stream-runtime: delta = totalFilledSize - lastApplied; delete key; if delta > 0 apply delta to position.
- So if we already applied partials (lastApplied = 6) and order.filled says 10, we apply 4. Correct.

### 5.3 lastAppliedFilledByOrderId: In-Memory Only

- Stored only in a Map in the stream-runtime closure. Not persisted.
- **Replay/restart/reconnect:** After process restart or reconnect, lastApplied is lost. Re-delivery of old partial_fill / order.filled events would be applied again (delta = full amount), so **replay is not idempotent** and position can be overstated.

### 5.4 Duplicate Event Handling (Same Process)

- Same event delivered twice in same process: partial_fill with same filledSize → second time delta=0 → skip. order.filled with same totalFilledSize → second time key already deleted, lastApplied=0 from Map → delta = totalFilledSize → **double apply**. So order.filled is not idempotent within the same process if the event is duplicated (e.g. bug or double publish).

### 5.5 Out-of-Order Partial vs Full

- If order.filled is processed before order.partial_fill: we apply full totalFilledSize, then delete key. Later partial_fill: delta = filledSize - 0 (key gone) or filledSize - totalFilledSize. If partial has cumulative filledSize=4 and full had 10, we’d apply 4 again when we see partial (if key was deleted we’d use lastApplied=0), so we could over-apply. So out-of-order can cause over-application unless the store’s filledSize is used as the single source of truth for “how much already applied to position” (currently it is not; we use a separate Map).

### 5.6 User-Feed Path: Double Application to Position (Must-Fix)

- For TRADE messages, `feedUserFeedResultToRuntime` does both:
  1. **applyLifecycle(fill)** → handler.applyFullFill → store updated, **order.filled emitted**.
  2. **positionUpdater.applyFill(result.positionFill)** (same fill size).

- The order.filled subscriber in stream-runtime then applies (totalFilledSize - lastApplied) to position. So the same fill is applied to position **twice**: once by the event handler, once by the direct positionFill call. So **user-WS-sourced fills double-update position**.

---

## 6. Exposure Correctness

### 6.1 Formulas

- **grossExposure:** Sum over all positions of `exposureNotional` (|netShares| * mark or avgEntry).
- **netExposure:** Sum over all positions of `(side === "LONG" ? exposureNotional : -exposureNotional)`.
- **workingOrderCount:** Count of orders in status in OPEN_ORDER_STATUSES (pending_submit, working, partially_filled, pending_cancel).

### 6.2 When Recomputed

- On demand when `getExposureFromStores` or `updateRiskExposureFromStores` is called (e.g. before guardrails in the intent handler, and in getHealth). Not continuously; no caching beyond reading current store state.

### 6.3 Drift from Fills / Order State

- If position store is wrong (e.g. double-applied fills), gross/net exposure are wrong.
- workingOrderCount is consistent with whatever is in the order store; if the order store has invalid transitions (e.g. filled order still open due to a bug), count can be wrong. So exposure can drift if lifecycle or fill application is wrong.

### 6.4 Working Order Count vs Lifecycle

- Count is derived from order status only. No cross-check with exchange; no “stale open” correction. So it is consistent with the in-memory lifecycle state, but that state may not match the exchange after reconnect or missed events.

---

## 7. User WebSocket Normalization Path

### 7.1 Normalized Events → Lifecycle and Position

- **user-feed-normalizer:** Raw WS → NormalizedUserFeedResult (lifecycle + optional positionFill).
  - PLACEMENT/ORDER → ack (exchangeOrderId from payload.id).
  - UPDATE → partial_fill (fillSize = size_matched **cumulative**; consumer must delta from store).
  - TRADE (CONFIRMED/MATCHED/MINED) → lifecycle kind "fill" (totalFilledSize = this trade’s size) + positionFill (same size).
  - CANCELLATION → cancel.
  - Reject/trade failed → reject.

- **user-feed-to-runtime:** Resolves exchangeOrderId → clientOrderId via orderStore.getByExternalId. If order not found, lifecycle is skipped (unmatched); positionFill is still applied when present. For partial_fill, delta = event.fillSize - (order?.filledSize ?? 0); only apply if delta > 0.

### 7.2 ID Preservation and Idempotency

- Lifecycle is keyed by exchangeOrderId; we resolve to clientOrderId once. No event id or fill id is stored for idempotency. Replay of the same WS message (same exchangeOrderId, same fill size) can cause:
  - partial_fill: delta recomputed from current store; if store was already updated by first delivery, delta=0 → idempotent for that path. If store was reset (restart), delta>0 → apply again (not idempotent across restarts).
  - fill: applyFullFill applies remaining again; store can get more fill than order size; order.filled emitted again; position path can apply again. So **replay is not idempotent** and can corrupt store and position.

---

## 8. Tests

### 8.1 Existing Coverage

- **order-lifecycle-store:** create, applyAck, applyPartialFill, applyFill, applyCancel in sequence (single path; no terminal-state or invalid-transition tests).
- **OrderIntentReconciler:** KEEP/CANCEL from intents vs working orders; no CANCEL_REPLACE or PLACE coverage in the same block.
- **StaleOrderSweeper:** one pending_submit stale detection.
- **order.filled → position:** one-shot applyFill from payload; no event-bus path, no delta.
- **order.partial_fill delta:** two manual applyFill calls with deltas 2 and 3; no event emission, no lastAppliedFilledByOrderId.
- **Exposure:** getExposureFromStores / updateRiskExposureFromStores with manually upserted positions (LONG/SHORT, gross/net).
- **PaperOrderManager:** live adapter rejection; intent → reconcileIntents in paper mode (no fill/cancel assertions).
- **Diagnostics:** intent blocked and position update counters.

### 8.2 Missing Tests

- **Lifecycle:** No tests that apply ack/fill/cancel/reject in invalid order (e.g. fill after cancel, ack after fill); no terminal-state guards.
- **Handlers:** No tests that applyPartialFill/applyFullFill when order is already filled/canceled; no duplicate order.filled emission test.
- **Partial-fill monotonicity:** No test that duplicate order.partial_fill (same cumulative filledSize) applies to position once.
- **order.filled idempotency:** No test that duplicate order.filled does not double-apply to position (currently it would, once key is deleted).
- **User-feed double-apply:** No test that a single TRADE message does not update position twice.
- **Replay:** No test that replaying the same user-feed message (or same event) leaves store and position unchanged.
- **Reconnect:** No test that after “reconnect” (e.g. lastApplied cleared) re-delivery of events does not over-apply (or that we detect/handle it).
- **Out-of-order:** No test that order.filled before order.partial_fill does not over-apply.
- **Exposure after fills:** No test that exposure updates correctly after applyFill (only manual upsert positions).
- **Reconciler:** No test for CANCEL_REPLACE or PLACE when no matching working order; no test for “stale working orders” (e.g. already filled on exchange).

### 8.3 Brittle / False Confidence

- Store test applies cancel **after** fill; it does not assert that fill after cancel is rejected or ignored.
- Position partial_fill test uses precomputed deltas (2 and 3) and does not go through the event bus or lastAppliedFilledByOrderId, so it does not validate the real runtime path or dedup.
- Intent→reconcile test only checks “at least one order” and “reconciled”; no assertion on exact actions (KEEP/PLACE/CANCEL) or on fill/cancel flows.

---

## 9. Summary: Must-Fix, Should-Improve, Later

### Must-fix before paper validation

1. **Double application to position from user feed**  
   For TRADE messages, do not call positionUpdater.applyFill(result.positionFill) when lifecycle was applied and was a fill or partial_fill (the event bus will apply via order.filled/order.partial_fill). Apply positionFill only when the order was unmatched or when lifecycle was not a fill (e.g. ack/cancel/reject only).

2. **Terminal state protection in order store**  
   In applyAck, applyPartialFill/applyFill, applyCancel, applyReject: refuse to mutate when order is already in a terminal state (filled, canceled, rejected). Optionally restrict applyAck to pending_submit and applyPartialFill/applyFill to working/partially_filled.

3. **Guard lifecycle handler from terminal orders**  
   In DefaultOrderLifecycleHandler, before calling store mutators, return early if order.status is filled, canceled, or rejected (and optionally restrict ack to pending_submit, fills to working/partially_filled).

### Should-improve soon

4. **Idempotency for order.filled in stream-runtime**  
   Do not delete lastAppliedFilledByOrderId on order.filled; keep it at totalFilledSize so a duplicate order.filled with same total yields delta=0.

5. **User-feed applyFullFill when remaining=0**  
   When order is already filled (remaining=0), do not emit order.filled again (avoid duplicate event and any downstream double-apply risk).

6. **Single source of truth for “applied to position”**  
   Consider using the order store’s filledSize (or a dedicated “positionAppliedUpTo” per order) instead of a separate in-memory Map, so that after reconnect we can avoid re-applying already-applied fill (or mark position as reconciling and resync from exchange/DB).

### Later improvements

7. **Persist or reconcile lastAppliedFilledByOrderId**  
   So that replay/reconnect does not re-apply fills (e.g. persist per order “lastAppliedToPositionFilledSize” or reconcile position from canonical source after reconnect).

8. **Reconcile working orders with exchange**  
   On reconnect, refresh open orders from exchange (or API) and align store (and optionally cancel stray local orders or add missing ones) so working order count and exposure are accurate.

9. **Explicit state machine**  
   Central “allowed transition” checks (or state enum with allowed next states) and tests for every invalid transition.

10. **Tests**  
    Add tests for: terminal-state guards; duplicate partial_fill/filled (same process); user-feed single-message position update count; replay idempotency (or documented non-idempotent behavior); out-of-order full then partial; exposure after applyFill; reconciler CANCEL_REPLACE and PLACE.

---

## 10. Exact Fill Application Path (Reference)

**From exchange event to position/exposure:**

1. **User WS message** → normalizeUserFeedMessage → NormalizedUserFeedResult (lifecycle + positionFill).
2. **feedUserFeedResultToRuntime:**  
   - Resolve exchangeOrderId → clientOrderId (getByExternalId).  
   - If lifecycle and clientOrderId: applyLifecycle (applyAck / applyPartialFill / applyFullFill / applyCancelAck / applyRejection) → store updated, order.* events emitted.  
   - If positionFill: positionUpdater.applyFill(positionFill) ← **second application when lifecycle was fill/partial_fill (bug).**
3. **Event bus order.partial_fill** (from handler): stream-runtime subscriber → delta = filledSize - lastAppliedFilledByOrderId; if delta>0 set lastApplied, apply delta to position via DefaultRuntimePositionUpdater.applyFill.
4. **Event bus order.filled** (from handler): stream-runtime subscriber → delta = totalFilledSize - lastAppliedFilledByOrderId; delete key; if delta>0 apply delta to position.
5. **Position store applyFill:** signed size and PnL update; exposureNotional updated (from mark or avg).
6. **Exposure:** getExposureFromStores / updateRiskExposureFromStores read position store (and order store for working count); no separate persistence.

**Monotonicity assumptions:** Each fill is applied once; filledSize and position netShares move in one direction per fill; no duplicate events.

**Idempotency guarantees:** Partial_fill path is idempotent for same cumulative filledSize in same process (delta=0). Full-fill path is not (key deleted, duplicate event reapplies). User-feed path is not (double apply). No idempotency across restart/replay.

**Replay/double-application risks:** User feed double-apply (must-fix); duplicate order.filled in same process; replay after restart re-applies all fills; out-of-order full then partial can over-apply.

**Exposure drift:** Can drift if position is wrong (double fill, replay) or if order store has invalid/open orders that should be terminal.

---

## 11. Post–refactor verification pass (hardening)

After the fill idempotency refactor and lifecycle hardening:

- **Position updates** are driven only by lifecycle events (order.partial_fill / order.filled). User-feed no longer calls positionUpdater.applyFill directly.
- **appliedPositionFilledSize** is stored on the order; delta = eventFilledSize - order.appliedPositionFilledSize; setAppliedPositionFilledSize caps to order.filledSize.
- **Numeric invariants** enforced in store: filledSize ≤ order.size (cap in applyPartialFill); remainingSize = size - filledSize (≥ 0); appliedPositionFilledSize ≤ filledSize (cap in setAppliedPositionFilledSize).
- **Terminal states** remain immutable; duplicate cancel ack and fill-after-cancel are no-ops.
- **workingOrderCount** uses OPEN_ORDER_STATUSES only; canceled/filled/rejected orders are excluded.
- **Tests:** `fill-position-idempotency-tests.ts` and `lifecycle-exposure-hardening-tests.ts` cover duplicate partial/filled, partial-then-cancel, full-path user-feed → lifecycle → subscriber → position once, exposure consistency, and invariant caps.

**Remaining limitations:** appliedPositionFilledSize is in-memory only (replay after restart still re-applies unless store is persisted). Health/snapshot exposure is read from stores at read time and is not separately persisted.
