# Automated Trading Runtime â€” Implementation Report

**Project:** Polymarket Copilot  
**Stack:** Next.js + TypeScript, Prisma + Postgres, Node worker processes, Polymarket CLOB integration, WebSocket streaming  
**Report date:** Evidence-based audit of current repository state. No work is claimed that does not exist in code.

**Document status:** Verified against implementation after execution-policy, readiness/degraded-state, and fill-idempotency hardening. Central execution policy, lifecycle-driven position updates, and truthful health/readiness semantics are reflected below.

---

## 1. Executive Summary

### What the runtime initiative was trying to achieve

The initiative aimed to build an **automated trading runtime** that:

- Maintains live in-memory market and position state from WebSocket feeds
- Runs a bot that evaluates market/position/risk and emits order intents
- Reconciles intents with actual order state and submits (paper or live) via an exchange adapter
- Applies risk guardrails, kill switch, and rollout safeguards before any live execution

### What is now implemented

- **Runtime skeleton:** `StreamRuntime` composes event bus, market state engine, position store, risk engine, kill switch, bot runtime, order manager (paper), and stale sweeper. Worker starts it when `USE_STREAM_RUNTIME=true`.
- **Typed event bus:** Full `RuntimeEvent` type set and `InMemoryRuntimeEventBus` with subscribe/publish and wildcard support.
- **Market State Engine:** Store, types, metrics, health, ingestion (quote/depth/trade/repair), tick-based staleness, and emission of `market.*` events.
- **Market WS â†’ Engine:** Raw market WS messages normalized in `market-feed-normalizer.ts` and fed into `MarketStateEngine` in both legacy `startWebsockets()` and `startWebsocketsWithRuntime()`.
- **User WS â†’ Order/Position:** User feed normalized in `user-feed-normalizer.ts`; `user-feed-to-runtime.ts` applies **lifecycle only** to `OrderLifecycleHandler` (no direct position update). Positions are updated **exclusively from lifecycle events** (`order.partial_fill` and `order.filled`) in StreamRuntime fill subscribers.
- **Order Manager:** In-memory order lifecycle store (with `appliedPositionFilledSize` and transition guards), desired-vs-actual reconciler, paper adapter, lifecycle handler (ack/partial/fill/cancel/reject â†’ store + events), stale sweeper (periodic sweep in StreamRuntime).
- **Position store:** In-memory, fill-driven updates via `DefaultRuntimePositionUpdater` only from **lifecycle event subscribers** (order.partial_fill / order.filled); idempotent via `order.appliedPositionFilledSize` on the order record.
- **Risk:** `InMemoryRuntimeRiskEngine`, `InMemoryKillSwitch` (global + per-asset), `DefaultRuntimeGuardrails` (evaluate context + proposed action). Kill switch defaults to global stop when `globalAutomationDisabledByDefault` is true.
- **Bot Runtime:** Event-driven scheduler, context from market/position/open-orders, placeholder strategy (`evaluateLiveStrategyPlaceholder`), emits `bot.decision.evaluated` and `order.intent.created`.
- **Debug/health:** `runtime-health.ts`, `createRuntimeHealth()`; health snapshot in `StreamRuntime.getHealth()` includes **lifecycleStatus**, **stream connection state** (`marketConnection`, `userConnection` with status/lastOpenAt/lastMessageAt/lastErrorAt/reconnectAttempts), **operationalReadiness** (both streams open), **degradedReasons** (from `computeDegraded`), **real schedulerBacklog** from bot scheduler, **reconcile failure diagnostics** (reconcileFailureCount, lastReconcileFailureAt/Reason/IntentId), and **executionPolicy**; heartbeat includes `runtimeHealth` when StreamRuntime is used.
- **APIs:** `GET /api/ops/runtime/health` (from heartbeat DB), `GET /api/ops/runtime/dashboard`, `GET /api/ops/runtime/snapshot`, `GET /api/ops/runtime/market-state`, `GET /api/markets/live/detail?assetId=`.
- **Central execution policy:** `lib/runtime/trading-execution-policy.ts` â€” single source of truth for all order-capable surfaces; `getTradingExecutionPolicy()`, `assertExecutionAllowed(surface)`, `isExecutionAllowed(surface)`, `getExecutionBlockedReasons(surface)`. **Execution surfaces:** `runtime_automated` (StreamRuntime intent path), `manual_api`, `approval_queue`, `position_exit`. Automated path allowed only in paper/live_stub; live/manual explicitly not authorized (fail-closed). All real CLOB calls (`lib/polymarket/trading.ts`) and API routes (place/cancel/approval-queue/place-exit) pass `executionSurface` and are gated by the policy.
- **Runtime config:** `runtime-config.ts` with `RuntimeMode` and `ROLLOUT_ALLOWED_MODES`; mode clamped from env; policy consumes config for effective mode and blocked reasons.
- **Telemetry/diagnostics:** `RuntimeDiagnosticsSnapshot` and `DefaultRuntimeDiagnosticsCollector` (counts, reconciliation actions, **reconcileFailureCount** and last-failure fields); wired in StreamRuntime; intent and fill handlers record events and block reasons.
- **Tests:** `lib/runtime/__tests__/runtime-core-tests.ts`, `fill-position-idempotency-tests.ts`, `lifecycle-exposure-hardening-tests.ts`, `trading-execution-policy-tests.ts`, `runtime-readiness-degraded-tests.ts` â€” market store, metrics, health, scheduler, position/order lifecycle, idempotency, exposure, policy, readiness/degraded.

### What remains incomplete (qualified)

- **Live adapter:** `LivePolymarketAdapterStub` rejects all; no real CLOB integration. **No path to live** from automated runtime or manual/API routes without explicit policy change; all surfaces are gated by the central execution policy.
- **appliedPositionFilledSize in-memory only:** Idempotency is per order record in the lifecycle store; after process restart, replay of the same fill events would re-apply unless the store (or appliedPositionFilledSize) is persisted.
- **pending_cancel:** Status exists in the lifecycle model but is not actively set by current code paths.
- **Telemetry sinks:** `NoopRuntimeTelemetry` stub; diagnostics collector is wired but external sinks (e.g. metrics export) are not.

### Current readiness level

**Paper-ready with closed-loop and hardened health.**

- **Automated StreamRuntime:** Intent â†’ order manager wired; guardrails and exposure run before reconciliation; only paper adapter; execution gated by central policy (`runtime_automated` allowed when effective mode is paper/live_stub). Position updates only from lifecycle events (order.partial_fill / order.filled) with idempotent delta from `order.appliedPositionFilledSize`.
- **Manual/API surfaces:** Place, cancel, approval-queue execute, position exit routes call `lib/polymarket/trading.ts` with `executionSurface`; policy asserts and returns 403 when blocked. Live/manual execution is not authorized by policy (fail-closed).
- **Health/readiness:** Status reflects lifecycle; stream state is real (connecting/open/reconnecting/closed + timestamps); operationalReadiness = both streams open; degradedReasons from rules (WS stale, backlog, reconcile failures, etc.); schedulerBacklog from bot scheduler; dashboard/snapshot use policy and real state, not hardcoded booleans.
- **Live:** Not enabled; central policy keeps live and manual execution blocked.

