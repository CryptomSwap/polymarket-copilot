# Polymarket Copilot — Runtime Mode & Execution Safety Audit

**Audit date:** 2025-03-10  
**Scope:** Trading mode source of truth, paper vs live adapter selection, kill switch, order-capable call paths, config/env parsing, central vs scattered checks, live fail-closed behavior.

---

## 1. File List (Relevant to Runtime Mode & Execution Safety)

| File | Role |
|------|------|
| `lib/runtime/runtime-config.ts` | **Source of truth** for mode: env parsing, ROLLOUT_ALLOWED_MODES, getRuntimeConfig, isPaperOrLiveStubExecutionAllowed, assertNoLiveOrderPlacement |
| `worker/stream-runtime.ts` | Composes runtime; intent handler (mode gate, guardrails); **only** constructs PaperExchangeAdapter |
| `worker/index.ts` | Worker entry; instantiates StreamRuntime with paperMode: true, globalAutomationDisabledByDefault: true |
| `lib/runtime/order-manager/paper-order-manager.ts` | reconcileIntents: assertNoLiveOrderPlacement + adapter health check; applyAction → submitOrder/cancelOrder |
| `lib/runtime/order-manager/order-exchange-adapter.ts` | PaperExchangeAdapter, LivePolymarketAdapterStub, NoopOrderExchangeAdapter; getHealth().mode |
| `lib/runtime/order-manager/order-intent-reconciler.ts` | Produces actions (KEEP/PLACE/CANCEL/CANCEL_REPLACE); no env/mode checks |
| `lib/runtime/order-manager/order-stale-sweeper.ts` | sweep/sweepAndApply: only lifecycleHandler.applyCancelAck (store + events); **no** adapter.submitOrder/cancelOrder |
| `lib/runtime/order-manager/order-reconciler.ts` | High-level wrapper that calls orderManager.reconcileIntents; **not used** by StreamRuntime (dead/alternate path) |
| `lib/runtime/risk/kill-switch.ts` | InMemoryKillSwitch: global/per-asset halt; risk.kill_switch_changed |
| `lib/runtime/risk/runtime-guardrails.ts` | Guardrails: kill switch, exchange health, market/position; blocks before reconcileIntents |
| `lib/runtime/risk/runtime-risk-engine.ts` | Risk state (globalAutomationEnabled, limits); applied by kill switch |
| `lib/runtime/bot-runtime/bot-runtime.ts` | Emits order.intent.created; no mode check (consumer is intent handler) |
| `lib/runtime/runtime-health.ts` | createRuntimeHealth; runtimeMode, mode, allowedModes |
| `lib/runtime/telemetry/runtime-diagnostics.ts` | recordIntentBlockedByMode, reconciliation actions |
| `app/api/ops/runtime/dashboard/route.ts` | GET dashboard; liveTradingBlocked: true hardcoded; adapterMode from health |
| `app/api/ops/runtime/snapshot/route.ts` | Snapshot; adapterMode from health |
| `lib/polymarket/trading.ts` | placeLimitOrder, cancelOrderByPolymarketId — **real CLOB**; no RUNTIME_MODE check |
| `app/api/orders/place/route.ts` | POST place → placeLimitOrder (live CLOB) |
| `app/api/orders/cancel/route.ts` | POST cancel → cancelOrderByPolymarketId (live CLOB) |
| `app/api/bot/approval-queue/[id]/execute/route.ts` | POST execute → placeLimitOrder (live CLOB) |
| `app/api/positions/place-exit/route.ts` | place-exit → placeLimitOrder (live CLOB) |
| `lib/runtime/__tests__/runtime-core-tests.ts` | Tests: isPaperOrLiveStubExecutionAllowed, assertNoLiveOrderPlacement, live adapter rejection, intent→reconcile |

---

## 2. Key Functions / Classes

### 2.1 Trading mode source of truth

- **`getRuntimeConfig(): RuntimeConfig`** — `lib/runtime/runtime-config.ts`  
  Reads `process.env.RUNTIME_MODE`, validates against `ROLLOUT_ALLOWED_MODES` (`disabled` | `observe_only` | `paper`).  
  **Clamping:** `live` and `live_stub` from env are **rejected** and replaced with `DEFAULT_RUNTIME_MODE` ("paper").

```39:49:lib/runtime/runtime-config.ts
function modeFromEnv(): RuntimeMode {
  const raw = typeof process !== "undefined" ? process.env[ENV_KEY]?.trim().toLowerCase() : "";
  if (raw === "disabled" || raw === "observe_only" || raw === "paper") return raw;
  if (raw === "live_stub" || raw === "live") {
    // Explicitly not in rollout; treat as invalid and use default.
    return DEFAULT_RUNTIME_MODE;
  }
  return DEFAULT_RUNTIME_MODE;
}
```

