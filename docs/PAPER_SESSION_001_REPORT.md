# Paper Session 001 — Report

**Polymarket Copilot automated trading runtime — first paper validation session.**

**Document status:** Verified against implementation after execution-policy, readiness/degraded-state, and fill-idempotency hardening. Baseline (§3) reflects central execution policy, lifecycle-driven fills, and health/readiness semantics.

---

## 1. Session Metadata

| Field | Value |
|-------|--------|
| **Session ID** | PAPER_SESSION_001 |
| **Date** | TBD (Not yet run) |
| **Operator** | TBD |
| **Environment** | TBD (e.g. local / staging) |
| **Runtime mode** | TBD — intended: `observe_only` (Session 1 from checklist) |
| **Adapter mode** | `paper` (only adapter in use; see baseline) |
| **Markets tested** | TBD — recommend one or few tracked assets for first run |
| **Duration** | TBD |
| **Report status** | **Planned** — ready-to-use session report; no actual run executed yet |

**Note:** No evidence was found in the repository that Session 001 (or any paper session) has been executed. This document serves as a **pre-run baseline + ready-to-use session report template**. When the session is run, fill in the TBD fields and the evidence sections below.

---

## 2. Session Purpose

Session 001 is intended to validate the following, in line with `docs/PAPER_TRADING_VALIDATION_CHECKLIST.md` and current implementation:

1. **Observe-only smoke:** With `RUNTIME_MODE=observe_only`, the runtime starts; bot evaluates on market data; **no** orders are created in the order lifecycle store from bot intents (execution path is gated).
2. **Mode gating:** `observe_only` blocks reconciliation; diagnostics (when captured) should show intents blocked by mode rather than reconciliation.
3. **Intent flow visibility:** Bot emits `order.intent.created` when strategy produces a tradable action; in observe_only these are not passed to Order Manager.
4. **Guardrail behavior:** Not the primary focus of Session 001; guardrails run only when execution is allowed (paper mode). Session 001 focuses on mode gate.
5. **Fill/position sync:** Not in scope for observe_only (no orders executed). Deferred to a later paper-mode session.
6. **Exposure and observability:** Health, dashboard, and snapshot APIs return valid data when worker and Next.js app are running; `liveTradingBlocked: true` and mode are visible.

---

## 3. Current Implementation Baseline

Summary of runtime state as implemented in code (evidence from repo; see `docs/PAPER_RUNTIME_FINALIZATION_SUMMARY.md` and `docs/PAPER_TRADING_VALIDATION_CHECKLIST.md`):

| Capability | Implementation |
|------------|----------------|
| **Paper adapter only** | `worker/stream-runtime.ts` constructs only `PaperExchangeAdapter`; `PaperOrderManager.reconcileIntents()` throws if `adapter.getHealth().mode === "live"` (`lib/runtime/order-manager/paper-order-manager.ts`). |
| **Live fail-closed** | **Central execution policy** (`lib/runtime/trading-execution-policy.ts`) gates all surfaces; intent handler uses `isExecutionAllowed("runtime_automated")`; manual/API routes call `assertExecutionAllowed(surface)`; dashboard/health use policy for liveTradingBlocked. |
| **Partial fills → positions** | **Lifecycle-driven only:** user-feed does not call positionUpdater. Both `order.partial_fill` and `order.filled` subscribed; delta = eventFilledSize − order.appliedPositionFilledSize; setAppliedPositionFilledSize (capped); idempotent for duplicate/replay. |
| **Gross + net exposure** | `lib/runtime/runtime-exposure.ts`: `getExposureFromStores()`, `updateRiskExposureFromStores()`; net = signed sum by position side; exposed in health/dashboard counts. |
| **Dashboard API** | `GET /api/ops/runtime/dashboard`; reads heartbeat `runtimeHealth`; returns executionPolicy, liveTradingBlocked (from policy), operationalReadiness, degradedReasons, real stream state, counts, diagnostics. |
| **Snapshot API** | `GET /api/ops/runtime/snapshot`; concise mode, counts, exposure, execution policy. |
| **Diagnostics** | `DefaultRuntimeDiagnosticsCollector`; intentsBlockedByMode/ByGuardrails, positionUpdates, exposureUpdates, reconcileFailureCount, lastReconcileFailureAt/Reason/IntentId; wired in StreamRuntime. |
| **Health/readiness** | lifecycleStatus, streams.marketConnection/userConnection (real state), operationalReadiness, degradedReasons, counts.schedulerBacklog from bot. |