---

## 2. Implementation Inventory by Area

### 2.1 Runtime architecture skeleton

| Item | Status | Notes |
|------|--------|--------|
| StreamRuntime composition | **Implemented** | `worker/stream-runtime.ts`: creates event bus, market store/engine, position store/updater, risk engine, kill switch, order store/lifecycle/reconciler/paper adapter, stale sweeper, bot runtime; starts WS via `startWebsocketsWithRuntime()`, market tick and stale sweep intervals. |
| Worker entry point | **Implemented** | `worker/index.ts`: `USE_STREAM_RUNTIME=true` â†’ `StreamRuntime` start; else legacy `startWebsockets()`. Graceful shutdown stops StreamRuntime or WS. |
| In-memory only | **Implemented** | No Prisma on hot path; stores are process-local. |

**Files:** `worker/index.ts`, `worker/stream-runtime.ts`.

---

### 2.2 Typed internal runtime event bus

| Item | Status | Notes |
|------|--------|--------|
| Event types | **Implemented** | `lib/runtime/events/runtime-events.ts`: `RuntimeEventType`, `RuntimeEventBase`, payload types for market, position, order, risk, health, tick; `RuntimeEvent` union; `createRuntimeEventId()`. |
| Event bus | **Implemented** | `lib/runtime/events/runtime-event-bus.ts`: `InMemoryRuntimeEventBus` â€” `publish()`, `subscribe(type, handler)` with wildcard `"*"`, handler error isolation. |
| Wired into flows | **Implemented** | Used by MarketStateEngine, OrderLifecycleHandler, PositionUpdater, KillSwitch, Guardrails, BotRuntime; StreamRuntime builds a single bus and passes it through. |

**Files:** `lib/runtime/events/runtime-events.ts`, `lib/runtime/events/runtime-event-bus.ts`, `lib/runtime/events/index.ts`.

---

### 2.3 Market State Engine store/types

| Item | Status | Notes |
|------|--------|--------|
| Types | **Implemented** | `lib/runtime/market-state/market-state-types.ts`: `AssetLiveState`, quote/depth/lastTrade/volatility/liquidity/health/seq/market; `AssetLiveStatePatch`, `MarketStateSnapshot`, `createEmptyAssetState()`. |
| Store | **Implemented** | `lib/runtime/market-state/market-state-store.ts`: `InMemoryMarketStateStore` â€” getAsset, getAssets, upsertAsset, patchAsset, tracked IDs, snapshot; copy-on-write. |
| Wired | **Implemented** | Used by MarketStateEngine; StreamRuntime and websockets pass the same store into the engine. |

**Files:** `lib/runtime/market-state/market-state-types.ts`, `lib/runtime/market-state/market-state-store.ts`.

---

### 2.4 Market State metrics and health logic

| Item | Status | Notes |
|------|--------|--------|
| Metrics | **Implemented** | `lib/runtime/market-state/market-state-metrics.ts`: quote/depth/liquidity/volatility helpers; `deriveQuoteMetrics`, `deriveDepthImbalances`, `lastUpdateForAsset`, `BasicMarketStateMetricsComputer`. |
| Health | **Implemented** | `lib/runtime/market-state/market-state-health.ts`: `isStale`, `isDegraded`, `isRecovered`, `BasicMarketStateHealthChecker` (aggregate from metrics). |
| Engine use | **Implemented** | MarketStateEngine uses metrics for derived fields and health for staleness/recovery in `tick()` and when applying updates. |

**Files:** `lib/runtime/market-state/market-state-metrics.ts`, `lib/runtime/market-state/market-state-health.ts`.

---

### 2.5 Market State Engine ingestion/event pipeline

| Item | Status | Notes |
|------|--------|--------|
| Engine | **Implemented** | `lib/runtime/market-state/market-state-engine.ts`: `applyQuoteUpdate`, `applyTradeUpdate`, `applyDepthUpdate`, `applyRepairSnapshot`, `tick()`; thresholds for emitting quote/depth/liquidity; emits `market.quote.changed`, `market.depth.changed`, `market.trade.printed`, `market.liquidity.changed`, `market.stale`, `market.recovered`, `market.repaired`. |
| Normalizer | **Implemented** | `lib/live/market-feed-normalizer.ts`: `normalizeMarketFeedMessage()`, `feedNormalizedUpdatesToEngine()` for raw WS payloads â†’ quote/trade/depth. |
| WS â†’ Engine | **Implemented** | `worker/websockets.ts`: market WS `onMessage` â†’ normalize â†’ `feedNormalizedUpdatesToEngine(updates, marketStateEngine)`. Same in both legacy and `startWebsocketsWithRuntime()`. |

**Files:** `lib/runtime/market-state/market-state-engine.ts`, `lib/live/market-feed-normalizer.ts`, `worker/websockets.ts`.

---

### 2.6 Runtime debug/health inspection surface

| Item | Status | Notes |
|------|--------|--------|
| Health type | **Implemented** | `lib/runtime/runtime-health.ts`: `RuntimeHealth` includes **lifecycleStatus**, **streams.marketConnection** / **userConnection** (real state: status, lastOpenAt, lastMessageAt, lastErrorAt, reconnectAttempts), **operationalReadiness** (both streams open), **degradedReasons** (from `computeDegraded`), **counts.schedulerBacklog** from bot, **diagnostics** (including reconcileFailureCount, lastReconcileFailureAt/Reason/IntentId), **executionPolicy**; `createRuntimeHealth()`. |
| StreamRuntime health | **Implemented** | `StreamRuntime.getHealth()` builds health from deps, **getStreamRuntimeStatus()** for real connection state, **computeDegraded()** for degradedReasons, **botRuntime.getSchedulerBacklog()** for real backlog; heartbeat returns `runtimeHealth`. |
| Market state debug | **Implemented** | `lib/runtime/market-state/market-state-engine-debug.ts`: `setMarketStateEngineForDebug`/`getMarketStateEngineForDebug`, `buildMarketStateEngineDebugPayload`, `buildNoEngineDebugPayload`. |
| Bot debug | **Implemented** | `lib/runtime/bot-runtime/bot-runtime-debug.ts`: `setBotRuntimeForDebug`/`getBotRuntimeForDebug`, `getBotAssetSummaryForDetail`. |
| API routes | **Implemented** | `GET /api/ops/runtime/health`, `GET /api/ops/runtime/dashboard`, `GET /api/ops/runtime/snapshot` (from heartbeat; use executionPolicy and real stream state for liveTradingBlocked / operationalReadiness / degradedReasons), `GET /api/ops/runtime/market-state`, `GET /api/markets/live/detail?assetId=`. |