- **`isPaperOrLiveStubExecutionAllowed(config?)`** — true only for `paper` or `live_stub`. Used to gate reconciliation in the intent handler.
- **`assertNoLiveOrderPlacement(config?)`** — throws if `config.mode === "live"`. Used at start of `PaperOrderManager.reconcileIntents()` (no arg → uses getRuntimeConfig()).

### 2.2 Paper vs live adapter selection

- **StreamRuntime** builds a **single** adapter and passes it to PaperOrderManager:

```128:138:worker/stream-runtime.ts
    const orderStore = new InMemoryOrderLifecycleStore();
    const orderLifecycleHandler = new DefaultOrderLifecycleHandler({ store: orderStore, eventBus });
    const exchangeAdapter = new PaperExchangeAdapter();
    const intentReconciler = new DefaultOrderIntentReconciler();
    const diagnostics = new DefaultRuntimeDiagnosticsCollector();
    const orderManager = new PaperOrderManager({
      store: orderStore,
      reconciler: intentReconciler,
      adapter: exchangeAdapter,
      ...
```

There is **no** branch on env or config that injects a live adapter; the worker always uses `PaperExchangeAdapter`.

- **PaperOrderManager** rejects a live adapter at runtime if one were ever passed:

```45:51:lib/runtime/order-manager/paper-order-manager.ts
    assertNoLiveOrderPlacement();
    const adapterHealth = this.options.adapter?.getHealth?.();
    if (adapterHealth?.mode === "live") {
      throw new Error(
        "[PaperOrderManager] Live adapter not allowed. Only paper adapter may execute; real exchange submission is disabled."
      );
    }
```

### 2.3 Kill switch / trading disable logic

- **InMemoryKillSwitch** — `lib/runtime/risk/kill-switch.ts`  
  - `setGlobalStop(reason)`, `clearGlobalStop()`; per-asset `halt(assetId)`, `resume(assetId)`.  
  - Emits `risk.kill_switch_changed`; state applied to risk engine via `applyToRiskState()` (caller’s responsibility).

- **StreamRuntime** creates kill switch and sets global stop by default:

```122:124:worker/stream-runtime.ts
    if (this.options.globalAutomationDisabledByDefault) {
      killSwitch.setGlobalStop("stream_runtime_default_safe");
    }
```

- **Worker** passes default options:

```95:98:worker/index.ts
    streamRuntime = new StreamRuntime({
      paperMode: true,
      globalAutomationDisabledByDefault: true,
    });
```

- **Guardrails** block execution when kill switch is on:

```131:136:lib/runtime/risk/runtime-guardrails.ts
    if (!riskState.globalAutomationEnabled) {
      codes.push(GUARDRAIL_REASON_CODES.KILL_SWITCH_GLOBAL);
    }
    if (assetId && riskState.haltedAssetIds.includes(assetId)) {
      codes.push(GUARDRAIL_REASON_CODES.KILL_SWITCH_ASSET);
    }
```

- **Intent handler** runs guardrails **before** calling `reconcileIntents`; if verdict is not "allowed", it returns and never calls `orderManager.reconcileIntents`. So kill switch blocks the only path that can create orders in the StreamRuntime pipeline.

---

## 3. Order-Capable Call Graph

### 3.1 StreamRuntime (automated) path — paper only

Single path that can create/update orders in the runtime:

1. **Bot** evaluates → emits `order.intent.created`  
   - `lib/runtime/bot-runtime/bot-runtime.ts`: `emitIntentIfNeeded()` publishes `order.intent.created`.

2. **Intent handler** (stream-runtime.ts) subscribes to `order.intent.created`:
   - `getRuntimeConfig()`; if `!isPaperOrLiveStubExecutionAllowed(config)` → **return** (no reconcile).
   - If `config.mode === "live"` → **return** (fail-closed).
   - `updateRiskExposureFromStores`; `contextProvider.updateRiskState`; build context; `guardrails.evaluate`.
   - If `result.verdict !== "allowed"` → **return**.
   - `void orderManager.reconcileIntents([intent])`.

3. **PaperOrderManager.reconcileIntents**:
   - `assertNoLiveOrderPlacement()` (throws if mode were "live").
   - If `adapter.getHealth().mode === "live"` → **throw**.
   - `reconciler.reconcile(intents, workingOrders)` → list of actions.
   - For each action: `applyAction` → **PLACE**: `store.create` + `adapter.submitOrder` (+ lifecycle ack/reject); **CANCEL**: `adapter.cancelOrder`; **CANCEL_REPLACE**: cancel then submit.

