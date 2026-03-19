# Execution Durability & Replay Safety Audit

**Project:** Polymarket Copilot  
**Scope:** Trading runtime execution path — order intents, fills, partial fills, cancels, reconciliation, position mutations.  
**Goal:** Concrete understanding of execution durability and replay safety before architecture changes.  
**Date:** 2025-03 (audit snapshot).

---

## 1. End-to-End Execution Flow Reconstruction

### 1.1 Signal / Recommendation → Order Intent

| Step | Location | Description |
|------|----------|-------------|
| Market/position/order events | `worker/websockets.ts` → `lib/live/market-feed-normalizer.ts`, `lib/live/user-feed-to-runtime.ts` | Market WS → `feedNormalizedUpdatesToEngine` (MarketStateEngine). User WS → `normalizeUserFeedMessage` → `feedUserFeedResultToRuntime` (lifecycle + fill ledger). |
| Bot scheduler | `lib/runtime/bot-runtime/bot-runtime.ts` | Scheduler drains queue; `handleDecision(assetId)` builds context, calls `evaluateLiveStrategyPlaceholder`, then `emitIntentIfNeeded`. |
| Intent emission | `lib/runtime/bot-runtime/bot-runtime.ts` (lines 213–232) | When action is `PLACE_ENTRY` / `PLACE_EXIT` / `UPDATE_QUOTES`, publishes `order.intent.created` on event bus with `funderAddress`, `strategyId`, `assetId`, `marketId`, `side`, `size`, `limitPrice`, `intentId`. **No recommendationId in payload**; intent is strategy-output only. |

**Note:** The API path (`app/api/orders/place/route.ts`) is separate: it uses Prisma `OrderIntent` / `ExecutedOrder`, `placeLimitOrder`, and manual approval. It does not go through the runtime event bus or `PaperOrderManager`.

### 1.2 Order Intent → Paper/Live Order Manager

| Step | Location | Description |
|------|----------|-------------|
| Intent subscription | `worker/stream-runtime.ts` → `wireIntentAndFillHandlers()` (lines 576–662) | Subscribes to `order.intent.created`. |
| Gates | Same | `isAutomationAllowed()` (status === "ready"); `getTradingExecutionPolicy()` / `isExecutionAllowed("runtime_automated")`; `updateRiskExposureFromStores`; `guardrails.evaluate()` (freshness, exchange truth, frozen assets, etc.). |
| Reconcile | Same | Builds `OrderIntent` from payload; calls `orderManager.reconcileIntents([intent])` (fire-and-forget Promise with catch for diagnostics). |
| Reconciler | `lib/runtime/order-manager/order-intent-reconciler.ts` | `DefaultOrderIntentReconciler.reconcile(intents, workingOrders)` → KEEP / PLACE / CANCEL / CANCEL_REPLACE. Match by intentId first, then (asset, side, price, size). |
| Apply actions | `lib/runtime/order-manager/paper-order-manager.ts` → `applyAction()` | PLACE: `store.create()` → `adapter.submitOrder()` → `lifecycleHandler.applyAck` or `applyRejection`; CANCEL: `adapter.cancelOrder()` → `applyCancelAck`; CANCEL_REPLACE: cancel then create+submit. Journal events: `LOCAL_ORDER_CREATED`, `ACK`, `CANCEL_REQUESTED`, etc. |

### 1.3 Exchange / User WebSocket Events → Lifecycle Updates

| Step | Location | Description |
|------|----------|-------------|
| User WS message | `worker/websockets.ts` | `userWs.onMessage` → `normalizeUserFeedMessage(funder, msg)` → `feedUserFeedResultToRuntime(result, opts)`. |
| Normalization | `lib/live/user-feed-normalizer.ts` | Raw payload → `NormalizedUserFeedResult` (lifecycle: ack, partial_fill, fill, cancel, reject; `exchangeFillId` when present). |
| Fill ledger (durability) | `lib/live/user-feed-to-runtime.ts` (lines 73–88) | If `fillLedgerEnabled` and fill with `exchangeFillId`: `recordFill()` before applying. If `recorded === false` (duplicate), skip lifecycle and return. |
| Lifecycle apply | `lib/live/user-feed-to-runtime.ts` → `applyLifecycle()` | Resolve `exchangeOrderId` → `clientOrderId` via `orderStore.getByExternalId`. If no match, count unmatched and return. Else call `lifecycleHandler.applyAck` / `applyPartialFill` / `applyFullFill` / `applyCancelAck` / `applyRejection`. |
| Handler → store + events | `lib/runtime/order-manager/order-lifecycle-handler.ts` | Each apply updates store and emits `order.ack`, `order.partial_fill`, `order.filled`, `order.canceled`, `order.rejected`. Journal append for each transition. |