**Files:** `lib/runtime/runtime-health.ts`, `lib/runtime/stream-connection-state.ts`, `lib/runtime/runtime-degraded.ts`, `lib/runtime/market-state/market-state-engine-debug.ts`, `lib/runtime/bot-runtime/bot-runtime-debug.ts`, `app/api/ops/runtime/health/route.ts`, `app/api/ops/runtime/dashboard/route.ts`, `app/api/ops/runtime/snapshot/route.ts`, `app/api/ops/runtime/market-state/route.ts`, `app/api/markets/live/detail/route.ts`.

---

### 2.7 Bot Runtime scheduler/state/context/decision pipeline

| Item | Status | Notes |
|------|--------|--------|
| Scheduler | **Implemented** | `lib/runtime/bot-runtime/bot-scheduler.ts`: `EventDrivenBotScheduler` â€” enqueue/enqueueBatch, coalesce window, priority, single in-flight per asset, calls `onDecision(envelope)`. |
| Context | **Implemented** | `lib/runtime/bot-runtime/bot-context.ts`: `DefaultBotRuntimeContextProvider`, `buildBotDecisionContext()` from snapshot (market store, position store, risk state, open orders). |
| Decision types | **Implemented** | `lib/runtime/bot-runtime/bot-decision-types.ts`: `BotDecisionContext`, `BotDecisionOutput`, `BotDecisionEnvelope`, action kinds (NOOP, PLACE_ENTRY, PLACE_EXIT, UPDATE_QUOTES, CANCEL_ORDERS, REDUCE_RISK). |
| Placeholder strategy | **Implemented** | `lib/runtime/bot-runtime/live-strategy-placeholder.ts`: `evaluateLiveStrategyPlaceholder()` â€” risk/market health/position confidence/inventory threshold/UPDATE_QUOTES at mid; returns structured reason codes. |
| Bot runtime | **Implemented** | `lib/runtime/bot-runtime/bot-runtime.ts`: subscribes to market/position/order/risk events, enqueues assets, `handleDecision()` builds context and runs placeholder, emits `bot.decision.evaluated` and `order.intent.created`. |
| Wired | **Implemented** | StreamRuntime creates bot with context provider and store refs; bot subscribes to bus and is started; debug ref set for Market Detail API. |

**Files:** `lib/runtime/bot-runtime/bot-scheduler.ts`, `lib/runtime/bot-runtime/bot-context.ts`, `lib/runtime/bot-runtime/bot-decision-types.ts`, `lib/runtime/bot-runtime/live-strategy-placeholder.ts`, `lib/runtime/bot-runtime/bot-runtime.ts`.

---

### 2.8 Runtime Position Store and fill-driven updater

| Item | Status | Notes |
|------|--------|--------|
| Position store | **Implemented** | `lib/runtime/positions/runtime-position-store.ts`: `InMemoryRuntimePositionStore` â€” getPosition, getPositionsForFunder, upsert, patch, `applyFill()`, confidence (live/reconciling/degraded), snapshot. |
| Updater | **Implemented** | `lib/runtime/positions/runtime-position-updater.ts`: `DefaultRuntimePositionUpdater` â€” `applyFill()`, `updateMark()`, emits `position.changed`; `normalizedFillFromOrderFilled()`, `normalizedFillFromOrderPartialFill()`. |
| **Lifecycle-driven only** | **Implemented** | Positions are updated **only** from lifecycle events. `user-feed-to-runtime.ts` **does not** call `positionUpdater.applyFill()`; it applies lifecycle only. Position updates happen in StreamRuntime subscribers to `order.partial_fill` and `order.filled`. |
| **Idempotency** | **Implemented** | Order lifecycle store has `appliedPositionFilledSize` per order; fill subscribers compute delta = eventFilledSize âˆ’ order.appliedPositionFilledSize; after applying, `orderStore.setAppliedPositionFilledSize(id, eventFilledSize)` (capped to order.filledSize). Duplicate partial/filled events are idempotent. |
| Wired (order.partial_fill / order.filled) | **Implemented** | StreamRuntime `wireIntentAndFillHandlers()` subscribes to both; delta from order record; position updater receives only the delta; appliedPositionFilledSize updated so replay/duplicate does not double-apply. |

**Files:** `lib/runtime/positions/runtime-position-store.ts`, `lib/runtime/positions/runtime-position-updater.ts`, `lib/runtime/order-manager/order-lifecycle-store.ts` (appliedPositionFilledSize, setAppliedPositionFilledSize), `lib/live/user-feed-to-runtime.ts` (lifecycle only; no positionUpdater).

---

### 2.9 Runtime risk engine / guardrails / kill switch

| Item | Status | Notes |
|------|--------|--------|
| Risk engine | **Implemented** | `lib/runtime/risk/runtime-risk-engine.ts`: `RuntimeRiskState`, `InMemoryRuntimeRiskEngine` â€” getState, updateState, `updateExposure()`. |
| Kill switch | **Implemented** | `lib/runtime/risk/kill-switch.ts`: `InMemoryKillSwitch` â€” global stop, per-asset halt, `applyToRiskState()`, `evaluate()` (auto-stop on unhealthy exchange). |
| Guardrails | **Implemented** | `lib/runtime/risk/runtime-guardrails.ts`: `DefaultRuntimeGuardrails.evaluate()` â€” kill switch, exchange health, market stale/degraded, liquidity/spread, position confidence, exposure/working-order limits; emits `risk.limit_hit`; verdict allowed/blocked/requires_reduction. |
| Wired (kill switch) | **Implemented** | StreamRuntime creates kill switch, sets global stop when `globalAutomationDisabledByDefault`; risk state used by bot context. |
| Wired (guardrails) | **Implemented** | Intent handler in `wireIntentAndFillHandlers()` calls `guardrails.evaluate()` before `reconcileIntents()`; blocked verdict prevents submission. |
| Wired (exposure) | **Implemented** | `updateRiskExposureFromStores(riskEngine, positionStore, orderStore)` called at start of each intent handling; gross/net exposure and working order count from stores; `riskEngine.updateExposure()` and `contextProvider.updateRiskState()` keep risk state in sync. |

**Files:** `lib/runtime/risk/runtime-risk-engine.ts`, `lib/runtime/risk/kill-switch.ts`, `lib/runtime/risk/runtime-guardrails.ts`, `lib/runtime/runtime-exposure.ts`, `worker/stream-runtime.ts`.

---

### 2.10 Order Manager core state and desired-vs-actual reconciliation

