# Runtime Documentation vs Implementation Audit

**Audit date:** 2025-03-10  
**Scope:** Claims in AUTOMATED_TRADING_RUNTIME_IMPLEMENTATION_REPORT.md, RUNTIME_CLOSED_LOOP_FIXES_SUMMARY.md, PAPER_TRADING_VALIDATION_CHECKLIST.md, PAPER_RUNTIME_FINALIZATION_SUMMARY.md, PAPER_SESSION_001_REPORT.md — verified against current codebase.

---

## 1. Claim-by-Claim Verification Table

### 1.1 AUTOMATED_TRADING_RUNTIME_IMPLEMENTATION_REPORT.md

| Claim / guarantee | Where implemented | Where tested | Support level | Notes |
|-------------------|------------------|--------------|---------------|--------|
| StreamRuntime composes event bus, engine, position store, risk, kill switch, order manager (paper), stale sweeper; worker starts when USE_STREAM_RUNTIME=true | `worker/stream-runtime.ts`, `worker/index.ts` | Not E2E; unit tests for components | **Full** | Correct. |
| Intent → Order Manager: "no subscriber calls orderManager.reconcileIntents" | — | — | **Outdated** | **Doc is wrong.** Fixed in closed-loop: `stream-runtime.ts` subscribes to `order.intent.created` and calls `orderManager.reconcileIntents([intent])` after mode/guardrails. |
| Guardrails "not invoked by PaperOrderManager or StreamRuntime before placing" | — | — | **Outdated** | **Doc is wrong.** Intent handler in `wireIntentAndFillHandlers` calls `guardrails.evaluate()` before `reconcileIntents`. |
| Risk exposure "never called; exposure/counts stay at initial values" | — | — | **Outdated** | **Doc is wrong.** `updateRiskExposureFromStores(riskEngine, positionStore, orderStore)` is called at start of each intent handling in stream-runtime. |
| order.filled → Position updater: "no subscription" | — | — | **Outdated** | **Doc is wrong.** StreamRuntime subscribes to `order.filled` and `order.partial_fill` and calls `positionUpdater.applyFill()`. |
| Runtime config "not enforced in StreamRuntime" | — | — | **Outdated** | **Doc is wrong.** Intent handler checks `isPaperOrLiveStubExecutionAllowed(config)` and `config.mode === "live"`; PaperOrderManager calls `assertNoLiveOrderPlacement()` and adapter health check. |
| Diagnostics "not passed to PaperOrderManager in StreamRuntime" | — | — | **Outdated** | **Doc is wrong.** StreamRuntime creates `DefaultRuntimeDiagnosticsCollector`, passes it in PaperOrderManager options (`diagnostics`), and handlers call record* methods. |
| GET /api/ops/runtime/health returns runtimeHealth from heartbeat | `app/api/ops/runtime/health/route.ts` | Not in runtime-core-tests | **Full** | Correct; reads heartbeat metadataJson, returns metadata.runtimeHealth. |
| Only disabled, observe_only, paper in ROLLOUT_ALLOWED_MODES; live not enableable via env | `lib/runtime/runtime-config.ts` modeFromEnv(), getRuntimeConfig() | runtime-core-tests (isPaperOrLiveStubExecutionAllowed, assertNoLiveOrderPlacement) | **Full** | Correct. |
| assertNoLiveOrderPlacement "exists but is not called in the current flow" | — | — | **Outdated** | **Doc is wrong.** Called at start of `PaperOrderManager.reconcileIntents()`. |
| "Current maturity: Paper-ready with material gaps" and list of "missing link" / "blockers" | — | — | **Outdated** | Those gaps were addressed in RUNTIME_CLOSED_LOOP_FIXES_SUMMARY; report was never updated. |

---

### 1.2 RUNTIME_CLOSED_LOOP_FIXES_SUMMARY.md