### 1.4 Lifecycle Updates → Position Mutations

| Step | Location | Description |
|------|----------|-------------|
| Fill event subscription | `worker/stream-runtime.ts` → `wireIntentAndFillHandlers()` (lines 665–731) | Subscribes to `order.partial_fill` and `order.filled`. |
| Delta and ledger check | Same | For each event: get order from store; `delta = filledSize - (order.appliedPositionFilledSize ?? 0)`; if delta ≤ 0 skip. If `exchangeFillId` present: async branch: `isFillAppliedToPosition(funder, exchangeFillId)` → if already applied, return; else build normalized fill, `positionUpdater.applyFill(fill)`, `orderStore.setAppliedPositionFilledSize`, `markFillAppliedToPosition()`. Without exchangeFillId: apply fill and set applied size in memory only. |
| Position updater | `lib/runtime/positions/runtime-position-updater.ts` | `applyFill()` updates `InMemoryRuntimePositionStore` (netShares, avgEntryPrice, realizedPnlApprox, etc.) and emits `position.changed`. |

### 1.5 Reconciliation Interactions

| Component | Location | Description |
|-----------|----------|-------------|
| Periodic reconciliation | `worker/stream-runtime.ts` (lines 416–437) | `setInterval` every `RUNTIME_RECONCILE_INTERVAL_MS` (60_000): `runRuntimeReconciliation({ funderAddress, orderStore, applyRepairs: false, journalAppend })`. |
| Reconciliation logic | `lib/runtime/reconciliation/runtime-reconciliation.ts` | `getStoredCredentials` → `fetchOpenOrdersL2` → parse exchange orders → `compareRuntimeWithExchange(exchangeIds, localOpen)` → missing local, missing exchange, stale working, missing fills. Emits `REPAIR_RECOMMENDED` (and optionally `REPAIR_APPLIED` when `applyRepairs: true`). **Current default: applyRepairs = false** — only recommendations. |
| Startup rebuild | `worker/stream-runtime.ts` (lines 302–354) | Credentials → `fetchOpenOrdersL2` → `rebuildOrderStoreFromTruth(orderStore, exchangeOrders, funder, journalAppend)` (clears store, repopulates with `rebuild:${exchangeId}`); `getFillsForRebuild(funder)` → `rebuildPositionStoreFromTruth(positionStore, positionUpdater, ledgerFills)`; `recomputeRiskExposure`. |

---

## 2. Exact In-Memory-Only State

| State | Type | Location | Notes |
|--------|------|----------|--------|
| Order lifecycle (all orders) | `Map<clientOrderId, RuntimeOrderState>` + `Map<exchangeOrderId, RuntimeOrderState>` | `lib/runtime/order-manager/order-lifecycle-store.ts` → `InMemoryOrderLifecycleStore` | byClientId, byExternalId. Cleared and repopulated on startup from exchange snapshot. |
| Runtime positions | `Map<funder::assetId, RuntimePositionState>` | `lib/runtime/positions/runtime-position-store.ts` → `InMemoryRuntimePositionStore` | Cleared and rebuilt from fill ledger on startup. |
| Market state (tracked assets) | In-memory store + engine | `lib/runtime/market-state/market-state-store.ts`, `market-state-engine.ts` | Quotes, depth, staleness. Not persisted. |
| Risk engine state | Single state object (grossExposure, netExposure, globalAutomationEnabled) | `lib/runtime/risk/runtime-risk-engine.ts` → `InMemoryRuntimeRiskEngine` | Recomputed at startup from stores. |
| Kill switch | In-memory | `lib/runtime/risk/kill-switch.ts` → `InMemoryKillSwitch` | Not persisted; worker can clear via RuntimeControl row. |
| Failure containment | Frozen asset IDs, ambiguity counters, timestamps | `lib/runtime/execution/execution-failure-containment.ts` → `FailureContainmentStateManager` | All in-memory; reset on restart. |
| Bot scheduler queue / asset state | In-memory maps | `lib/runtime/bot-runtime/bot-runtime.ts` | Queue and per-asset lastEvaluatedAt/lastSignal. |
| Event bus | In-memory pub/sub | `lib/runtime/events/runtime-event-bus.ts` → `InMemoryRuntimeEventBus` | No persistence. |
| Diagnostics / latency counters | In-memory | `lib/runtime/telemetry/runtime-diagnostics.ts`, `runtime-latency-monitor.ts` | Counters and snapshots; lost on restart. |