| Item | Status | Notes |
|------|--------|--------|
| Order lifecycle store | **Implemented** | `lib/runtime/order-manager/order-lifecycle-store.ts`: `InMemoryOrderLifecycleStore` â€” create, applyAck/PartialFill/Fill/Cancel/Reject, **transition guards** (terminal immutable; ack only from pending_submit; fill only from working/partially_filled; cancel only when open; reject only from pending_submit), **appliedPositionFilledSize** (per order), **setAppliedPositionFilledSize** (capped to filledSize); **numeric invariants**: filledSize â‰¤ size, remainingSize â‰¥ 0. listOpenByAsset, getStaleCandidates, getPendingSubmitOlderThan, getWorkingOlderThan. |
| Lifecycle handler | **Implemented** | `lib/runtime/order-manager/order-lifecycle-handler.ts`: `DefaultOrderLifecycleHandler` â€” applyAck/PartialFill/FullFill/CancelAck/Rejection â†’ store + emit order.* events; **order.filled emitted only when remaining > 0**. |
| Intent reconciler | **Implemented** | `lib/runtime/order-manager/order-intent-reconciler.ts`: `DefaultOrderIntentReconciler` â€” KEEP/PLACE/CANCEL/CANCEL_REPLACE from intents vs working orders; match by intentId or (asset, side, price, size). |
| Paper order manager | **Implemented** | `lib/runtime/order-manager/paper-order-manager.ts`: `reconcileIntents(intents)` â†’ reconciler â†’ adapter submit/cancel, lifecycle handler for acks/rejects/cancels, emits `order.submitted`; **assertNoLiveOrderPlacement** and adapter health check; **diagnostics** and **reconcileIntents** failures caught and recorded. |
| OrderReconciler class | **Implemented** | `lib/runtime/order-manager/order-reconciler.ts`: wraps store + intentReconciler + orderManager; not used by StreamRuntime (StreamRuntime uses PaperOrderManagerâ€™s internal reconciler). |
| Intent â†’ Order Manager | **Implemented** | StreamRuntime `wireIntentAndFillHandlers()` subscribes to `order.intent.created`; gates with **central execution policy** (`isExecutionAllowed("runtime_automated")`); updates exposure, guardrails evaluate; if allowed, calls `orderManager.reconcileIntents([intent])` (with catch to record reconcile failures). |

**Files:** `lib/runtime/order-manager/order-lifecycle-store.ts`, `lib/runtime/order-manager/order-lifecycle-handler.ts`, `lib/runtime/order-manager/order-intent-reconciler.ts`, `lib/runtime/order-manager/paper-order-manager.ts`, `lib/runtime/order-manager/order-reconciler.ts`, `lib/runtime/trading-execution-policy.ts`.

---

### 2.11 Exchange adapter abstraction and paper adapter

| Item | Status | Notes |
|------|--------|--------|
| Adapter interface | **Implemented** | `lib/runtime/order-manager/order-exchange-adapter.ts`: `OrderExchangeAdapter` â€” submitOrder, cancelOrder, cancelOrders, getHealth; request/result types. |
| Paper adapter | **Implemented** | `PaperExchangeAdapter`: mock acks, optional latency/reject for testing. |
| Live stub | **Implemented** | `LivePolymarketAdapterStub`: submit/cancel return failure; getHealth reports not implemented. |
| Wired | **Implemented** | StreamRuntime and PaperOrderManager use `PaperExchangeAdapter` only. |

**Files:** `lib/runtime/order-manager/order-exchange-adapter.ts`.

---

### 2.12 Fill handling / partial fills / stale order sweeper

| Item | Status | Notes |
|------|--------|--------|
| Lifecycle handler | **Implemented** | Applies partial/full fill to store and emits `order.partial_fill` / `order.filled`. |
| User WS â†’ lifecycle | **Implemented** | `user-feed-to-runtime.ts` resolves exchangeOrderId â†’ clientOrderId and calls lifecycle handler for ack/partial_fill/fill/cancel/reject. |
| Stale sweeper | **Implemented** | `lib/runtime/order-manager/order-stale-sweeper.ts`: `DefaultOrderStaleSweeper` â€” pending_submit no ack, working too old, optional far-from-posture; sweep/sweepAndApply (emit order.stale, apply cancel via handler). |
| Wired | **Implemented** | StreamRuntime runs `staleSweeper.sweep()` on an interval (STALE_SWEEP_MS 60_000). |

**Files:** `lib/runtime/order-manager/order-lifecycle-handler.ts`, `lib/runtime/order-manager/order-stale-sweeper.ts`, `lib/live/user-feed-to-runtime.ts`, `worker/stream-runtime.ts`.

---

### 2.13 Wiring market WebSocket into Market State Engine

| Item | Status | Notes |
|------|--------|--------|
| Normalizer | **Implemented** | `normalizeMarketFeedMessage()` supports best_bid_ask, last_trade_price, book, price_change. |
| Feed to engine | **Implemented** | `feedNormalizedUpdatesToEngine(updates, marketStateEngine)` in market WS onMessage (both legacy and StreamRuntime WS paths). |
| Tracked assets | **Implemented** | `getTrackedAssetIds()`, `refreshTrackedAssetsAndSubscriptions()`, `marketStateEngine.setTrackedAssetIds(assetIds)`. |

**Files:** `lib/live/market-feed-normalizer.ts`, `worker/websockets.ts`.

---

### 2.14 Wiring user WebSocket into Order Manager (lifecycle only; position from events)

| Item | Status | Notes |
|------|--------|--------|
| User feed normalizer | **Implemented** | `lib/live/user-feed-normalizer.ts`: `normalizeUserFeedMessage()` â†’ lifecycle + optional positionFill (positionFill is **not** applied directly; see below). |
| User feed â†’ runtime | **Implemented** | `lib/live/user-feed-to-runtime.ts`: `feedUserFeedResultToRuntime()` â€” resolve by exchangeOrderId, **apply lifecycle only** to handler (ack/partial_fill/fill/cancel/reject). **No** `positionUpdater` in options; **positions are updated only from lifecycle events** (`order.partial_fill` and `order.filled`) in StreamRuntime subscribers, with idempotent delta from `order.appliedPositionFilledSize`. Telemetry: lifecycleApplied, unmatchedOrderEvents, lifecycleMismatch. |
| Wired | **Implemented** | Both `startWebsockets()` and `startWebsocketsWithRuntime()` set user WS onMessage â†’ normalize â†’ feedUserFeedResultToRuntime with orderStore, lifecycleHandler (**no** positionUpdater). |

**Files:** `lib/live/user-feed-normalizer.ts`, `lib/live/user-feed-to-runtime.ts`, `worker/websockets.ts`.

---

### 2.15 Read-only Bot Runtime evaluation with real live inputs

| Item | Status | Notes |
|------|--------|--------|
| Live inputs | **Implemented** | Context from market state store, position store, open orders (from order store), risk state; all fed from live WS and in-memory state. |
| Placeholder strategy | **Implemented** | Uses real health, liquidity, spread, position confidence, risk state; emits NOOP/CANCEL_ORDERS/UPDATE_QUOTES/REDUCE_RISK with reason codes. |
| Telemetry | **Implemented** | Every evaluation emits `bot.decision.evaluated`; optional intents emit `order.intent.created`. |

**Files:** `lib/runtime/bot-runtime/bot-runtime.ts`, `lib/runtime/bot-runtime/bot-context.ts`, `lib/runtime/bot-runtime/live-strategy-placeholder.ts`.

---

### 2.16 stream-runtime worker composition/orchestration