| Claim / guarantee | Where implemented | Where tested | Support level | Notes |
|-------------------|------------------|--------------|---------------|--------|
| Intent → Order Manager wired: subscribe to order.intent.created; gate with isPaperOrLiveStubExecutionAllowed and config.mode !== "live"; exposure; guardrails; then reconcileIntents | `worker/stream-runtime.ts` wireIntentAndFillHandlers | runtime-core-tests (intent → OrderManager in paper mode) | **Full** | Correct. |
| Guardrails in execution path: evaluate before reconcileIntents; return without reconcile when verdict !== "allowed" | Same | Guardrails tested in isolation; not intent-handler path | **Full** | Correct. |
| Exposure: updateRiskExposureFromStores at start of each intent handling; gross and workingOrderCount; net "left 0" | `lib/runtime/runtime-exposure.ts`, stream-runtime intent handler | runtime-core-tests (updateRiskExposureFromStores, getExposureFromStores) | **Partial** | **Net exposure is now implemented:** runtime-exposure.ts computes net (signed sum LONG/SHORT) and passes to riskEngine.updateExposure(gross, net, workingOrderCount). Doc said "net left 0"; code was updated in finalization. |
| Config: live/live_stub clamped to default; intent handler returns when config.mode === "live" | runtime-config.ts, stream-runtime | runtime-core-tests (mode gate, assertNoLiveOrderPlacement) | **Full** | Correct. |
| PaperOrderManager: assertNoLiveOrderPlacement + throw if adapter.getHealth().mode === "live" | paper-order-manager.ts | runtime-core-tests (reconcileIntents throws with live adapter) | **Full** | Correct. |
| order.filled → positionUpdater.applyFill(normalizedFillFromOrderFilled(payload)) | stream-runtime wireIntentAndFillHandlers | runtime-core-tests (order.filled → position store) | **Full** | Correct. |
| "Partial fills do not update the runtime position store until the order is fully filled (documented limitation)" | — | — | **Outdated** | **Doc is wrong.** Finalization added order.partial_fill subscription with delta tracking; partials update position store incrementally. |

---

### 1.3 PAPER_TRADING_VALIDATION_CHECKLIST.md

| Claim / guarantee | Where implemented | Where tested | Support level | Notes |
|-------------------|------------------|--------------|---------------|--------|
| Paper adapter only: StreamRuntime constructs only PaperExchangeAdapter; reconcileIntents throws if adapter mode === "live" | stream-runtime.ts (new PaperExchangeAdapter), paper-order-manager.ts | runtime-core-tests (live adapter throws) | **Full** | Correct. |
| getRuntimeConfig() does not return live from env; intent handler returns when config.mode === "live"; assertNoLiveOrderPlacement and adapter health in reconcileIntents | runtime-config.ts, stream-runtime, paper-order-manager | Yes | **Full** | Correct. |
| observe_only / disabled: isPaperOrLiveStubExecutionAllowed false; no reconcileIntents | stream-runtime intent handler | runtime-core-tests (observe_only/disabled block execution) | **Full** | Correct. |
| order.filled updates Runtime Position Store via positionUpdater.applyFill(normalizedFillFromOrderFilled(payload)) | stream-runtime order.filled + order.partial_fill handlers | runtime-core-tests (fill → position) | **Full** | Correct. |
| **Partial fills:** "Implemented: order.partial_fill subscribed; cumulative filled size tracked; only delta applied" | stream-runtime order.partial_fill handler, lastAppliedFilledByOrderId | Tests for normalizedFillFromOrderPartialFill / position updater | **Full** | Correct. |
| **Net exposure:** "Implemented: getExposureFromStores and updateRiskExposureFromStores compute net as signed sum" | lib/runtime/runtime-exposure.ts | runtime-core-tests (getExposureFromStores, updateRiskExposureFromStores with net) | **Full** | Correct. |
| Guardrails run in intent handler before reconcileIntents; blocked verdict prevents submission | stream-runtime | Guardrails unit tests; not full intent-handler integration test | **Full** | Correct. |
| Exposure updates at start of each intent handling; risk state and context provider updated before guardrails | stream-runtime | Yes (exposure tests) | **Full** | Correct. |
| Stale sweeper: "Stale orders (e.g. pending_submit no ack, working too old) get cancel or order.stale" | worker/stream-runtime.ts interval calls **sweep()** only | Stale sweeper unit tests use sweep/sweepAndApply | **Partial** | **Fragile.** StreamRuntime calls `staleSweeper.sweep()` every 60s, **not** `sweepAndApply()`. So order.stale is **not** emitted and applyCancelAck is **not** called by the interval. Only recommendations are computed. To get "cancel or order.stale" you must call sweepAndApply (e.g. in tests or a different code path). |
| "risk.limit_hit or equivalent" when limits breached | runtime-guardrails.ts emits risk.limit_hit | Guardrails tests | **Full** | Correct. |
| Diagnostics collector records reconciliation actions; store shows new orders | stream-runtime passes diagnostics to PaperOrderManager; PaperOrderManager calls recordReconciliationAction | Diagnostics snapshot in health; no dedicated test for reconciliation counters | **Full** | Correct. |
| Live adapter path blocked: PaperOrderManager throws (test confirms) | paper-order-manager.ts | runtime-core-tests (reconcileIntents throws with live adapter) | **Full** | Correct. |