---

## 3. Exact Persistence Currently Used

| Artifact | Schema / Table | Written By | Read By |
|----------|----------------|------------|---------|
| Fill ledger (one row per exchange fill) | `FillLedgerEntry` (funderAddress, exchangeFillId unique; appliedToRuntimePosition, appliedAt) | `lib/live/fill-ledger.ts` → `recordFill()`, `markFillAppliedToPosition()` | `getFillsForRebuild`, `getUnappliedFills`, `isFillAppliedToPosition`; startup rebuild and fill-handler dedupe. |
| Order lifecycle journal (append-only) | `OrderLifecycleJournalEntry` (funderAddress, clientOrderId, exchangeOrderId, intentId, assetId, marketId, side, eventType, occurredAt, payloadJson) | `lib/runtime/journal/order-lifecycle-journal.ts` → `appendOrderLifecycleEvent()`; called from lifecycle handler, paper order manager, sweeper, rebuild, reconciliation | `getOrderLifecycleHistory`, `rebuildOrderFromJournal`, `getLatestJournalStateForOrder` — **not used in hot startup path**; order store is rebuilt from exchange snapshot only. |
| Runtime control (kill switch clear) | `RuntimeControl` (id = "default", clearGlobalStopRequested) | Worker polls and updates after clear | Worker only. |
| Stream sync state | `stream_sync_state` (lastEventAt, lastReconciliationAt, trackedAssetCount) | `lib/live/streaming-sync.ts` → `updateStreamSyncState` | Dashboard/health. |
| Websocket connection status | `WebsocketConnectionStatus` | Worker / WS layer | Health APIs. |
| Worker heartbeat | `WorkerHeartbeat` | `worker/heartbeat.ts` | Health. |

**Not used for execution replay:** Prisma `OrderIntent`, `ExecutedOrder` are used by the **API** order flow (manual place), not by the StreamRuntime paper path. The runtime does not read or write them for the bot-driven path.

---

## 4. Restart / Replay Failure Modes

| Failure Mode | Cause | Impact |
|--------------|--------|--------|
| **Order store lost** | Process restart; store is in-memory. | Rebuild from exchange open orders (`fetchOpenOrdersL2`). Orders created by runtime but not yet acked on exchange are lost. Rebuild uses `rebuild:${exchangeId}` as clientOrderId — no link to pre-restart clientOrderIds. |
| **Position store lost** | Process restart. | Rebuild from fill ledger `getFillsForRebuild(funder)`; all ledger entries applied in filledAt order. Positions are correct **if** ledger is complete. |
| **Unapplied fills never replayed** | `replayUnappliedFills()` is **defined** in `worker/stream-runtime.ts` (lines 428–447) but **never called** in `start()`. | Any fill that was written to the ledger but not yet marked `appliedToRuntimePosition` (e.g. crash after recordFill, before markFillAppliedToPosition) will not be applied after restart. Position will be undercounted until next identical fill (deduped) or manual fix. |
| **Journal not used for order rebuild** | Startup uses only exchange snapshot + fill ledger. `getOrderLifecycleHistory` / `rebuildOrderFromJournal` exist but are not invoked in StreamRuntime.start(). | Orders that existed only locally (e.g. pending_submit before ack) are gone. No replay of order state from journal. |
| **Duplicate fill delivery (reconnect)** | User WS reconnects; exchange re-sends same fill. | **Mitigated:** `recordFill()` is idempotent (unique on funderAddress + exchangeFillId). Second apply is skipped in `feedUserFeedResultToRuntime`. When `exchangeFillId` is present, position handler also checks `isFillAppliedToPosition` before applying. |
| **Double apply of same fill (no exchangeFillId)** | Fill from user feed without exchangeFillId. | No ledger record; no idempotency. Re-delivery (e.g. duplicate WS message) can double-apply to position. |
| **Failure containment reset** | Restart clears `FailureContainmentStateManager`. | Frozen assets and ambiguity counters reset; runtime may allow automation on previously frozen assets before verification. |
| **Reconciliation applyRepairs = false** | Default in StreamRuntime. | Stale working orders (local has order, exchange does not) are only reported; store is not updated to canceled. Drift persists until manual or future change. |

---

## 5. Duplicate-Fill / Duplicate-Intent / Duplicate-Cancel Risks