| Item | Status | Notes |
|------|--------|--------|
| Composition | **Implemented** | Single event bus, market store/engine, position store/updater, order store/lifecycle/reconciler/paper adapter, stale sweeper, risk engine, kill switch, bot runtime; all created in `StreamRuntime.start()`. |
| WS ownership | **Implemented** | `startWebsocketsWithRuntime(deps, funder)` uses runtime-owned deps; no duplicate engine/store creation. |
| Intervals | **Implemented** | Market state tick (10s), stale sweep (60s). |
| Shutdown | **Implemented** | stop() clears intervals, stops bot, stops WS, clears debug refs and deps. |

**Files:** `worker/stream-runtime.ts`, `worker/websockets.ts`, `worker/index.ts`.

---

### 2.17 Live backend surfaces for future Market Detail UI

| Item | Status | Notes |
|------|--------|--------|
| Market detail payload | **Implemented** | `lib/runtime/market-state/market-detail-live.ts`: `buildMarketDetailLivePayload(engine, assetId, botSummary, now)` â€” quote, spread, depthSummary, tradeTape.lastTrade, liquidity, volatility, health, botSummary. |
| API | **Implemented** | `GET /api/markets/live/detail?assetId=` uses debug engine and bot refs; returns `available: false` when engine not attached. |

**Files:** `lib/runtime/market-state/market-detail-live.ts`, `app/api/markets/live/detail/route.ts`.

---

### 2.18 Runtime telemetry / diagnostics / execution policy / rollout safeguards

| Item | Status | Notes |
|------|--------|--------|
| **Central execution policy** | **Implemented** | `lib/runtime/trading-execution-policy.ts`: `getTradingExecutionPolicy()`, `assertExecutionAllowed(surface)`, `isExecutionAllowed(surface)`, `getExecutionBlockedReasons(surface)`. Surfaces: `runtime_automated`, `manual_api`, `approval_queue`, `position_exit`. Automated allowed only when effective mode is paper/live_stub; live/manual not authorized. All real order paths (StreamRuntime intent handler, `lib/polymarket/trading.ts` place/cancel, API routes) use the policy. |
| Runtime config | **Implemented** | `lib/runtime/runtime-config.ts`: `RuntimeMode`, `ROLLOUT_ALLOWED_MODES`; mode from env (clamped); policy consumes config. `assertNoLiveOrderPlacement()` used in PaperOrderManager. |
| Diagnostics | **Implemented** | `lib/runtime/telemetry/runtime-diagnostics.ts`: `RuntimeDiagnosticsSnapshot` includes **reconcileFailureCount**, **lastReconcileFailureAt/Reason/IntentId**; `recordReconcileFailure()`, recordEvent, recordReconciliationAction, recordIntentBlockedByMode/ByGuardrails, recordPositionUpdate, etc. |
| Telemetry | **Partial** | `lib/runtime/telemetry/runtime-telemetry.ts`: `NoopRuntimeTelemetry` with TODO to connect to sinks. |
| Wired | **Implemented** | StreamRuntime passes diagnostics to PaperOrderManager; intent handler uses **execution policy** (`isExecutionAllowed("runtime_automated")`) and records block reasons; reconcile failures caught and recorded; dashboard/snapshot/health expose executionPolicy and diagnostics. |
| Health allowedModes / executionPolicy | **Implemented** | Health includes `executionPolicy`, `allowedModes`; dashboard/snapshot derive `liveTradingBlocked` and policy from heartbeat or `getTradingExecutionPolicy()`. |

**Files:** `lib/runtime/trading-execution-policy.ts`, `lib/runtime/runtime-config.ts`, `lib/runtime/telemetry/runtime-diagnostics.ts`, `lib/runtime/telemetry/runtime-telemetry.ts`, `lib/runtime/runtime-health.ts`, `lib/polymarket/trading.ts`, `app/api/orders/place/route.ts`, `app/api/orders/cancel/route.ts`, `app/api/bot/approval-queue/[id]/execute/route.ts`, `app/api/positions/place-exit/route.ts`.

---

### 2.19 Tests for execution-plane core

| Item | Status | Notes |
|------|--------|--------|
| Runtime core tests | **Implemented** | `lib/runtime/__tests__/runtime-core-tests.ts`: MarketStateStore, metrics, health, engine thresholds, BotScheduler, RuntimePositionUpdater, OrderLifecycleStore, OrderIntentReconciler, StaleOrderSweeper, DefaultRuntimeGuardrails. |
| Fill/position idempotency tests | **Implemented** | `lib/runtime/__tests__/fill-position-idempotency-tests.ts`: duplicate partial/filled, out-of-order, user-feed not double-updating, fill replay, transition guards, appliedPositionFilledSize. |
| Lifecycle/exposure hardening tests | **Implemented** | `lib/runtime/__tests__/lifecycle-exposure-hardening-tests.ts`: numeric invariants, partial-then-cancel, full-path correctness, exposure consistency. |
| Execution policy tests | **Implemented** | `lib/runtime/__tests__/trading-execution-policy-tests.ts`: policy and assertExecutionAllowed per surface. |
| Readiness/degraded tests | **Implemented** | `lib/runtime/__tests__/runtime-readiness-degraded-tests.ts`: StreamConnectionState, computeDegraded, scheduler backlog, reconcile failure capture, health shape. |

**Files:** `lib/runtime/__tests__/runtime-core-tests.ts`, `fill-position-idempotency-tests.ts`, `lifecycle-exposure-hardening-tests.ts`, `trading-execution-policy-tests.ts`, `runtime-readiness-degraded-tests.ts`.

---

### 2.20 Controlled rollout preparation for first real strategy enablement

| Item | Status | Notes |
|------|--------|--------|
| Mode in config | **Implemented** | Only disabled, observe_only, paper in `ROLLOUT_ALLOWED_MODES`; live/live_stub from env clamped to default; live not enableable via env alone. |
| **Enforced in code** | **Implemented** | **Central execution policy** gates all order-capable surfaces. StreamRuntime intent handler uses `isExecutionAllowed("runtime_automated")`; manual/API routes pass `executionSurface` to trading.ts and receive 403 when policy blocks. No path to live without explicit policy change. |
| Live adapter | **Stub** | Live adapter rejects all; no CLOB integration. Policy keeps live and manual execution blocked. |

**Files:** `lib/runtime/trading-execution-policy.ts`, `lib/runtime/runtime-config.ts`, `lib/runtime/order-manager/order-exchange-adapter.ts`, `lib/polymarket/trading.ts`, API routes for place/cancel/approval-queue/place-exit.

---

## 3. File-by-File Breakdown

