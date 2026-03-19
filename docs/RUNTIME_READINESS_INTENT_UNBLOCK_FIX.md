# Runtime readiness intent-unblock fix

## Problem

StreamRuntime stayed blocked from intent generation so that:

- Strategy returned NOOP for `kill_switch` even after the operator cleared the kill switch.
- `userDataHealthy` stayed false when the user WebSocket was open but had no order/fill data events, even when there were **no open orders**.

Consequences:

- No `order.intent.created` events.
- ShadowCandidate total remained 0.
- stream-health showed `operationalReadiness=false` even when market data was flowing.

---

## Fix A — Kill-switch state not sticky after clear

**Root cause:** Health reported `watchdogState: "kill_switch"` whenever `lastWatchdogKillSwitchTriggered` was true, regardless of whether the kill switch was still active. Once the watchdog had triggered a stop, that flag was never cleared, so the UI and strategy kept treating the runtime as in kill_switch even after the operator re-enabled automation.

**Change:** `watchdogState` is derived only as `"kill_switch"` when **both**:

1. The watchdog previously triggered (`lastWatchdogKillSwitchTriggered`), and  
2. The kill switch is **currently** active (`!riskEngine.getState().globalAutomationEnabled`).

After the operator clears the kill switch, `globalAutomationEnabled` becomes true, so we report `"degraded"` or `"ok"` from current watchdog reasons instead of staying on `"kill_switch"`.

**Implementation:**

- Added `deriveWatchdogState(lastTriggered, killSwitchActive, reasonsLength)` in `lib/runtime/stream-watchdog.ts`.
- StreamRuntime uses it with `killSwitchActive = !riskState.globalAutomationEnabled` when deps exist; when deps are missing (e.g. before start), we pass `lastWatchdogKillSwitchTriggered` for the second argument to preserve previous behavior.

**Why this unblocks intents:** The strategy checks `risk.globalAutomationEnabled` and returns NOOP when it is false. It also uses health/watchdog state for display. Once the kill switch is cleared, health now correctly shows non–kill_switch state, and `globalAutomationEnabled` is true, so the strategy can emit intents again.

---

## Fix B — User data health when there are no open orders

**Root cause:** `userDataHealthy` required `user.lastDataEventAt` to be set and within threshold. When the user WebSocket had no order/fill messages (e.g. no recent activity), `lastDataEventAt` stayed null and `userDataHealthy` was false even when there were **no open orders** to confirm. That kept `dataFlowHealthy` and `operationalReadiness` false unnecessarily.

**Change:** If the user connection is open and there are **no** open/working orders, we consider user data healthy even if `lastDataEventAt` is null. If there are open orders, we keep the stricter rule: we still require recent user data (WS or REST truth) for health.

**Implementation:**

- Added `computeUserDataHealthy(userConnection, nowMs, thresholdMs, openOrderCount)` in `lib/runtime/runtime-health.ts`.
- Logic: `user.status === "open"` and either (recent `lastDataEventAt`) or (`openOrderCount === 0`).
- StreamRuntime computes `openOrders` once (including when deps exist) and passes `openOrders.length` into `computeUserDataHealthy`.

**Why this unblocks intents:** With both sockets open, market data fresh, and no open orders, we no longer require a user WS data event for `userDataHealthy`. So `dataFlowHealthy` and `operationalReadiness` can become true, and the runtime can be considered ready for intent generation and ShadowCandidate creation.

---

## How these fixes make ShadowCandidate generation reachable

1. **Fix A:** After a watchdog-triggered stop, once the operator clears the kill switch, health no longer reports `kill_switch`. The strategy can leave NOOP and emit intents; the intent handler can run and create ShadowCandidates (allowed or blocked).
2. **Fix B:** When there are no open orders, the user stream is not required to have had a recent data event for the runtime to be considered healthy. So in the common case of “connected but no recent orders/fills,” the runtime can still become operationally ready and produce ShadowCandidates.

Together, the runtime can transition to `operationalReadiness=true` and `watchdogState` reflecting actual kill-switch state, so intent creation and ShadowCandidate telemetry can run.

---

## How to verify locally

1. **Fix A**
   - Start the worker; allow the watchdog to trigger (e.g. user data silence with working orders).
   - Confirm stream-health shows `watchdogState: "kill_switch"` and `operationalReadiness: false`.
   - Clear the kill switch (e.g. via RuntimeControl / clear global stop).
   - Call stream-health again: `watchdogState` should be `"degraded"` or `"ok"`, not `"kill_switch"`.
   - Run regression tests:  
     `npx ts-node --project tsconfig.tests.json -r tsconfig-paths/register lib/runtime/__tests__/runtime-readiness-intent-unblock-tests.ts`

2. **Fix B**
   - With user and market WebSockets open, no open orders, and no recent user WS data events (e.g. fresh paper account), stream-health should show `userDataHealthy: true` and, if market data is fresh, `dataFlowHealthy: true` and `operationalReadiness: true` (assuming no other blockers).
   - With open orders and no recent user data, `userDataHealthy` should remain false (stricter behavior preserved).
   - Same regression test file covers `computeUserDataHealthy` for no-open-orders and open-orders cases.

3. **ShadowCandidates**
   - With kill switch cleared and runtime healthy (e.g. no open orders and user connection open), run the bot until recommendations and intent flow; confirm ShadowCandidate rows are created (e.g. via `npm run check:shadow-pipeline` or DB query).
