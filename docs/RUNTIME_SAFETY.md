# Runtime Safety State Machine

The runtime safety state machine is the **central controller** for whether trading operations are allowed, degraded, blocked, or fully halted. It evaluates runtime safety conditions and produces a single deterministic system state that is exposed to the runtime, execution policy, APIs, and UI.

## Purpose

- **Single source of truth:** Kill switch, reconciliation drift, feed freshness, exchange truth, worker health, and phase are combined into one state (normal | degraded | blocked | kill_switch).
- **Deterministic:** Same inputs produce the same state; no hidden heuristics.
- **Fail closed:** Missing critical safety signals move the system toward blocked.
- **Observable:** State, blocking reasons, and warnings are written to the worker heartbeat and returned by the ops API.

## State Definitions

| State | Meaning |
|-------|--------|
| **normal** | All safety checks pass. Trading operations may proceed subject to execution policy and guardrails. |
| **degraded** | System running with warnings (e.g. stale feeds, minor reconciliation drift). Operations may still be allowed; operators should monitor. |
| **blocked** | Unsafe to place new orders; runtime stays alive. E.g. exchange truth unavailable, reconciliation stale, extreme feed staleness, repeated errors. |
| **kill_switch** | Hard stop. No trading allowed. Triggered by explicit kill switch (manual or watchdog). |

## Evaluation Inputs

Inputs are supplied by the stream runtime (e.g. in the watchdog tick):

- **killSwitchActive** – From risk engine (global automation disabled).
- **reconciliationDrift** – Last reconciliation reported drift or failed.
- **reconciliationThresholdMs** – Max age (ms) for reconciliation to be considered fresh (default 120s).
- **reconciliationLastOkAt** – Timestamp of last successful reconciliation.
- **marketFeedFreshnessMs** – Age in ms since last market data event (or null if unknown).
- **userFeedFreshnessMs** – Age in ms since last user data event (or null if unknown).
- **marketFeedMaxStalenessMs** – Threshold (ms) above which market feed is considered stale (degraded).
- **userFeedMaxStalenessMs** – Threshold (ms) above which user feed is considered stale (degraded).
- **marketFeedBlockStalenessMs** – Threshold (ms) above which market feed is extremely stale (blocked).
- **userFeedBlockStalenessMs** – Threshold (ms) above which user feed is extremely stale (blocked).
- **runtimePhase** – starting | rebuilding | reconciling | ready | degraded | stopped.
- **exchangeTruthAvailable** – Exchange orders/fills truth is available and recent.
- **workerHealth** – ok | degraded | unhealthy.
- **repeatedRuntimeErrors** – Count of repeated failures (e.g. reconciliation failures).
- **repeatedRuntimeErrorsThreshold** – Above this count → blocked.
- **fillReplayBacklog** – Optional; unapplied fill count (high backlog → degraded).
- **manualOverride** – Dev only; force state (e.g. "normal") for testing.

## Transition Rules

1. **manualOverride** set → state = override value (dev only).
2. **killSwitchActive** → state = **kill_switch** (early return).
3. **exchangeTruthAvailable === false** → add to blocking reasons → **blocked**.
4. **reconciliationDrift** or reconciliation older than threshold → add to blocking reasons → **blocked**.
5. **Market feed:** unknown → block; age ≥ block threshold → block; age ≥ stale threshold → warning (degraded).
6. **User feed:** unknown → warning; age ≥ block threshold → block; age ≥ stale threshold → warning (degraded).
7. **runtimePhase** rebuilding or starting → **blocked** (runtime_not_ready).
8. **repeatedRuntimeErrors** ≥ threshold → **blocked**.
9. **workerHealth** unhealthy → **blocked**; degraded → warning.
10. **fillReplayBacklog** above threshold → warning (degraded).
11. If any blocking reasons remain → state = **blocked**; else if any warnings → state = **degraded**; else state = **normal**.

All reasons are explicit in `blockingReasons` and `warnings`.

## Interaction with Execution Policy

The execution policy reads the current runtime safety state via `getRuntimeSafetyState().state`. When state is **blocked** or **kill_switch**, the execution policy blocks the order (adds `runtime_safety_blocked` or `runtime_safety_kill_switch` to blocking reasons). So no order can be submitted when the state machine is in blocked or kill_switch, regardless of other policy inputs.

## How Operators Should Interpret States

- **normal** – Safe to trade within execution policy and guardrails. Monitor for warnings elsewhere (e.g. health endpoint).
- **degraded** – Proceed with caution. Check warnings (e.g. stale feed, high fill backlog). Consider pausing new orders until resolved.
- **blocked** – New orders are blocked by the execution policy. Fix blocking reasons (exchange truth, reconciliation, feed connectivity, repeated errors) before resuming.
- **kill_switch** – Trading is halted. Clear kill switch only after verifying cause (e.g. stream watchdog, manual stop) and that conditions are safe.

## API

- **GET /api/ops/runtime-safety** – Returns `{ state, blockingReasons, warnings, evaluatedAt }` from the latest worker heartbeat. When the worker is not reporting, returns default `state: "normal"` with a message. Used by ops UI.

## Logging

- **runtime_safety_state_changed** – Emitted when the evaluated state changes (previousState, newState, blockingReasons, warnings). Subscribers can use this for alerts or dashboards.