| Risk | Mitigation | Gap |
|------|------------|-----|
| **Duplicate fill (same exchangeFillId)** | Fill ledger: `recordFill` insert unique on (funderAddress, exchangeFillId). If existing, skip lifecycle in `feedUserFeedResultToRuntime`. In position handler, `isFillAppliedToPosition` before apply; then `markFillAppliedToPosition`. | None for fills that have exchangeFillId. |
| **Duplicate fill (no exchangeFillId)** | None. | Re-delivery applies again; position can be overstated. |
| **Duplicate intent (same asset/side/price/size)** | Reconciler matches by intentId or shape; KEEP or single PLACE. Multiple intents for same asset in one batch deduped by `seen` set in PaperOrderManager (one intent per funder:assetId in batch). | Same intent emitted twice in different batches (e.g. two bot ticks) can produce two PLACE actions and two orders. No idempotency key on intents. |
| **Duplicate cancel** | Cancel is by clientOrderId; store applies cancel once. Terminal state not enforced in store (see ORDER_LIFECYCLE_FILL_IDEMPOTENCY_AUDIT.md) — applyCancel on already canceled order overwrites. | Idempotent in effect but not by design; double cancel ack could in theory be applied. |
| **Duplicate ack** | Store: `applyAck` only checks `o.status !== "pending_submit"` (and ambiguous). No guard against ack when already working. | Second ack could overwrite exchangeOrderId or lastAckAt. |

---

## 6. Race Conditions and Ordering Assumptions

| Area | Assumption / Race | Notes |
|------|-------------------|--------|
| **Intent vs open orders** | Intent handler runs with snapshot of working orders at reconcile time. New order from same intent could be in flight from previous tick. | Reconciler sees “working” order and returns KEEP; no race if single-threaded event loop. |
| **User feed vs order manager** | User WS delivers ack/fill/cancel; same order may be updated by PaperOrderManager (e.g. local create + paper ack). | Order of messages matters. Paper ack is synchronous in same process; user feed is async. If user fill arrives before paper ack, getByExternalId fails (unmatched). |
| **Fill applied vs mark ledger** | Position handler: apply fill → setAppliedPositionFilledSize → markFillAppliedToPosition. If process dies after apply and before mark, replayUnappliedFills would fix — but **replayUnappliedFills is not called**. | Risk of under-applied position after crash. |
| **Rebuild order vs user feed** | Startup clears order store and repopulates from exchange. Rebuild uses clientOrderId = `rebuild:${exchangeId}`. Later user feed events use exchangeOrderId; getByExternalId will match rebuild ids. | Consistent. |
| **Reconciliation vs in-flight orders** | Reconciliation runs every 60s; compares exchange snapshot to local open. In-flight submits not yet on exchange appear as “missing exchange”; can be marked stale / repair recommended. | applyRepairs false by default so no automatic overwrite. |
| **Event bus ordering** | Single in-memory bus; subscribers run synchronously in publish order. No out-of-order delivery within process. | Safe. |

---

## 7. Current Idempotency Mechanisms and Gaps

| Mechanism | Where | Sufficient? |
|-----------|--------|-------------|
| Fill ledger (funder + exchangeFillId) | `recordFill` unique constraint; `isFillAppliedToPosition` before position apply | **Yes** for fills with exchangeFillId. |
| appliedPositionFilledSize (per order) | `order.partial_fill` / `order.filled` handler uses delta = filledSize - appliedPositionFilledSize; setAppliedPositionFilledSize caps to filledSize, monotonic | **Yes** for same-process duplicate events. Lost on restart (order store rebuilt; appliedPositionFilledSize from exchange size_matched in rebuild). |
| Order lifecycle store transitions | Intended: pending_submit → working → filled/canceled. **Not enforced** in code (see ORDER_LIFECYCLE_FILL_IDEMPOTENCY_AUDIT.md). applyAck, applyPartialFill, applyCancel, applyReject do not check current status. | **No.** Invalid transitions (e.g. fill after cancel, double ack) are possible. |
| Intent idempotency | No idempotency key. Reconciler dedupes within batch by funder:assetId; no cross-batch dedupe. | **No.** Two identical intents in different evaluations can create two orders. |
| Approval queue (API path) | `ApprovalQueueEntry` has `idempotencyKey`; `BotQueueExecutionLog` logs by idempotencyKey. | Only for approval-queue flow, not for runtime automated path. |
| Journal append | Append-only; no dedupe. Replay is deterministic but not used at startup. | Audit trail only; not used for idempotent replay. |

---

## 8. “Must Persist” Entities for Real-Money Readiness