| File | Purpose | Major exports | Production / test / scaffold |
|------|---------|----------------|-------------------------------|
| `worker/index.ts` | Worker entry; starts StreamRuntime or legacy WS + jobs | â€” | Production (startup) |
| `worker/stream-runtime.ts` | Composes full runtime; start/stop, health | StreamRuntime, StreamRuntimeOptions, StreamRuntimeDeps | Production |
| `worker/websockets.ts` | Market/user WS; normalizers â†’ engine/lifecycle/position | startWebsockets, startWebsocketsWithRuntime, stopWebsockets, getStreamRuntimeStatus, StreamRuntimeDepsForWs, userFeedRuntimeTelemetry | Production |
| `worker/heartbeat.ts` | Heartbeat with optional metadata | startHeartbeat, stopHeartbeat | Production |
| `worker/jobs.ts` | Delegates to lib/ops/scheduled-jobs | runJob, JOB_NAMES, JOB_INTERVALS_MS | Production |
| `lib/runtime/events/runtime-events.ts` | Normalized event types and payloads | RuntimeEventType, RuntimeEvent, createRuntimeEventId, *Payload types | Production |
| `lib/runtime/events/runtime-event-bus.ts` | In-memory bus | InMemoryRuntimeEventBus, RuntimeEventBus | Production |
| `lib/runtime/events/index.ts` | Re-exports events + bus | (re-exports) | Production |
| `lib/runtime/market-state/market-state-types.ts` | Asset state types and defaults | AssetLiveState, AssetLiveStatePatch, createEmptyAssetState | Production |
| `lib/runtime/market-state/market-state-store.ts` | In-memory market state | InMemoryMarketStateStore, MarketStateStore | Production |
| `lib/runtime/market-state/market-state-engine.ts` | Apply updates, tick, emit events | MarketStateEngine, *UpdateInput, DEFAULT_ENGINE_THRESHOLDS | Production |
| `lib/runtime/market-state/market-state-metrics.ts` | Derived metrics | deriveQuoteMetrics, deriveDepthImbalances, lastUpdateForAsset, computeLiquidityQualityScore, computeIsTradable | Production |
| `lib/runtime/market-state/market-state-health.ts` | Staleness/recovery | isStale, isDegraded, isRecovered, BasicMarketStateHealthChecker | Production |
| `lib/runtime/market-state/market-state-engine-debug.ts` | Debug ref + payload builder | setMarketStateEngineForDebug, getMarketStateEngineForDebug, buildMarketStateEngineDebugPayload, buildNoEngineDebugPayload | Production (ops APIs) |
| `lib/runtime/market-state/market-detail-live.ts` | UI payload from engine + bot | buildMarketDetailLivePayload, *MarketDetailLive* types | Production |
| `lib/runtime/order-manager/order-manager.ts` | Order types and manager interface | RuntimeOrderStatus, RuntimeOrderState, OrderIntent, OrderManager | Production |
| `lib/runtime/order-manager/order-lifecycle-store.ts` | In-memory order store | InMemoryOrderLifecycleStore, OrderLifecycleStore | Production |
| `lib/runtime/order-manager/order-lifecycle-handler.ts` | Apply lifecycle + emit events | DefaultOrderLifecycleHandler, OrderLifecycleHandler | Production |
| `lib/runtime/order-manager/order-intent-reconciler.ts` | Desired vs actual â†’ actions | DefaultOrderIntentReconciler, ReconcilerAction | Production |
| `lib/runtime/order-manager/paper-order-manager.ts` | Paper reconcile + adapter | PaperOrderManager | Production |
| `lib/runtime/order-manager/order-reconciler.ts` | Coordinator (orderManager.reconcileIntents) | OrderReconciler | Production (not used in StreamRuntime) |
| `lib/runtime/order-manager/order-exchange-adapter.ts` | Adapter interface + paper + live stub | OrderExchangeAdapter, PaperExchangeAdapter, LivePolymarketAdapterStub | Production |
| `lib/runtime/order-manager/order-stale-sweeper.ts` | Stale detection + sweepAndApply | DefaultOrderStaleSweeper, StaleOrderRecommendation | Production |
| `lib/runtime/risk/runtime-risk-engine.ts` | Risk state + limits | InMemoryRuntimeRiskEngine, createDefaultRuntimeRiskState, RuntimeRiskState | Production |
| `lib/runtime/risk/kill-switch.ts` | Global/per-asset halt | InMemoryKillSwitch, KillSwitch | Production |
| `lib/runtime/risk/runtime-guardrails.ts` | Pre-submit checks | DefaultRuntimeGuardrails, NoopRuntimeGuardrails, GuardrailVerdict | Production (not wired in order path) |
| `lib/runtime/positions/runtime-position-store.ts` | In-memory positions | InMemoryRuntimePositionStore, RuntimePositionStore, ApplyFillParams | Production |
| `lib/runtime/positions/runtime-position-updater.ts` | Fill â†’ store + position.changed | DefaultRuntimePositionUpdater, normalizedFillFromOrderFilled | Production |
| `lib/runtime/bot-runtime/bot-runtime.ts` | Event-driven bot, placeholder strategy | DefaultBotRuntime, BotRuntime | Production |
| `lib/runtime/bot-runtime/bot-scheduler.ts` | Coalesced queue, priority | EventDrivenBotScheduler, BotScheduler | Production |
| `lib/runtime/bot-runtime/bot-context.ts` | Snapshot + buildContext | DefaultBotRuntimeContextProvider, buildBotDecisionContext | Production |
| `lib/runtime/bot-runtime/bot-decision-types.ts` | Context/output/envelope types | BotDecisionContext, BotDecisionOutput, BotDecisionEnvelope | Production |
| `lib/runtime/bot-runtime/live-strategy-placeholder.ts` | Read-only strategy | evaluateLiveStrategyPlaceholder, LiveStrategyPlaceholderConfig | Production |
| `lib/runtime/bot-runtime/bot-runtime-debug.ts` | Debug ref + bot summary | setBotRuntimeForDebug, getBotRuntimeForDebug, getBotAssetSummaryForDetail | Production |
| `lib/live/market-feed-normalizer.ts` | Raw market WS â†’ engine inputs | normalizeMarketFeedMessage, feedNormalizedUpdatesToEngine | Production |
| `lib/live/user-feed-normalizer.ts` | Raw user WS â†’ normalized result | normalizeUserFeedMessage, NormalizedUserFeedResult | Production |
| `lib/live/user-feed-to-runtime.ts` | Apply user result to store/handler/updater | feedUserFeedResultToRuntime, UserFeedRuntimeTelemetry | Production |
| `lib/runtime/runtime-health.ts` | Health type and factory | RuntimeHealth, createRuntimeHealth, DEFAULT_RUNTIME_HEALTH | Production |
| `lib/runtime/runtime-config.ts` | Mode and rollout gates | RuntimeMode, ROLLOUT_ALLOWED_MODES, getRuntimeConfig, isLiveOrderPlacementAllowed, assertNoLiveOrderPlacement | Production |
| `lib/runtime/telemetry/runtime-diagnostics.ts` | Counters snapshot | DefaultRuntimeDiagnosticsCollector, RuntimeDiagnosticsSnapshot | Production (not passed to PaperOrderManager) |
| `lib/runtime/telemetry/runtime-telemetry.ts` | Telemetry interface | NoopRuntimeTelemetry (TODO) | Scaffold |
| `lib/runtime/telemetry/execution-metrics.ts` | Execution metrics types | ExecutionMetricsSnapshot, ExecutionMetricsCollector | Scaffold (interface only) |
| `app/api/ops/runtime/health/route.ts` | GET runtime health from heartbeat | â€” | Production |
| `app/api/ops/runtime/market-state/route.ts` | GET market state debug | â€” | Production |
| `app/api/markets/live/detail/route.ts` | GET market detail live | â€” | Production |
| `lib/runtime/__tests__/runtime-core-tests.ts` | Unit tests for runtime core | â€” | Test |