---

### 1.4 PAPER_RUNTIME_FINALIZATION_SUMMARY.md

| Claim / guarantee | Where implemented | Where tested | Support level | Notes |
|-------------------|------------------|--------------|---------------|--------|
| order.partial_fill subscribed; lastAppliedFilledByOrderId; full order.filled applies remainder and clears key | stream-runtime wireIntentAndFillHandlers | Partial fill / position tests | **Full** | Correct. |
| getExposureFromStores + net exposure (LONG notional − SHORT); updateRiskExposureFromStores passes net to riskEngine | runtime-exposure.ts, runtime-risk-engine updateExposure(gross, net, workingOrderCount) | Yes | **Full** | Correct. |
| Diagnostics: intentsBlockedByMode, intentsBlockedByGuardrails, partialFillsApplied, fullFillsApplied, positionUpdates, exposureUpdates; intent/fill handlers call these | runtime-diagnostics.ts, stream-runtime handlers | Diagnostics in health snapshot | **Full** | Correct. |
| getHealth() includes runtimeMode, positionCount, grossExposure, netExposure, diagnostics.getSnapshot() | stream-runtime getHealth() | — | **Full** | Correct. |
| GET /api/ops/runtime/dashboard: mode, adapter, counts, diagnostics, liveTradingBlocked: true | app/api/ops/runtime/dashboard/route.ts | — | **Full** | Correct. |
| GET /api/ops/runtime/snapshot: concise snapshot | app/api/ops/runtime/snapshot/route.ts | — | **Full** | Correct. |
| "Partial fill → position sync: partials update RuntimePositionStore incrementally; full fill applies only remaining delta; no double-count" | stream-runtime partial_fill + filled handlers | Yes | **Full** | Correct. |
| "Gross and net exposure computed from position store; working order count from order store; written into risk engine and exposed in health/counts" | runtime-exposure, getHealth counts | Yes | **Full** | Correct. |
| "Scheduler backlog: Health/dashboard still report schedulerBacklog: 0 if scheduler does not expose queue depth" | stream-runtime getHealth() hardcodes counts.schedulerBacklog: 0 | — | **Full** | Accurate statement of current behavior; scheduler has no getQueueSize(). |
| "One unrelated test ('absolute spread') may still fail depending on tsconfig" | runtime-core-tests.ts line 113 (spreadAbs === 0.2) | — | **Full** | Accurate caveat. |

---

### 1.5 PAPER_SESSION_001_REPORT.md