| Entity | Current | For real-money |
|--------|---------|----------------|
| **Open orders (runtime view)** | In-memory only; rebuilt from exchange on startup. | Persist or rebuild from exchange + journal; support pending_submit and in-flight state. |
| **Fills (position impact)** | FillLedgerEntry (persisted); appliedToRuntimePosition. | Keep; ensure every fill has exchangeFillId and record before apply. |
| **Order lifecycle journal** | Append-only persisted; not used in startup. | Use for replay when exchange snapshot is stale or partial; or as source of clientOrderId ↔ exchangeOrderId mapping. |
| **Intents (optional)** | Not persisted in runtime path. | Consider persisting with idempotency key to prevent duplicate orders across restarts/retries. |
| **Failure containment state** | In-memory. | Persist frozen assets / verification required so restart does not clear safety state. |
| **Kill switch / global stop** | In-memory; RuntimeControl only for “clear” request. | Persist actual state (e.g. globalAutomationEnabled) so restart respects operator intent. |
| **Risk exposure** | Recomputed from stores. | Keep recompute; ensure stores are durable or rebuilt correctly. |

---

## 9. Concrete Files / Functions That Must Change

| File | Function / Area | Change |
|------|------------------|--------|
| `worker/stream-runtime.ts` | `start()` | Call `await this.replayUnappliedFills(funder)` after position store rebuild so unapplied ledger entries are applied once. |
| `worker/stream-runtime.ts` | `replayUnappliedFills()` | Currently private and never invoked; ensure it runs after `rebuildPositionStoreFromTruth` and before status = "ready". |
| `lib/runtime/order-manager/order-lifecycle-store.ts` | `applyAck`, `applyPartialFill`, `applyFill`, `applyCancel`, `applyReject` | Enforce valid state transitions (e.g. ack only from pending_submit; fill only from working/partially_filled; no mutate terminal). |
| `lib/runtime/order-manager/order-lifecycle-handler.ts` | All apply methods | After store mutation, optionally verify order state; avoid emitting if transition was no-op (e.g. duplicate ack). |
| `lib/live/user-feed-normalizer.ts` / CLOB contract | exchangeFillId | Ensure every fill event from exchange includes a stable fill/trade id for ledger. |
| `lib/runtime/bot-runtime/bot-runtime.ts` or intent consumer | Intent emission | Add idempotency key (e.g. strategyId + assetId + slot/timestamp window or recommendationId) and persist or dedupe before reconcileIntents. |
| `lib/runtime/reconciliation/runtime-reconciliation.ts` | Default applyRepairs | Document or make configurable; if enabling applyRepairs, ensure journal and store stay in sync. |
| `lib/runtime/execution/execution-failure-containment.ts` | State | Persist frozenAssetIds (and optionally counters) so restart does not clear. |
| `lib/runtime/risk/kill-switch.ts` / runtime control | Global stop state | Persist so restart preserves “automation off” until operator clears. |
| `lib/runtime/startup/stream-runtime-rebuild.ts` | Order rebuild | Optionally merge or reconcile with journal for orders that are pending_submit or not on exchange yet. |

---

## 10. Directory and Path Notes

- **lib/orders/** — **Does not exist.** Order logic lives under `lib/runtime/order-manager/`.
- **lib/execution/** — **Does not exist at repo root.** Execution failure containment is in `lib/runtime/execution/` (e.g. `execution-failure-containment.ts`).
- **lib/risk/** — **Does not exist at repo root.** Risk and kill switch are in `lib/runtime/risk/`.
- **app/api/live/** — Contains `stream-health`, `ws-status` (and related). Health and stream status only; no order execution.
- **app/api/orders/** — Contains `place`, `cancel`, `lifecycle-history`, `reconciliation-summary`, `ws-status`. Place/cancel are manual/API flow (Prisma OrderIntent, ExecutedOrder, `placeLimitOrder`), not the StreamRuntime paper path.

---

## References

- `docs/ORDER_LIFECYCLE_FILL_IDEMPOTENCY_AUDIT.md` — Terminal state, store transitions, handler behavior.
- `docs/FILL_LEDGER_IMPLEMENTATION.md` — Fill ledger design; notes intended `replayUnappliedFills` after start.
- `docs/STREAM_RUNTIME_STARTUP_REBUILD.md` — Startup sequence and rebuild order.
- `docs/RUNTIME_RECONCILIATION.md` — Reconciliation comparison and repair.
- Prisma schema: `FillLedgerEntry`, `OrderLifecycleJournalEntry`, `RuntimeControl`, `stream_sync_state`, `UserOrder`, `UserFill`, `UserPosition`, `OrderIntent`, `ExecutedOrder`.