---

## 4. Runtime Flow Narrative

### Market WebSocket â†’ Market State

1. Worker starts market WS (or StreamRuntime does via `startWebsocketsWithRuntime`).
2. Tracked asset IDs come from `getTrackedAssetIds({ funderAddress })`; engine gets `setTrackedAssetIds(assetIds)`.
3. On each market WS message, `normalizeMarketFeedMessage(msg)` returns `NormalizedMarketUpdate[]` (quote/trade/depth).
4. `feedNormalizedUpdatesToEngine(updates, marketStateEngine)` calls engine `applyQuoteUpdate` / `applyTradeUpdate` / `applyDepthUpdate`.
5. Engine updates store (patchAsset), derives metrics/health, and may emit `market.quote.changed`, `market.depth.changed`, `market.trade.printed`, `market.liquidity.changed`, `market.stale`, `market.recovered`.
6. A timer in StreamRuntime (or in legacy WS path) calls `marketStateEngine.tick()` periodically for staleness.

### User WebSocket â†’ Order Manager (lifecycle only); Position from lifecycle events

1. User WS connects; on each message, `normalizeUserFeedMessage(funder, msg)` returns `NormalizedUserFeedResult` (lifecycle + optional positionFill; positionFill is **not** applied directly).
2. `feedUserFeedResultToRuntime(result, { orderStore, lifecycleHandler, log, telemetry })` runs â€” **no positionUpdater**; positions are updated only from lifecycle events in StreamRuntime.
3. If `result.lifecycle`: resolve `orderStore.getByExternalId(exchangeOrderId)` to get clientOrderId; then `lifecycleHandler.applyAck` / `applyPartialFill` / `applyFullFill` / `applyCancelAck` / `applyRejection`. Store is updated and `order.ack` / `order.partial_fill` / `order.filled` / `order.canceled` / `order.rejected` are emitted.
4. **Position updates:** StreamRuntime subscribes to `order.partial_fill` and `order.filled`. Each subscriber computes delta = eventFilledSize âˆ’ order.appliedPositionFilledSize; if delta > 0, calls `positionUpdater.applyFill(...)` then `orderStore.setAppliedPositionFilledSize(id, eventFilledSize)` (capped to order.filledSize). Duplicate or replay events are idempotent.

### Bot Runtime signals

1. Bot subscribes to market.*, position.changed, order.partial_fill, order.filled, order.stale, regime.changed, risk.*.
2. On each event it enqueues assetId (with priority) on the scheduler.
3. After coalesce window, scheduler drains queue and for each asset calls `handleDecision(envelope)`.
4. Context is built from snapshot (market store, position store, risk state, open orders); `evaluateLiveStrategyPlaceholder(context, config)` returns a decision.
5. Bot emits `bot.decision.evaluated` every time; if action is PLACE_ENTRY/PLACE_EXIT/UPDATE_QUOTES it also emits `order.intent.created` with intent payload.

### Order Manager response

- **Implemented:** StreamRuntime `wireIntentAndFillHandlers()` subscribes to `order.intent.created`. On event: map to OrderIntent; gate with **central execution policy** (`isExecutionAllowed("runtime_automated")`); update exposure via `updateRiskExposureFromStores`; sync context provider risk state; build context and run guardrails; if verdict allowed, call `orderManager.reconcileIntents([intent])` (with `.catch()` to record reconcile failures in diagnostics). Reconciler produces KEEP/PLACE/CANCEL/CANCEL_REPLACE; PaperOrderManager applies via paper adapter and lifecycle handler.

### Health / debug / telemetry

- **Health:** When StreamRuntime is running, heartbeatâ€™s `getMetadata` returns `{ runtimeHealth: streamRuntime.getHealth() }`. Health includes **lifecycleStatus**, **streams.marketConnection** / **userConnection** (real state: status, lastOpenAt, lastMessageAt, reconnectAttempts), **operationalReadiness**, **degradedReasons** (from `computeDegraded`), **counts.schedulerBacklog** from bot, **diagnostics** (including reconcileFailureCount, lastReconcileFailureAt/Reason/IntentId), **executionPolicy**, components, counts. Dashboard/snapshot APIs use policy for liveTradingBlocked and real stream state. `GET /api/ops/runtime/health` reads latest heartbeat from DB and returns that runtimeHealth.
- **Debug:** `getMarketStateEngineForDebug()` and `getBotRuntimeForDebug()` are set when StreamRuntime starts. `GET /api/ops/runtime/market-state` and `GET /api/markets/live/detail?assetId=` use these to return engine state and bot summary.
- **Diagnostics:** `DefaultRuntimeDiagnosticsCollector` is instantiated in StreamRuntime and passed to PaperOrderManager; intent and fill handlers record events, block reasons, position updates; reconcile failures are caught and recorded via `diagnostics.recordReconcileFailure()`.

---

## 5. Architecture Assessment

- **Execution vs projection:** Execution plane is explicit: in-memory market state, position store, order lifecycle store, risk state. Canonical portfolio (DerivedPosition, recompute) is separate and debounced; comments in position store and updater state this.
- **In-memory state ownership:** One event bus, one market store/engine, one position store, one order store, one risk engine, one kill switch per process. StreamRuntime owns all and passes them into WS and bot; no duplicate creation when using `startWebsocketsWithRuntime`.
- **Event-driven design:** Market and user WS push into engine and order/position layers; engine and lifecycle handler emit events; bot and (intended) order-intent consumer react to events. Error isolation in bus handlers.
- **Order lifecycle:** Create â†’ pending_submit; ack â†’ working; partial/full fill â†’ partially_filled/filled; cancel/reject applied via handler; store and events stay in sync. User WS is the source of truth for real exchange acks/fills/cancels.
- **Risk gating:** Kill switch is applied to risk state and used in bot context. Guardrails run in the intent handler before `reconcileIntents`; exposure is updated from stores at start of each intent handling.
- **Rollout / execution policy:** **Central execution policy** (`lib/runtime/trading-execution-policy.ts`) gates all order-capable surfaces (runtime_automated, manual_api, approval_queue, position_exit). StreamRuntime intent handler and all API/place/cancel routes use the policy; live and manual execution are not authorized (fail-closed).

**Gaps (qualified):** appliedPositionFilledSize in-memory only (restart/replay durability limited); pending_cancel not actively set; telemetry sinks not connected.

---

## 6. Safety Assessment

**Present:**