| Claim / guarantee | Where implemented | Where tested | Support level | Notes |
|-------------------|------------------|--------------|---------------|--------|
| "Paper adapter only" + "reconcileIntents throws if adapter.getHealth().mode === 'live'" | stream-runtime, paper-order-manager | Yes | **Full** | Correct. |
| "Live fail-closed: getRuntimeConfig clamps live/live_stub; intent handler returns when !isPaperOrLiveStubExecutionAllowed or config.mode === 'live'; assertNoLiveOrderPlacement in reconciler" | runtime-config, stream-runtime, paper-order-manager | Yes | **Full** | Correct. |
| "Partial fills → positions: order.partial_fill subscribed; delta via lastAppliedFilledByOrderId; order.filled applies remainder and clears key" | stream-runtime | Yes | **Full** | Correct. |
| "Gross + net exposure" in runtime-exposure; exposed in health/dashboard | runtime-exposure, getHealth, dashboard/snapshot routes | Yes | **Full** | Correct. |
| Dashboard API returns liveTradingBlocked: true, counts, diagnostics | dashboard/route.ts | — | **Full** | Correct. |
| Snapshot API: mode, counts, exposure | snapshot/route.ts | — | **Full** | Correct. |
| "Diagnostics: intentsBlockedByMode, intentsBlockedByGuardrails, etc.; wired in StreamRuntime intent/fill handlers" | runtime-diagnostics, stream-runtime | — | **Full** | Correct. |
| "Session 001 has not yet been executed" / "No run evidence" | — | — | **Full** | Accurate; report is a template. |
| "Heartbeat timing: first few heartbeats after worker start may not yet include runtimeHealth if StreamRuntime is still starting" | worker starts heartbeat before StreamRuntime.start(); start() is async and not awaited | — | **Full** | Accurate caveat. |

---

## 2. Overstatements and Misleading Confidence

| Document | Overstatement / misleading | Reality |
|----------|----------------------------|--------|
| **AUTOMATED_TRADING_RUNTIME_IMPLEMENTATION_REPORT** | Entire "What remains incomplete" and "Current readiness level" and "Biggest blockers" sections describe **pre–closed-loop** state. A reader can believe intent→order manager, guardrails, exposure, order.filled→position, config, and diagnostics are **still** missing. | All of those were fixed in the closed-loop and finalization work. The report was never updated and is **outdated**. |
| **AUTOMATED_TRADING_RUNTIME_IMPLEMENTATION_REPORT** | "Diagnostics collector exists but is not passed to PaperOrderManager in StreamRuntime." | StreamRuntime **does** instantiate and pass `diagnostics` to PaperOrderManager and uses it in intent/fill handlers. |
| **AUTOMATED_TRADING_RUNTIME_IMPLEMENTATION_REPORT** | "No subscriber on order.intent.created that calls orderManager.reconcileIntents." | There is one: the intent handler in `wireIntentAndFillHandlers`. |
| **RUNTIME_CLOSED_LOOP_FIXES_SUMMARY** | "Net exposure set to 0 (see limitations)." | Net exposure is **no longer** 0; finalization added net computation and it is passed to `riskEngine.updateExposure()`. |
| **RUNTIME_CLOSED_LOOP_FIXES_SUMMARY** | "Subscribing only to order.filled … Partial fills do not update the runtime position store until the order is fully filled." | Finalization added `order.partial_fill` subscription with delta tracking; partials **do** update the position store incrementally. |
| **PAPER_TRADING_VALIDATION_CHECKLIST** | "Stale orders … get cancel or order.stale" (from periodic sweep). | StreamRuntime only calls `sweep()`, not `sweepAndApply()`. So no order.stale emission and no applyCancelAck from the interval; only recommendations. Wording overstates what the **production** interval does. |
| **PAPER_RUNTIME_FINALIZATION_SUMMARY** | "No code in this finalization enables or allows live order submission." | True of finalization code; live submission is still possible via **API** routes (e.g. `/api/orders/place`, approval-queue execute) that call `placeLimitOrder` and do not check RUNTIME_MODE. Doc does not claim otherwise but could be read as "no path to live" globally. |

---

## 3. Guarantees That Are Fragile or True Only Under Narrow Assumptions