**Known limitations (from finalization summary):**

- appliedPositionFilledSize in-memory only; restart/replay durability limited unless persisted.
- Net exposure is single-funder view.
- pending_cancel exists but is not actively set. Scheduler backlog is now real from bot.
- One pre-existing unit test (“absolute spread”) may fail; unrelated to session.

---

## 4. Pre-run Baseline Checklist

Complete before starting Session 001. Derived from `docs/PAPER_TRADING_VALIDATION_CHECKLIST.md` §3 (Pre-flight) and §4 (Runtime startup).

- [ ] `RUNTIME_MODE=observe_only` set for this session (or as desired).
- [ ] `RUNTIME_MODE` is one of `disabled`, `observe_only`, `paper` (no live).
- [ ] Worker started with `USE_STREAM_RUNTIME=true` (StreamRuntime used).
- [ ] No test harness or code path injects a live adapter.
- [ ] Kill switch default understood: `globalAutomationDisabledByDefault: true` → health shows `globalAutomationEnabled: false` until cleared.
- [ ] Tracked asset set is sane (e.g. one or a few markets); empty set may mean no market WS subscription.
- [ ] Market WebSocket can connect (network, Polymarket WS).
- [ ] User WebSocket optional for Session 001; connect if testing user feed.
- [ ] Next.js app running so ops APIs are reachable (e.g. `npm run dev`).
- [ ] DB and Prisma: heartbeat table writable; worker can persist heartbeat with `runtimeHealth`.
- [ ] No unexpected open/working orders from a previous run (or baseline known).
- [ ] Debug endpoints reachable: `GET /api/ops/runtime/health`, `GET /api/ops/runtime/dashboard`, `GET /api/ops/runtime/snapshot`, `GET /api/ops/runtime/market-state`.

---

## 5. Expected Evidence to Capture During Session 001

Capture the following during or immediately after the run. Store responses and log excerpts for the evidence table (§8).

| Evidence type | Where to get it |
|---------------|-----------------|
| **Runtime health** | `GET /api/ops/runtime/health` — full `runtimeHealth` (status, mode, components, streams, counts, diagnostics). |
| **Runtime dashboard** | `GET /api/ops/runtime/dashboard` — `liveTradingBlocked`, adapterMode, counts, diagnostics summary. |
| **Runtime snapshot** | `GET /api/ops/runtime/snapshot` — mode, trackedAssetCount, openOrderCount, positionCount, exposure, components. |
| **Worker logs** | stdout/stderr of worker process: startup line "StreamRuntime started", mode; any errors; no reconciliation if observe_only. |
| **Diagnostics counters** | From health or dashboard: `diagnostics.botEvaluations`, `diagnostics.orderIntentsGenerated`, `diagnostics.intentsBlockedByMode` (expect observe_only blocks if intents emitted). |
| **Order lifecycle** | No new orders in store attributable to bot intents (observe_only). If using an API or debug path that exposes order store, confirm count or snapshot. |
| **Fill evidence** | Not applicable for observe_only (no execution). |
| **Position/exposure** | Snapshot/dashboard: positionCount, grossExposure, netExposure (may be 0 if no prior paper orders). |
| **Guardrail block** | If any intent is emitted, `intentsBlockedByMode.observe_only` should increment; no reconciliation. |

---

## 6. Test Plan for Session 001

Conservative first session: **observe_only smoke test** (Session 1 in validation checklist).

### Setup

1. Set env: `RUNTIME_MODE=observe_only`, `USE_STREAM_RUNTIME=true`.
2. Ensure DB migrated; Next.js app running (e.g. `npm run dev`).
3. Start worker from repo root, e.g.  
   `USE_STREAM_RUNTIME=true RUNTIME_MODE=observe_only npx ts-node -r tsconfig-paths/register worker/index.ts`  
   (or `npm run worker` with same env if script is configured).