- **Central execution policy:** All order-capable paths (StreamRuntime intent path, manual place/cancel, approval-queue execute, position exit) call `assertExecutionAllowed(surface)` or equivalent; live and manual execution are not authorized; dashboard/health derive liveTradingBlocked from policy.
- **Paper-only automated path:** StreamRuntime uses `PaperExchangeAdapter` only; intent handler gates with `isExecutionAllowed("runtime_automated")`; no live adapter in use.
- **Kill switch:** In-memory kill switch; global stop when `globalAutomationDisabledByDefault`; bot and guardrails respect kill switch state.
- **Guardrails before execution:** Intent handler runs guardrails before `reconcileIntents`; blocked verdict prevents submission.
- **Exposure updates:** `updateRiskExposureFromStores` runs at start of each intent handling; risk state and context provider are updated before guardrails.
- **Lifecycle-driven position updates:** Positions updated only from `order.partial_fill` and `order.filled` subscribers; idempotent via `appliedPositionFilledSize`; user-feed path does not apply position directly.
- **Reconciliation failure capture:** `reconcileIntents` failures caught and recorded in diagnostics (reconcileFailureCount, lastReconcileFailureAt/Reason/IntentId).

**Remaining limitations:**

- **appliedPositionFilledSize** is in-memory only; restart/replay can re-apply fills unless store or field is persisted.
- **pending_cancel** status exists but is not actively set by current code.
- No circuit breaker or rate limit around reconciliation (only coalesce in bot scheduler).

---

## 7. Testing Assessment

- **Existing tests:** `lib/runtime/__tests__/runtime-core-tests.ts` â€” MarketStateStore (upsert, patch, clone), metric helpers (mid, spread, imbalance), health (stale/degraded/recovered), MarketStateEngine thresholds (quote event emission), EventDrivenBotScheduler (coalesce, priority), DefaultRuntimePositionUpdater (applyFill, position.changed), OrderLifecycleStore (create, ack, partial/full fill, cancel), DefaultOrderIntentReconciler (KEEP/CANCEL from intents vs working), DefaultOrderStaleSweeper (stale pending_submit), DefaultRuntimeGuardrails (blocked when exchange unhealthy).
- **Covered:** Core stores, engine emission thresholds, scheduler, position updater, order lifecycle, reconciler, sweeper, guardrails in isolation.
- **Also covered (post-hardening):** fill-position-idempotency, lifecycle-exposure-hardening, trading-execution-policy, runtime-readiness-degraded tests. **Not covered:** Full end-to-end StreamRuntime start/stop with real WS; event path from WS â†’ engine â†’ bot â†’ (intent) â†’ order manager; guardrails in the order path; kill switch integration; risk exposure updates; runtime config enforcement; market-feed-normalizer or user-feed-to-runtime with real payloads; API routes.

---

## 8. Known Gaps / Unfinished Work (post-hardening)

- **appliedPositionFilledSize in-memory only:** Idempotency is per order record in the lifecycle store; after process restart, replay of the same fill events would re-apply unless the store (or appliedPositionFilledSize) is persisted. Restart/replay durability is limited.
- **pending_cancel:** Status exists in the lifecycle model but is not actively set by current code paths.
- **Telemetry:** `NoopRuntimeTelemetry` and TODO to connect execution telemetry/analytics to external sinks.
- **Live adapter:** Stub only; no Polymarket CLOB submit/cancel. No path to live without explicit policy change; all surfaces gated by central execution policy.
- **Regime:** `regime.changed` is in event types and bot subscribes; no producer for it in the codebase (regime scanner not wired to bus).
- **Volatility in engine:** Volatility block in asset state and metrics placeholders exist; engine does not compute or update volatility from a rolling window (only from explicit patches).

---

## 9. Recommended Next Steps (post-hardening)

1. **Persist appliedPositionFilledSize (or order store):** If restart/replay durability is required, persist the lifecycle store or at least `appliedPositionFilledSize` so replay of fill events after restart remains idempotent.
2. **Wire pending_cancel:** If cancel-ack flow should set `pending_cancel` before terminal cancel, add the transition in lifecycle handler and store.
3. **Connect telemetry sinks:** Replace or extend `NoopRuntimeTelemetry` so execution telemetry/analytics are exported.
4. **Tests:** Additional integration-style tests for: full WS â†’ engine â†’ bot â†’ intent â†’ order manager â†’ fill â†’ position path; guardrails in the order path; exposure consistency after partial-then-cancel.

---

## 10. Evidence-Based Summary

- **Event bus:** Used throughout; types in `runtime-events.ts`, implementation in `runtime-event-bus.ts`; StreamRuntime and websockets use one bus.
- **Market flow:** `worker/websockets.ts` (e.g. lines 86â€“88, 166â€“168, 283â€“285) normalizes market messages and calls `feedNormalizedUpdatesToEngine(updates, marketStateEngine)`.
- **User flow:** `worker/websockets.ts` (e.g. 141â€“148, 209â€“216) passes orderStore, lifecycleHandler, positionUpdater into `feedUserFeedResultToRuntime`.
- **Intent emission:** `lib/runtime/bot-runtime/bot-runtime.ts` (lines 199â€“215) publishes `order.intent.created` when strategy returns PLACE_ENTRY/PLACE_EXIT/UPDATE_QUOTES.
- **Intent consumer:** `worker/stream-runtime.ts` `wireIntentAndFillHandlers()` subscribes to `order.intent.created` and calls `orderManager.reconcileIntents([intent])` after execution policy and guardrails.
- **Guardrails:** Intent handler in stream-runtime calls `guardrails.evaluate()` before `reconcileIntents`.
- **updateExposure:** `lib/runtime/runtime-exposure.ts` `updateRiskExposureFromStores()` calls `riskEngine.updateExposure()`; invoked at start of each intent handling.
- **Execution policy:** `lib/polymarket/trading.ts` placeLimitOrder/cancelOrderByPolymarketId call `assertExecutionAllowed(options.executionSurface)`; API routes pass executionSurface; dashboard/snapshot use `getTradingExecutionPolicy()` for liveTradingBlocked.
- **Health API:** `app/api/ops/runtime/health/route.ts` reads heartbeat from Prisma and returns `metadata.runtimeHealth` (with lifecycleStatus, stream connection state, operationalReadiness, degradedReasons, executionPolicy) when present.

---

## Final Verdict

- **Current maturity:** **Paper-ready with closed-loop and hardened health.** Intent â†’ order manager wired; guardrails and exposure run before reconciliation; positions updated only from lifecycle events (order.partial_fill / order.filled) with idempotent delta from `appliedPositionFilledSize`; central execution policy gates all order-capable surfaces; health reflects lifecycleStatus, real stream state, operationalReadiness, degradedReasons, real schedulerBacklog, reconcile failure diagnostics, and executionPolicy.
- **Biggest strengths:** Central execution policy (single source of truth for all surfaces), lifecycle-driven fill pipeline with idempotency and numeric invariants, truthful readiness/health (stream connection state, degraded rules, real backlog), guardrails and exposure in the execution path, diagnostics and reconcile failure capture.
- **Remaining limitations (qualified):** appliedPositionFilledSize in-memory only (restart/replay durability limited); pending_cancel not actively set; live adapter stub; no path to live without explicit policy change.