| Guarantee | Fragility / assumption | Recommendation |
|-----------|-------------------------|----------------|
| "Live execution remains impossible" | True for **StreamRuntime pipeline only**. Manual/API paths (`placeLimitOrder`, `cancelOrderByPolymarketId`) can place/cancel real orders regardless of RUNTIME_MODE. | Doc should say "no **automated** live execution" or "live blocked for the StreamRuntime intent→reconcile path." |
| "Stale orders get cancel or order.stale" (checklist) | True only if someone calls `sweepAndApply()`. Production interval calls `sweep()` only. | Either change StreamRuntime to call `sweepAndApply()` on the interval, or change the checklist to "Stale orders are **identified**; to apply cancel/order.stale use sweepAndApply (e.g. in tests)." |
| "Guardrails run before reconciliation" | True for intents that go through the **single** intent handler. Any other caller of `orderManager.reconcileIntents()` (e.g. a future API or job) would bypass guardrails unless they are added there. | Document that guardrails are enforced only on the event-driven intent path; any new entry points must enforce guardrails explicitly. |
| "order.filled / order.partial_fill update Runtime Position Store" | Assumes events are delivered in order and without duplicates. Doc already caveats out-of-order/duplicate partials. | Keep caveat; consider idempotency keys if needed. |
| "Net exposure: single-funder view" | Correct; multi-funder net would require aggregation. | Doc already states this; no change. |
| "schedulerBacklog: 0" | Scheduler does not expose queue size; health always reports 0. | Document as known limitation; consider adding getQueueSize() to scheduler and wiring in health. |
| "No accidental live execution path" | Relies on (1) only PaperExchangeAdapter in StreamRuntime, (2) env clamp, (3) intent-handler gates, (4) assertNoLiveOrderPlacement + adapter check in PaperOrderManager. If a live adapter were ever passed (e.g. via test harness or misconfiguration), the **adapter** check would throw. Config cannot return "live" from env. | Assumption is narrow but layered; doc could explicitly list the layers. |

---

## 4. Summary Table: Document Freshness and Accuracy

| Document | Freshness | Main issue |
|----------|-----------|------------|
| **AUTOMATED_TRADING_RUNTIME_IMPLEMENTATION_REPORT** | **Outdated** | "What remains incomplete" and "Current readiness" describe pre–closed-loop state. Six major items marked "Not implemented" are now implemented. |
| **RUNTIME_CLOSED_LOOP_FIXES_SUMMARY** | **Mostly current** | Two limitations (net exposure 0, partial fills not updating position) were later fixed in finalization; doc not updated. |
| **PAPER_TRADING_VALIDATION_CHECKLIST** | **Mostly current** | One mismatch: stale sweeper behavior (production uses sweep() only, not sweepAndApply). Rest aligns with implementation. |
| **PAPER_RUNTIME_FINALIZATION_SUMMARY** | **Current** | Matches implementation (partial fills, net exposure, diagnostics, dashboard/snapshot, scheduler backlog caveat). |
| **PAPER_SESSION_001_REPORT** | **Current** | Baseline and caveats match code; correctly states session not yet run. |

---

## 5. Recommended Doc Updates

1. **AUTOMATED_TRADING_RUNTIME_IMPLEMENTATION_REPORT.md**  
   Add a short "Update (post–closed-loop)" section at the top stating that §1 "What remains incomplete", §2.8 "Wired (order.filled)", §2.9 "Wired (guardrails/exposure)", §2.10 "Intent → Order Manager", §2.18 "Wired", §2.20 "Enforced in code", and §6 "Missing or weak" have been addressed (intent→order manager, guardrails in path, exposure updates, order.filled + order.partial_fill→position, config enforced, diagnostics wired). Optionally revise those sections to "Implemented (as of closed-loop/finalization)."

2. **RUNTIME_CLOSED_LOOP_FIXES_SUMMARY.md**  
   In "Remaining limitations", state that **net exposure** is now computed and passed to the risk engine (finalization), and that **partial fills** now update the position store via order.partial_fill subscription (finalization).

3. **PAPER_TRADING_VALIDATION_CHECKLIST.md**  
   In §9 "Stale sweeper behavior", clarify: "Stale orders are **detected** by the periodic sweep (sweep()). To **apply** cancel and emit order.stale, the code path would need to call sweepAndApply(); currently the StreamRuntime interval calls sweep() only, so only detection runs on the timer."

4. **All docs**  
   Where "live execution is impossible" or "no live path" is stated, qualify with "for the **automated** StreamRuntime path" or "no live adapter in the intent→reconcile path," and note that manual/API order placement (e.g. /api/orders/place) is a separate path and does not check RUNTIME_MODE.

---

**End of audit.**
