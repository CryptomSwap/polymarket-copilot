# Paper Runtime Finalization — Summary

**Date:** Finalization of the automated trading runtime for serious paper-trading validation.

**Document status:** Verified against implementation after execution-policy, readiness/degraded-state, and fill-idempotency hardening. Lifecycle-driven position updates (appliedPositionFilledSize), central execution policy, and health/readiness semantics are reflected below.

---

## 1. What Changed

| Area | Change |
|------|--------|
| **Partial fills → positions** | **Lifecycle-driven only:** user-feed path no longer calls positionUpdater. Both `order.partial_fill` and `order.filled` are subscribed in `StreamRuntime.wireIntentAndFillHandlers()`. **appliedPositionFilledSize** on the order lifecycle record tracks cumulative applied size; delta = eventFilledSize − appliedPositionFilledSize; after apply, `orderStore.setAppliedPositionFilledSize(id, eventFilledSize)` (capped to filledSize). Not cleared on filled (idempotent for duplicate/replay). |
| **Net exposure** | `runtime-exposure.ts`: added `getExposureFromStores(positionStore, orderStore)` (read-only) and net exposure computation. Net = sum over positions of `(side === "LONG" ? exposureNotional : -exposureNotional)`. `updateRiskExposureFromStores` now passes net exposure to `riskEngine.updateExposure()`. |
| **Telemetry / diagnostics** | `RuntimeDiagnosticsSnapshot` and `DefaultRuntimeDiagnosticsCollector` extended with: `intentsBlockedByMode`, `intentsBlockedByGuardrails`, `partialFillsApplied`, `fullFillsApplied`, `positionUpdates`, `exposureUpdates`. New methods: `recordIntentBlockedByMode(mode)`, `recordIntentBlockedByGuardrails()`, `recordPositionUpdate()`, `recordExposureUpdate()`, `recordPartialFillApplied()`, `recordFullFillApplied()`, `log(level, message, meta)`. Intent handler and fill handlers in StreamRuntime call these. |
| **Runtime health snapshot** | `StreamRuntime.getHealth()` now includes: `runtimeMode` from `getRuntimeConfig().mode`, `counts.positionCount`, `counts.grossExposure`, `counts.netExposure`, and `diagnostics: diagnostics.getSnapshot()`. |
| **Central execution policy** | `lib/runtime/trading-execution-policy.ts`: all order-capable surfaces (runtime_automated, manual_api, approval_queue, position_exit) gated by `assertExecutionAllowed(surface)`; dashboard/snapshot/health use `getTradingExecutionPolicy()` for liveTradingBlocked (not hardcoded). |
| **Dashboard API** | `GET /api/ops/runtime/dashboard`: returns mode, adapter, counts, diagnostics, **executionPolicy**, **operationalReadiness**, **degradedReasons**, real stream state. Built from worker heartbeat `runtimeHealth`. |
| **Snapshot API** | `GET /api/ops/runtime/snapshot`: concise snapshot (mode, tracked assets, open orders, positions, exposure, risk, execution policy). |
| **Health/readiness** | **lifecycleStatus**, **streams.marketConnection** / **userConnection** (real state: status, timestamps, reconnectAttempts), **operationalReadiness**, **degradedReasons** (from `computeDegraded`), **counts.schedulerBacklog** from bot, **reconcileFailureCount** and last-failure fields in diagnostics. |

---

## 2. What Was Finalized

- **Partial fill → position sync (lifecycle-driven):** Positions updated only from `order.partial_fill` and `order.filled`; delta from `order.appliedPositionFilledSize`; idempotent for duplicate/replay; user-feed path does not apply position. Numeric invariants and transition guards in lifecycle store.
- **Exposure:** Gross and net exposure are computed from the position store; working order count from the order store; all are written into the risk engine and exposed in health/counts.
- **Observability:** Diagnostics counters and optional structured logging make it possible to see intents emitted, blocked by mode, blocked by guardrails, reconciliations, fills (partial/full), position updates, and exposure updates during paper sessions.
- **Dashboard / snapshot:** Operators can use `/api/ops/runtime/dashboard` and `/api/ops/runtime/snapshot` (when the worker is running with StreamRuntime and heartbeat) to inspect mode, adapter, counts, and diagnostics without touching the worker process.
- **Live trading:** Unchanged and impossible: **central execution policy** gates all surfaces; no real Polymarket order submission; fail-closed for live and manual; dashboard/health report liveTradingBlocked from policy.

