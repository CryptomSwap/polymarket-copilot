# Runtime Closed-Loop Fixes — Implementation Summary

**Date:** Implementation of the five execution-path blockers for safe closed-loop paper trading.

**Document status:** Verified against implementation after execution-policy, readiness/degraded-state, and fill-idempotency hardening. Central execution policy and lifecycle-driven fill pipeline are reflected below.

---

## 1. Files Changed

| File | Change |
|------|--------|
| `lib/runtime/runtime-config.ts` | Added `isPaperOrLiveStubExecutionAllowed(config?)`: true only for `paper` and `live_stub`; used to gate intent → order manager execution. |
| `lib/runtime/runtime-exposure.ts` | **New.** `updateRiskExposureFromStores(riskEngine, positionStore, orderStore)` computes gross exposure and working order count from stores and calls `riskEngine.updateExposure()`. Net exposure set to 0 (see limitations). |
| `worker/stream-runtime.ts` | Added intent and fill wiring: `DefaultRuntimeGuardrails`, `DefaultRuntimeDiagnosticsCollector`, `contextProvider` and `guardrails` in deps; `wireIntentAndFillHandlers()` subscribes to `order.intent.created` (mode check → exposure update → guardrails → `reconcileIntents`) and `order.filled` (→ `positionUpdater.applyFill`). Unsubscribes on `stop()`. |
| `lib/runtime/order-manager/paper-order-manager.ts` | At start of `reconcileIntents()`: `assertNoLiveOrderPlacement()` and throw if `adapter.getHealth().mode === "live"`. Diagnostics collector optional wiring (StreamRuntime now passes one). |
| `lib/runtime/__tests__/runtime-core-tests.ts` | Fixed existing BotScheduler snapshot type to use `marketStateStore`/`positionStore`. Added tests: runtime mode execution gate, exposure update from stores, order.filled → position store, PaperOrderManager rejects live adapter, assertNoLiveOrderPlacement for live mode, intent → OrderManager in paper mode (integration-style). Added imports: `DefaultOrderLifecycleHandler`, `buildBotDecisionContext`, `DefaultBotRuntimeContextProvider`, `OrderIntentCreatedPayload`, `RuntimeConfig`, `ROLLOUT_ALLOWED_MODES`, `updateRiskExposureFromStores`, `normalizedFillFromOrderFilled`, `PaperOrderManager`, `PaperExchangeAdapter`, `LivePolymarketAdapterStub`, `InMemoryRuntimeRiskEngine`. |

---

## 2. How Each Blocker Was Fixed

### Blocker 1: Intent → Order Manager not wired

- **Where:** `worker/stream-runtime.ts`, in `wireIntentAndFillHandlers()`.
- **What:** Subscribed to `order.intent.created`. On event: map payload to `OrderIntent`; gate with `isPaperOrLiveStubExecutionAllowed(config)` and `config.mode !== "live"`; call `updateRiskExposureFromStores()`; sync `contextProvider.updateRiskState(riskEngine.getState())`; build `BotDecisionContext` via `buildBotDecisionContext(snapshot, …)`; build a minimal `BotDecisionOutput` (e.g. `UPDATE_QUOTES`); run `guardrails.evaluate(context, riskState, proposedAction)`; if `verdict === "allowed"`, call `orderManager.reconcileIntents([intent])`.
- **Idempotency:** Single intent per event; reconciler is deterministic (KEEP/PLACE/CANCEL/CANCEL_REPLACE). No batching; one intent per `order.intent.created`.

### Blocker 2: Guardrails and risk exposure not in execution path

- **Guardrails:** `DefaultRuntimeGuardrails` is created in StreamRuntime with `eventBus` and stored in deps. The intent handler calls `guardrails.evaluate(context, riskEngine.getState(), proposedAction)` before `reconcileIntents`. If `verdict !== "allowed"`, the handler returns without calling the order manager; `risk.limit_hit` is still emitted by guardrails when limits are breached.
- **Exposure:** `updateRiskExposureFromStores(riskEngine, positionStore, orderStore)` is called at the start of each intent handling. It sums `positionStore.getAll().exposureNotional` for gross exposure and counts open orders for `workingOrderCount`, then calls `riskEngine.updateExposure(grossExposure, 0, workingOrderCount)`. Net exposure is not computed (left 0); see limitations below.

### Blocker 3: Live adapter remains stub / paper-only executable

- **Config:** `getRuntimeConfig()` still only allows `disabled`, `observe_only`, `paper` (env `RUNTIME_MODE`). `live` / `live_stub` from env are clamped to `DEFAULT_RUNTIME_MODE`, so runtime never starts in `live` from env.
- **Execution gate:** Intent handler only runs reconciliation when `isPaperOrLiveStubExecutionAllowed(config)` is true (i.e. `paper` or `live_stub`) and explicitly returns when `config.mode === "live"` (fail-closed if live ever became allowed elsewhere).
- **Adapter boundary:** In `PaperOrderManager.reconcileIntents()`: `assertNoLiveOrderPlacement()` throws if config allows live; then if `adapter.getHealth().mode === "live"` we throw with a clear message. StreamRuntime only constructs `PaperExchangeAdapter`; no live adapter is ever passed in.

