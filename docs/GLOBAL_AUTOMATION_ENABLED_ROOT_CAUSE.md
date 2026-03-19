# globalAutomationEnabled Stuck False — Root Cause and Fix

**Problem:** At runtime, `globalAutomationEnabled` is false even when `operationalReadiness` is true, `watchdogState` is ok, and `marketSubscriptionCoverage.inSync` is true. Every strategy evaluation returns NOOP with reason `kill_switch`, so `order.intent.created` is never emitted.

**Root cause:** The worker starts the stream runtime with `globalAutomationDisabledByDefault: true`. That causes the runtime to call `killSwitch.setGlobalStop("stream_runtime_default_safe")` at startup and sync that state into the risk engine, so `globalAutomationEnabled` is false. There was no automatic “when healthy, turn automation back on” in paper mode, so the flag stayed false until the operator cleared the kill switch via RuntimeControl (DB). With readiness and watchdog healthy, the only blocker was this startup default.

**Fix (minimal, no kill-switch redesign):** In paper mode, when building health, if the kill switch is on **only** because of `stream_runtime_default_safe` and **underlying readiness** is true (`this.status === "ready"` && socketOpen && dataFlowHealthy), we auto-clear the kill switch and sync to the risk engine **before** deriving `watchdogState` / `operationalReadiness`. We do **not** use `operationalReadiness` or `watchdogState === "ok"` for this decision, because the active kill switch can make health report degraded/kill_switch and thus create a self-blocking loop. We do **not** clear if the reason is anything else (e.g. `stream_watchdog: ...`, manual, `exchange_unhealthy`).

---

## Source of truth and code paths

| What | Where |
|------|--------|
| **Stored value** | `RuntimeRiskState.globalAutomationEnabled` in `InMemoryRuntimeRiskEngine` (`lib/runtime/risk/runtime-risk-engine.ts`). |
| **Kill switch** | `InMemoryKillSwitch` (`lib/runtime/risk/kill-switch.ts`). `applyToRiskState(state)` sets `globalAutomationEnabled = state.globalAutomationEnabled && !this.state.globalEnabled`. |
| **Strategy read** | `live-strategy-placeholder.ts`: `if (!risk.globalAutomationEnabled) return NOOP reason "kill_switch"`. |
| **Dashboard/heartbeat** | From `riskEngine.getState().globalAutomationEnabled` in stream-runtime `getHealth()`. |

**Initial value on startup**

- Stream runtime builds risk engine with `createDefaultRuntimeRiskState({ grossExposure, netExposure })` (default `globalAutomationEnabled: true`) and creates kill switch (initial `globalEnabled: false`).
- If `globalAutomationDisabledByDefault` is true (`worker/index.ts` passes `true`): runtime calls `killSwitch.setGlobalStop("stream_runtime_default_safe")` and `killSwitch.applyToRiskState(base)` → risk engine updated so `globalAutomationEnabled` is false.
- If false: risk engine keeps default and no stop is set.

**Paths that set it false**

1. **Startup** — `worker/stream-runtime.ts` build: when `globalAutomationDisabledByDefault` is true, `setGlobalStop("stream_runtime_default_safe")` then sync to risk engine.
2. **Watchdog** — In the watchdog tick, when `evaluateStreamWatchdog` returns `triggerKillSwitch` and `killSwitchReason`, runtime calls `killSwitch.setGlobalStop("stream_watchdog: " + reason)`; next sync (or later getHealth) applies it to risk engine.
3. **Exchange unhealthy** — `kill-switch.ts` `evaluate(riskState)` calls `setGlobalStop("exchange_unhealthy")` when `exchangeHealth === "unhealthy"`.
4. **Operator** — API sets `RuntimeControl.clearGlobalStopRequested`; worker poll calls `clearGlobalStop()` and `syncKillSwitchIntoRiskEngine()` (so this path sets it **true** again).

**Paths that set it true**

1. **Operator clear** — Worker poll sees `clearGlobalStopRequested`, calls `clearGlobalStop()` and `syncKillSwitchIntoRiskEngine()`.
2. **Paper-mode auto-clear (new)** — In `getHealth()`, when paper + operationalReadiness + watchdogState ok + kill switch reason is exactly `stream_runtime_default_safe`, we call `clearGlobalStop()` and `syncKillSwitchIntoRiskEngine()`.

---

## Structured logging added

- **Initial value:** After risk/kill-switch setup in stream-runtime build, a log line: `globalAutomationEnabled initial value` with `globalAutomationEnabled`, `source` (`"globalAutomationDisabledByDefault"` or `"default"`), and when applicable `reason` (`stream_runtime_default_safe`).
- **Every transition:** Kill switch `logTransition` callback logs `kill_switch transition` with `globalAutomationEnabledFrom`, `globalAutomationEnabledTo`, `reason`, and `module` (`stream_watchdog` | `stream_runtime_startup` | `kill_switch.evaluate` | `operator`).
- **Sync:** `syncKillSwitchIntoRiskEngine applied` with `globalAutomationEnabledBefore`, `globalAutomationEnabledAfter`, `killSwitchStopped`.
- **Auto-clear:** `globalAutomationEnabled auto-cleared (paper mode, healthy, default_safe)` with `reason: paper_healthy_default_safe` and `previousReason`.

---

## Files changed