---

## 3. What Paper Mode Now Supports

- Bot intent → Order Manager (with mode and guardrails gating).
- Guardrails and risk exposure evaluated before reconciliation.
- Full and **partial** fills updating the runtime position store (no double-count).
- Gross and net exposure in risk state and health/dashboard.
- Diagnostics: intents, blocked-by-mode, blocked-by-guardrails, reconciliations, partial/full fills, position and exposure updates.
- Optional structured log callback for block reasons (mode, guardrails).
- Dashboard and snapshot APIs for validation and debugging.
- Clear reporting that execution is paper-only and live trading is blocked.

---

## 4. Remaining Known Limits

- **appliedPositionFilledSize in-memory only:** Restart/replay durability limited unless store or field persisted. **pending_cancel:** Exists but not actively set. **Partial fill semantics:** Delta from order.appliedPositionFilledSize; store caps and transition guards limit drift. Deduplication is per order in process.
- **Net exposure:** Single-funder view; multi-funder net would require per-funder aggregation if needed.
- **Scheduler backlog:** Health/dashboard now use real scheduler queue depth from bot (getSchedulerBacklog / getQueueSize).
- **Pre-existing test:** One unrelated test in `runtime-core-tests.ts` (“absolute spread”) may still fail depending on tsconfig; new finalization tests pass.

---

## 5. What Still Must Happen Before Any Live Adapter Work

- Implement a real Polymarket live adapter (submit/cancel against CLOB) behind an explicit feature flag or deployment gate.
- Keep `live` out of `ROLLOUT_ALLOWED_MODES` (or equivalent) until safety and compliance are satisfied.
- Add a staged live rollout checklist (e.g. single market, size caps, kill switch, monitoring).
- No code in this finalization enables or allows live order submission.

---

## 6. Files Touched (Finalization)

| File | Change |
|------|--------|
| `lib/runtime/positions/runtime-position-updater.ts` | Added `normalizedFillFromOrderPartialFill(payload, order, deltaSize)`; export. |
| `lib/runtime/runtime-exposure.ts` | Added `getExposureFromStores()`, `ExposureSnapshot`; net exposure = LONG notional − SHORT notional; `updateRiskExposureFromStores` uses it. |
| `lib/runtime/telemetry/runtime-diagnostics.ts` | Extended snapshot and collector with intent-block and fill/position/exposure counters; added `log()` to interface. |
| `lib/runtime/runtime-health.ts` | `counts.positionCount`, `counts.grossExposure`, `counts.netExposure` (optional) added to type and default. |
| `worker/stream-runtime.ts` | Subscribed to `order.partial_fill` and `order.filled`; delta from `order.appliedPositionFilledSize`; setAppliedPositionFilledSize after apply (capped); intent handler uses execution policy, guardrails, exposure update, records reconcile failures; `getHealth()` includes lifecycleStatus, stream state, operationalReadiness, degradedReasons, schedulerBacklog, executionPolicy, diagnostics. |
| `app/api/ops/runtime/dashboard/route.ts` | **New.** GET dashboard from heartbeat `runtimeHealth`; `liveTradingBlocked: true`, adapterMode, counts, diagnostics. |
| `app/api/ops/runtime/snapshot/route.ts` | **New.** GET snapshot (mode, counts, exposure, risk summary). |
| `lib/runtime/__tests__/runtime-core-tests.ts` | Tests: net exposure in updateRiskExposureFromStores; getExposureFromStores; partial fill delta → position; diagnostics intent blocked and position/exposure counters. |
| `tsconfig.tests.json` | Added `downlevelIteration: true` for test run. |

---

*Summary aligned with StreamRuntime, central execution policy, lifecycle-driven fills (appliedPositionFilledSize), truthful health/readiness, and paper-only execution path. Verified after execution-policy, readiness/degraded-state, and fill-idempotency hardening.*