So the **only** call path that can place/submit orders in the StreamRuntime is:

`order.intent.created` → intent handler (mode + guardrails) → `PaperOrderManager.reconcileIntents` → `applyAction` → `adapter.submitOrder` / `adapter.cancelOrder`.

The adapter is always `PaperExchangeAdapter` in production startup; no live adapter is ever passed.

### 3.2 Stale sweeper

- **DefaultOrderStaleSweeper.sweepAndApply** — only emits `order.stale` and calls `lifecycleHandler.applyCancelAck(...)`.  
- It does **not** call `adapter.cancelOrder` or `adapter.submitOrder`. Cancels are store/event only (paper state).

### 3.3 Manual / API paths (real CLOB; no RUNTIME_MODE)

These can place or cancel **real** Polymarket orders; they do **not** read `RUNTIME_MODE` or StreamRuntime:

| Entry | Function | Effect |
|-------|----------|--------|
| `POST /api/orders/place` | `placeLimitOrder` | Real CLOB place |
| `POST /api/orders/cancel` | `cancelOrderByPolymarketId` | Real CLOB cancel |
| `POST /api/bot/approval-queue/[id]/execute` | `placeLimitOrder` | Real CLOB place |
| `app/api/positions/place-exit` | `placeLimitOrder` | Real CLOB place |

So: **automated** flow is mode-gated and paper-only; **manual/API** flow is separate and can do live orders regardless of runtime mode.

### 3.4 OrderReconciler (unused by StreamRuntime)

- `lib/runtime/order-manager/order-reconciler.ts`: `OrderReconciler.reconcile()` calls `orderManager.reconcileIntents(intents)`.  
- **Not referenced** in `worker/stream-runtime.ts` or `worker/index.ts`. So this is an alternate/dead path; if something called it with the same PaperOrderManager, the same safety checks (assertNoLiveOrderPlacement + adapter health) would apply.

### 3.5 Store-only “create” (no exchange)

- **OrderLifecycleStore.create** — in-memory only; used by PaperOrderManager inside `applyAction` for PLACE/CANCEL_REPLACE before/after calling the adapter. Not an independent order-capable path; it’s part of the single path above.

---

## 4. Configuration / Env Parsing (Trading Mode)

- **Env key:** `RUNTIME_MODE` (see `runtime-config.ts`).
- **Parsing:** `modeFromEnv()` trims and lowercases; accepts only `disabled` | `observe_only` | `paper`. Any other value (including `live`, `live_stub`) → `DEFAULT_RUNTIME_MODE` ("paper").
- **Usage:** Only `getRuntimeConfig()` reads env; callers use `getRuntimeConfig().mode` or helpers that take optional `RuntimeConfig`.
- **StreamRuntime options** (worker): `paperMode`, `globalAutomationDisabledByDefault` are **constructor options**, not read from env in stream-runtime.ts. Worker hardcodes `paperMode: true` and `globalAutomationDisabledByDefault: true`.

So: **trading mode** for the automated pipeline comes from **env `RUNTIME_MODE`** via `getRuntimeConfig()`; **adapter choice** is **hardcoded** (PaperExchangeAdapter) in StreamRuntime.

---

## 5. Central vs Scattered Mode Checks

- **Central:**  
  - **Intent handler** (single place) gates reconciliation: `isPaperOrLiveStubExecutionAllowed(config)` and `config.mode === "live"`.  
  - **PaperOrderManager.reconcileIntents** (single entry to order execution): `assertNoLiveOrderPlacement()` and `adapter.getHealth().mode === "live"`.

- **Scattered / derived:**  
  - **Health/dashboard:** `getHealth()` uses both `getRuntimeConfig().mode` (as `runtimeMode`) and `this.options.paperMode` (as `mode`). So there are two concepts: env-derived runtime mode vs “adapter is paper” flag.  
  - **Dashboard API** always returns `liveTradingBlocked: true` (hardcoded).  
  - No other code paths that create orders in the runtime read mode in a scattered way; the only path to `reconcileIntents` is the intent handler.

So mode is checked **centrally** at the intent-handler boundary and at the entry to `reconcileIntents`; elsewhere it’s either derived from the same config (health) or hardcoded (dashboard).

---

## 6. Is Live Truly Fail-Closed?

**Yes, for the automated StreamRuntime path:**

1. **Config:** `getRuntimeConfig()` never returns `mode: "live"` from env; `live` and `live_stub` are clamped to `DEFAULT_RUNTIME_MODE` ("paper").
2. **Intent handler:** Even if config were ever changed to return "live", the handler explicitly returns when `config.mode === "live"` and does not call `reconcileIntents`.
3. **PaperOrderManager:** Before doing any work, calls `assertNoLiveOrderPlacement()` (throws if mode is "live") and throws if `adapter.getHealth().mode === "live"`.
4. **Adapter:** Only `PaperExchangeAdapter` is constructed in StreamRuntime; no live adapter is ever injected.