| File | Change |
|------|--------|
| `lib/runtime/risk/kill-switch.ts` | Added `KillSwitchTransitionLogFn` and `InMemoryKillSwitchOptions`; `InMemoryKillSwitch` accepts `logTransition` and calls it on `setGlobalStop` / `clearGlobalStop`. |
| `worker/stream-runtime.ts` | (1) Create kill switch with `logTransition` that logs to `diagnosticsLogFn`. (2) After initial risk/kill setup, log initial `globalAutomationEnabled` and source. (3) In `syncKillSwitchIntoRiskEngine`, log before/after and kill-switch stopped. (4) In `getHealth()` (deps path), after computing `watchdogState`: if paper + operationalReadiness + watchdogState ok + !globalAutomationEnabled and kill switch reason is `stream_runtime_default_safe`, call `clearGlobalStop()`, `syncKillSwitchIntoRiskEngine()`, log auto-clear, and re-read `riskState` for the rest of health. (5) `riskState` made `let` so it can be updated after auto-clear. |

No change to `worker/index.ts` (still passes `globalAutomationDisabledByDefault: true`); the fix is auto-clear when healthy in paper mode.

**Self-blocking fix (second iteration):** The first auto-clear required `operationalReadiness && watchdogState === "ok"`. That was circular: the default-safe kill switch keeps `globalAutomationEnabled` false, which can make `watchdogState` or reported health show as degraded/kill_switch, so the condition was never satisfied. The fix is to run auto-clear **before** deriving `watchdogState` and to use **underlying readiness** only: `this.status === "ready" && socketOpen && dataFlowHealthy`, which does not depend on the kill switch. We also require an exact string match on the reason (`killSwitchReasonActual === "stream_runtime_default_safe"`) and log the actual reason value. Structured logs: `killSwitchReasonActual`, `underlyingReadiness`, `autoClearConditionMatched`, `clearGlobalStopCalled`, and when we clear `globalAutomationEnabledAfter`.

**dataFlowHealthy too strict (third iteration):** Logs showed `underlyingReadiness === false` while reason matched; the breakdown is that `dataFlowHealthy` (= `marketDataHealthy && userDataHealthy`) is too strict for paper-mode startup: it requires recent market/user data events within degraded thresholds, which may not have occurred yet when we first want to auto-clear the synthetic default_safe. The fix is to use a **stream-readiness predicate** for the default_safe auto-clear only: `statusReady && marketSocketOpen && userSocketOpen && marketSubscriptionCoverage.inSync`. This represents “sockets open and subscription in sync” without requiring data-flow freshness. Diagnostic log when we do not clear now includes `underlyingReadinessComponents`: `statusReady`, `runtimeStatus`, `socketOpen`, `marketSocketOpen`, `userSocketOpen`, `dataFlowHealthy`, `marketDataHealthy`, `userDataHealthy`, `marketSubscriptionCoverageInSync`.

---

## Commands to verify

1. **Start worker (paper mode)**  
   From project root:
   ```bash
   npm run worker
   ```
   (Ensure env e.g. `USE_STREAM_RUNTIME=true` if required.)

2. **Wait for readiness**  
   Wait until streams are connected and status is ready (e.g. a few seconds after startup).

3. **Check dashboard**  
   ```bash
   curl -s http://localhost:3000/api/ops/runtime/dashboard | jq '{ globalAutomationEnabled, streams: .streams.operationalReadiness, watchdogState }'
   ```
   After the fix and once healthy: `globalAutomationEnabled` should become `true`, `operationalReadiness` true, `watchdogState` `"ok"`.

4. **Check NOOP reasons and intents**  
   ```bash
   npm run check:noop-reasons
   ```
   And/or:
   ```bash
   curl -s http://localhost:3000/api/ops/runtime/dashboard | jq '.diagnostics | { botEvaluations, orderIntentsGenerated, noopReasonsByCode }'
   ```

5. **Logs**  
   In worker stdout you should see:
   - At startup: `[runtime] globalAutomationEnabled initial value {"globalAutomationEnabled":false,"source":"globalAutomationDisabledByDefault","reason":"stream_runtime_default_safe"}`.
   - After first healthy getHealth (e.g. heartbeat): `[runtime] kill_switch transition` (false→true for automation) and `globalAutomationEnabled auto-cleared (paper mode, healthy, default_safe)`.

---

## Expected evidence that order.intent.created is reachable

- **Dashboard:** `globalAutomationEnabled === true` when operationalReadiness is true and watchdogState is ok (after one or two heartbeat cycles).
- **Diagnostics:** `noopReasonsByCode` no longer dominated by `kill_switch`; you may see `market_not_tradable`, `no_signal`, or `spread_liquidity_favorable` (and possibly `orderIntentsGenerated` > 0 over time).
- **Events:** With strategy returning non-NOOP (e.g. UPDATE_QUOTES), the runtime emits `order.intent.created`; the intent handler runs and can create ShadowCandidates (or record blocked). So `orderIntentsGenerated` can increase and/or shadow pipeline can show activity.
- **Logs:** One-time `globalAutomationEnabled auto-cleared (paper mode, healthy, default_safe)` and corresponding `kill_switch transition` with `globalAutomationEnabledTo: true`.

If the worker was already running with the old code, restart it so the new startup logging and auto-clear logic are in effect.