4. Confirm worker log shows StreamRuntime started and mode paper/observe_only as reflected in config.
5. (Optional) Configure one or few tracked assets so market WS has data and bot can evaluate.

### Actions

1. Let runtime run for a short window (e.g. 2–5 minutes) so market data can flow and bot can evaluate.
2. Call `GET /api/ops/runtime/health` and save response.
3. Call `GET /api/ops/runtime/dashboard` and save response.
4. Call `GET /api/ops/runtime/snapshot` and save response.
5. Review worker logs for "StreamRuntime started", any intent or block messages, and absence of order submission.
6. Stop worker cleanly (SIGINT / Ctrl+C).

### Expected Results

- Worker starts without uncaught exception.
- Health/dashboard/snapshot return 200 with `runtimeHealth` or equivalent when worker is running; when worker not running, health may return `status: "no_runtime"`.
- `runtimeMode` or `mode` reflects `observe_only` (or config used).
- `liveTradingBlocked: true` in dashboard.
- No new orders in the order lifecycle store created by bot intents (observe_only gates execution).
- If intents are emitted, diagnostics show `intentsBlockedByMode` (e.g. `observe_only`) and no reconciliation.

### Stop Conditions

- Execution in observe_only: any new order in store attributable to bot intent → **fail**, stop session.
- Live path indicated in health/adapter → **fail**, stop.
- Worker crash or unhandled exception → **fail**, stop.
- Health/dashboard/snapshot unreachable or invalid (e.g. no runtimeHealth when worker is up) → investigate before declaring pass.

---

## 7. Pass/Fail Criteria

Only criteria grounded in current implementation.

| # | Criterion | Pass | Fail |
|---|-----------|------|------|
| 1 | No execution in blocked mode | No new orders from bot intents while in observe_only | Any new order in store from bot in observe_only |
| 2 | Mode visible and correct | Health/dashboard/snapshot show runtimeMode/mode consistent with env (e.g. observe_only) | Mode missing or wrong (e.g. live) |
| 3 | Live path not indicated | Dashboard/health show paper adapter and `liveTradingBlocked: true` | Any indication that live adapter is in use or live trading enabled |
| 4 | Health stable | status ready (or starting); components true; no degraded without recovery | status degraded/stopped and not recovering; components false |
| 5 | Intent flow visible (if bot evaluates) | Diagnostics show botEvaluations; if intents emitted, intentsBlockedByMode shows observe_only | Intents emitted but no block counters; or reconciliation occurred in observe_only |
| 6 | APIs respond as designed | Health, dashboard, snapshot return valid JSON and expected shape when worker running | 500 or invalid response when worker and app are up |

**Session 001 pass:** All of 1–6 pass.  
**Session 001 fail:** Any of 1–6 fail.

---

## 8. Runtime Evidence Table

Fill in **Observed** and **Evidence** when the session is run. Until then, treat as "Not yet captured".

| Item | Expected | Observed | Evidence | Status |
|------|----------|----------|----------|--------|
| Mode gate (observe_only) | No reconciliation; no new orders from intents | Not yet captured | — | TBD |
| Bot evaluation | Bot runs; evaluations in diagnostics or logs | Not yet captured | — | TBD |
| Intent emission | Possible order.intent.created if strategy returns tradable action | Not yet captured | — | TBD |
| Guardrail decision | N/A for observe_only (guardrails run only when execution allowed) | Not yet captured | — | TBD |
| Reconciliation | None in observe_only | Not yet captured | — | TBD |
| Paper order creation | None in observe_only | Not yet captured | — | TBD |
| Partial fill handling | N/A this session | Not yet captured | — | TBD |
| Full fill handling | N/A this session | Not yet captured | — | TBD |
| Position update | N/A this session | Not yet captured | — | TBD |
| Exposure update | Counts visible in health/dashboard/snapshot | Not yet captured | — | TBD |
| Dashboard visibility | 200; liveTradingBlocked: true; counts; diagnostics | Not yet captured | — | TBD |
| Snapshot visibility | 200; mode; counts; exposure summary | Not yet captured | — | TBD |

---