### Blocker 4: Runtime mode not enforced

- **Where:** Intent handler in `wireIntentAndFillHandlers()` and (defensively) in `PaperOrderManager`.
- **Behavior:**  
  - **disabled:** Bot is still started by StreamRuntime; intent handler does not run reconciliation because `isPaperOrLiveStubExecutionAllowed` is false.  
  - **observe_only:** Same: execution path is not entered; no `reconcileIntents` call.  
  - **paper:** Execution allowed; only paper adapter is used.  
  - **live_stub:** Treated like paper for execution gating (no real orders).  
  - **live:** Intent handler returns without reconciling; if reconciliation were ever called (e.g. misuse), `assertNoLiveOrderPlacement()` and adapter health check would throw.
- **Defense in depth:** Mode check in intent handler; `assertNoLiveOrderPlacement()` and adapter mode check in `PaperOrderManager.reconcileIntents()`.

### Blocker 5: order.filled / order.partial_fill → Runtime Position Updater (lifecycle-driven, idempotent)

- **Where:** `worker/stream-runtime.ts`, `wireIntentAndFillHandlers()`.
- **What:** Positions are updated **only from lifecycle events**; the user-feed path **no longer** calls `positionUpdater.applyFill()`. StreamRuntime subscribes to both `order.partial_fill` and `order.filled`. For each event, delta = eventFilledSize − order.appliedPositionFilledSize (from the order lifecycle record); if delta > 0, `positionUpdater.applyFill(...)` then `orderStore.setAppliedPositionFilledSize(id, eventFilledSize)` (capped to order.filledSize). Duplicate or replay events are idempotent; `appliedPositionFilledSize` is **not** cleared on order.filled.
- **Central execution policy:** All order-capable surfaces (runtime_automated, manual_api, approval_queue, position_exit) are gated by `lib/runtime/trading-execution-policy.ts`; manual/API routes pass `executionSurface` and call `assertExecutionAllowed(surface)`; dashboard/health use policy for liveTradingBlocked.

---

## 3. Remaining Limitations Before Real Live Trading

- **Net exposure:** Single-funder view; multi-funder would require per-funder aggregation if needed.
- **Partial fills:** Both `order.partial_fill` and `order.filled` are subscribed; delta from `order.appliedPositionFilledSize`; position store updated incrementally and idempotently.
- **appliedPositionFilledSize in-memory only:** Restart/replay durability limited unless store or field persisted. **pending_cancel:** Exists but not actively set. **Live adapter:** Still a stub. No path to live without explicit policy change.
- **Regime / volatility:** Not changed; regime and volatility wiring remain as before.
- **Tests:** runtime-core-tests, fill-position-idempotency-tests, lifecycle-exposure-hardening-tests, trading-execution-policy-tests, runtime-readiness-degraded-tests. Running them may require the project’s tsconfig (e.g. `tsconfig.tests.json`) and target/downlevelIteration settings; some pre-existing tsc errors in other files are unrelated to these changes.

---

## 4. Evidence of Wiring (No TODOs)

- Intent path: `stream-runtime.ts` subscribes to `order.intent.created` and calls `orderManager.reconcileIntents([intent])` after mode and guardrails.
- Fill path: same file subscribes to `order.partial_fill` and `order.filled`; delta = eventFilledSize − order.appliedPositionFilledSize; applyFill(delta) then setAppliedPositionFilledSize (capped); user-feed path does not apply position directly.
- Exposure: `updateRiskExposureFromStores` is called in the intent handler before guardrails; `contextProvider.updateRiskState(riskEngine.getState())` keeps bot context in sync.
- Mode / execution policy: Intent handler uses `isExecutionAllowed("runtime_automated")`; manual/API routes use `assertExecutionAllowed(surface)` via `lib/polymarket/trading.ts`; dashboard/health use `getTradingExecutionPolicy()` for liveTradingBlocked.
- Guardrails: `DefaultRuntimeGuardrails` is constructed and `evaluate()` is invoked before every reconciliation in the intent handler.

---

## 5. Safe Closed-Loop Paper Behavior After Changes

1. Market and user WebSockets feed market state and order/position lifecycle as before.
2. Bot evaluates and emits `bot.decision.evaluated` and, when strategy returns a tradable action, `order.intent.created`.
3. Intent handler runs only when `isPaperOrLiveStubExecutionAllowed(config)` and `config.mode !== "live"`; it updates risk exposure, syncs context provider risk state, runs guardrails; if allowed, calls `orderManager.reconcileIntents([intent])`.
4. PaperOrderManager rejects live adapter and asserts no live placement; it uses only the paper adapter to create/ack/cancel orders and emits order lifecycle events.
5. On `order.partial_fill` and `order.filled`, the position updater applies only the delta (eventFilledSize − appliedPositionFilledSize) to the runtime position store and updates appliedPositionFilledSize (idempotent for duplicates/replay).
6. Stale sweeper and market tick continue to run as before. No Prisma on the hot path; no live exchange submission.