So for the **automated** pipeline, live is fail-closed: env cannot set live, handler refuses live, and order manager would throw if mode or adapter were live.

**Gap:** Manual/API order placement (`placeLimitOrder`, `cancelOrderByPolymarketId`) does **not** check `RUNTIME_MODE`. So “live” in the sense of “no live orders” applies only to the **StreamRuntime pipeline**, not to manual or approval-queue execution via API.

---

## 7. Safety Gaps Summary

| # | Gap | Severity | Notes |
|---|-----|----------|--------|
| 1 | **API order routes ignore RUNTIME_MODE** | Medium | `/api/orders/place`, `/api/orders/cancel`, approval-queue execute, place-exit call real CLOB with no check of runtime mode. Operator could place live orders while runtime is in paper/observe_only. Mitigation: auth and “manual only” design; document that these are independent of StreamRuntime. |
| 2 | **Health exposes two mode concepts** | Low | `getHealth()` returns both `runtimeMode` (from getRuntimeConfig()) and `mode` (from options.paperMode). If StreamRuntime were ever constructed with `paperMode: false`, health could show `mode: "live"` while `runtimeMode` is still "paper". Prefer a single source of truth or clear naming. |
| 3 | **OrderReconciler not used** | Low | OrderReconciler.reconcile() calls reconcileIntents but is not used by StreamRuntime. Dead code or alternate integration path; if used later, must receive the same PaperOrderManager (and thus same checks). |
| 4 | **assertNoLiveOrderPlacement() called without config** | Informational | PaperOrderManager calls `assertNoLiveOrderPlacement()` with no args, so it uses getRuntimeConfig(). Fine for single-process; if config were ever passed from elsewhere, explicit config would be clearer. |
| 5 | **Stale sweeper only updates store** | Informational | sweepAndApply does not call adapter.cancelOrder; it only applies cancel in the lifecycle store. So “cancel” in paper mode is in-memory only. Intentional for paper; document for future live adapter. |

---

## 8. Code Snippets — Most Important Checks and Decision Points

### 8.1 Mode from env (clamp live)

```40:48:lib/runtime/runtime-config.ts
function modeFromEnv(): RuntimeMode {
  const raw = typeof process !== "undefined" ? process.env[ENV_KEY]?.trim().toLowerCase() : "";
  if (raw === "disabled" || raw === "observe_only" || raw === "paper") return raw;
  if (raw === "live_stub" || raw === "live") {
    return DEFAULT_RUNTIME_MODE;
  }
  return DEFAULT_RUNTIME_MODE;
}
```

### 8.2 Intent handler gate (no reconcile if not allowed / live)

```333:350:worker/stream-runtime.ts
      const config = getRuntimeConfig();
      if (!isPaperOrLiveStubExecutionAllowed(config)) {
        diagnostics.recordIntentBlockedByMode(config.mode);
        // ...
        return;
      }
      if (config.mode === "live") {
        diagnostics.recordIntentBlockedByMode("live");
        // ...
        return;
      }
```

### 8.3 Guardrails block before reconcileIntents

```373:383:worker/stream-runtime.ts
      const result = guardrails.evaluate(context, riskEngine.getState(), proposedAction);
      if (result.verdict !== "allowed") {
        diagnostics.recordIntentBlockedByGuardrails();
        // ...
        return;
      }
      // ...
      void orderManager.reconcileIntents([intent]);
```

### 8.4 PaperOrderManager: assert + adapter health

```44:52:lib/runtime/order-manager/paper-order-manager.ts
  async reconcileIntents(intents: OrderIntent[]): Promise<void> {
    if (intents.length === 0) return;
    assertNoLiveOrderPlacement();
    const adapterHealth = this.options.adapter?.getHealth?.();
    if (adapterHealth?.mode === "live") {
      throw new Error(
        "[PaperOrderManager] Live adapter not allowed. Only paper adapter may execute; real exchange submission is disabled."
      );
    }
```

### 8.5 Kill switch in guardrails

```131:136:lib/runtime/risk/runtime-guardrails.ts
    if (!riskState.globalAutomationEnabled) {
      codes.push(GUARDRAIL_REASON_CODES.KILL_SWITCH_GLOBAL);
    }
    if (assetId && riskState.haltedAssetIds.includes(assetId)) {
      codes.push(GUARDRAIL_REASON_CODES.KILL_SWITCH_ASSET);
    }
```

---

**End of audit.**