## 9. Known Risks / Caveats for Session 001

From implementation and docs only:

- **appliedPositionFilledSize in-memory only:** Restart/replay can re-apply fills unless store or field persisted. Not applicable to observe_only.
- **pending_cancel:** Exists but not actively set.
- **Single-funder exposure:** Net exposure is single-funder view; multi-funder would need aggregation.
- **Scheduler backlog:** Now reported from bot (real queue depth).
- **Heartbeat timing:** Health/dashboard/snapshot read from DB heartbeat; first few heartbeats after worker start may not yet include `runtimeHealth` if StreamRuntime is still starting.
- **Pre-existing test:** One unit test ("absolute spread") may fail in `runtime-core-tests.ts`; unrelated to paper session validity.
- **Market WS / tracked assets:** If no tracked assets or WS not connected, bot may not evaluate; diagnostics may show little activity.

---

## 10. Recommended Operator Commands / Evidence Capture Steps

Commands and routes grounded in repo structure. Assume repo root and Next.js app base URL (e.g. `http://localhost:3000`).

### Before session

1. **Start Next.js app** (separate terminal):  
   `npm run dev`
2. **Start worker with StreamRuntime and observe_only:**  
   `USE_STREAM_RUNTIME=true RUNTIME_MODE=observe_only npx ts-node -r tsconfig-paths/register worker/index.ts`  
   (Or: `USE_STREAM_RUNTIME=true RUNTIME_MODE=observe_only npm run worker` if env is passed through.)
3. **Confirm worker log** contains a line like "StreamRuntime started" with mode.

### During / after session

4. **Health:**  
   `curl -s http://localhost:3000/api/ops/runtime/health | jq .`  
   (Or open in browser; save JSON.)
5. **Dashboard:**  
   `curl -s http://localhost:3000/api/ops/runtime/dashboard | jq .`
6. **Snapshot:**  
   `curl -s http://localhost:3000/api/ops/runtime/snapshot | jq .`
7. **Market state (optional):**  
   `curl -s "http://localhost:3000/api/ops/runtime/market-state" | jq .`
8. **Tailing worker logs:**  
   Observe stdout/stderr for errors, "StreamRuntime started", and absence of order submission in observe_only.

### After session

9. **Stop worker:** Ctrl+C in worker terminal; allow graceful shutdown.
10. **Re-check health:** With worker stopped, health may return `status: "no_runtime"` and message about runtime not reported.

---

## 11. Session Results

**Session 001 has not yet been executed.**

No run evidence exists in the repository (no logs, stored diagnostics snapshots, or session artifacts). When the session is run, replace this block with:

- **Start time / end time**
- **What happened:** e.g. worker started; health/dashboard/snapshot called; log excerpts; any errors.
- **Orders created:** 0 (expected for observe_only).
- **Intents emitted (if visible):** count or "none observed".
- **Blocks by mode:** from diagnostics `intentsBlockedByMode`.
- **Issues:** any anomalies or failures against pass/fail criteria.

---

## 12. Final Verdict

**Not yet run.**

When the session is completed, set exactly one of:

- **Not yet run**
- **Passed**
- **Passed with issues** (list issues)
- **Failed** (list failed criteria)

Base the verdict only on evidence captured in §8 and §11.

---

## 13. Next Actions

After Session 001 (once run):

1. **If passed:** Schedule Session 002 (paper mode single-market) per validation checklist; capture same evidence types plus order creation and fill/position if in scope.
2. **If passed with issues:** Document issues; fix or accept; decide whether to re-run 001 or proceed to 002 with caveats.
3. **If failed:** Document failure and stop conditions; fix blocking issues; re-run Session 001 before proceeding.
4. **Before any run:** Ensure this report is updated with date, operator, environment, and evidence table filled from actual health/dashboard/snapshot and logs.

---

*Report type: Pre-run baseline + ready-to-use session report template. Session 001 has not been executed. Aligned with docs/PAPER_TRADING_VALIDATION_CHECKLIST.md and docs/PAPER_RUNTIME_FINALIZATION_SUMMARY.md. Verified against implementation after execution-policy, readiness/degraded-state, and fill-idempotency hardening.*
