# Paper Trading Validation Checklist

Operator-facing technical checklist for validating the Polymarket Copilot automated trading runtime in **paper mode** before any real live adapter is introduced.

**Document status:** Verified against implementation after execution-policy, readiness/degraded-state, and fill-idempotency hardening. Central execution policy, lifecycle-driven fills, and health/readiness semantics are reflected below.

---

## 1. Purpose

**What paper trading validation is trying to prove**

- The runtime correctly ingests market and user WebSocket data into Market State Engine and order lifecycle store. **Positions are updated only from lifecycle events** (`order.partial_fill` and `order.filled`), not from the user-feed path directly.
- The bot evaluates on live inputs and emits decisions and intents; intents flow to the Order Manager only when **central execution policy** allows (`isExecutionAllowed("runtime_automated")`). **Platform-wide:** manual/API place/cancel/approval-queue/position-exit are gated by `assertExecutionAllowed(surface)`; live and manual execution are not authorized (fail-closed).
- Guardrails and risk exposure run before execution; blocked intents do not reach the adapter.
- Paper adapter is the only execution path for automated runtime; lifecycle events drive position updates via **appliedPositionFilledSize** (idempotent delta); duplicate partial/full events do not double-apply.
- Mode gates and **execution surfaces** (runtime_automated, manual_api, approval_queue, position_exit) behave as designed; live execution remains impossible without explicit policy change.

**What “success” means at this stage**

- Repeated paper sessions complete without unexpected execution in wrong modes.
- Mode gating, guardrails, and fill→position sync are confirmed via logs, health, and debug surfaces.
- No path to real Polymarket order submission exists; observability is sufficient to debug incidents.

**Explicitly out of scope**

- Real live trading and real Polymarket order submission.
- Production-scale rollout, load, or availability.
- Full reconciliation with canonical portfolio/DB (runtime is in-memory execution plane only).

---

## 2. Current Runtime Assumptions

These reflect the **actual implementation** as of the closed-loop fixes. Do not assume capabilities not listed.

| Assumption | Current state |
|------------|----------------|
| **Paper adapter only** | StreamRuntime constructs only `PaperExchangeAdapter`. No live adapter is passed to Order Manager. |
| **Live trading blocked / fail-closed** | **Central execution policy** (`lib/runtime/trading-execution-policy.ts`) gates all surfaces; live and manual execution not authorized. Intent handler uses `isExecutionAllowed("runtime_automated")`; `assertNoLiveOrderPlacement()` and adapter health check in `PaperOrderManager.reconcileIntents()`. Manual/API routes call `assertExecutionAllowed(surface)`; 403 when blocked. |
| **observe_only does not execute** | `isExecutionAllowed("runtime_automated")` is false for observe_only; intent handler never calls `reconcileIntents`. Bot may still evaluate and emit telemetry/intents. |
| **disabled does not execute** | Same as observe_only: execution path not entered; no `reconcileIntents`. |
| **Position updates only from lifecycle events** | User-feed path does **not** call positionUpdater; StreamRuntime subscribes to `order.partial_fill` and `order.filled`; delta = eventFilledSize − order.appliedPositionFilledSize; after apply, setAppliedPositionFilledSize (capped to filledSize). Idempotent for duplicate/replay. |
| **Partial fills** | **Implemented:** Both `order.partial_fill` and `order.filled` subscribed; `appliedPositionFilledSize` on order record; delta applied; setAppliedPositionFilledSize not cleared on filled (idempotent). Numeric invariants: filledSize ≤ size, remainingSize ≥ 0, appliedPositionFilledSize ≤ filledSize. |
| **Net exposure** | **Implemented:** `getExposureFromStores` and `updateRiskExposureFromStores` compute net exposure as signed sum (LONG notional − SHORT notional). Single-funder view. |
| **Guardrails before execution** | Guardrails run in the intent handler before `reconcileIntents`; blocked verdict prevents submission. |
| **Exposure updates** | Called at start of each intent handling from position store + order store; risk state and context provider are updated before guardrails. |

---

## 3. Pre-flight Checklist

Complete before starting the worker with `USE_STREAM_RUNTIME=true`.

### Runtime mode and config

- [ ] `RUNTIME_MODE` is set to the desired mode for this session (e.g. `paper` or `observe_only`). Unset defaults to `paper`.
- [ ] Confirmed that `RUNTIME_MODE` is one of `disabled`, `observe_only`, `paper` (values like `live` or `live_stub` are clamped to default by current config).
- [ ] No other env or code path is forcing live mode or a live adapter.

### Paper adapter and safety

- [ ] Worker is started with **only** the standard entrypoint (no test harness that injects a live adapter).
- [ ] Code path for StreamRuntime uses `PaperExchangeAdapter` only (no `LivePolymarketAdapterStub` or real CLOB adapter in production startup).

### Kill switch default

- [ ] When `globalAutomationDisabledByDefault` is true (StreamRuntime default), kill switch starts with global stop; `globalAutomationEnabled` in health is false until explicitly cleared.

### Tracked assets and WebSockets

- [ ] Tracked asset set is sane for the test (e.g. one or a few markets). Empty tracked set means market WS may not subscribe or may defer.
- [ ] Market WebSocket can connect (network, credentials if any, Polymarket WS availability).
- [ ] User WebSocket can connect (auth/credentials for user feed if required).

### Market State Engine and debug

- [ ] Market State Engine is expected to receive normalized updates from market WS (via `market-feed-normalizer` and `feedNormalizedUpdatesToEngine`).
- [ ] Debug/health endpoints are reachable: `GET /api/ops/runtime/health`, `GET /api/ops/runtime/market-state`, `GET /api/markets/live/detail?assetId=...` (when Next.js app and worker/heartbeat are running as expected).

### Order and position baseline

- [ ] No unexpected open/working orders in runtime state from a previous run (or baseline is known and acceptable).
- [ ] Position store baseline is sane (empty or known state for the funder).

### Environment

- [ ] Test environment (local or staging) matches assumptions: DB for heartbeat, env for `USE_STREAM_RUNTIME`, funder/tracked assets configured as intended.
- [ ] Prisma/heartbeat: worker heartbeat table is writable so runtime health can be reported.

---

## 4. Runtime Startup Validation

Steps to verify immediately after starting the runtime (`USE_STREAM_RUNTIME=true`).

| Check | What to inspect | Expected result | If it fails |
|-------|-----------------|----------------|-------------|
| Worker starts cleanly | Worker process logs | No uncaught exception; log line indicating StreamRuntime started (e.g. "StreamRuntime started", mode: "paper"). | Investigate startup error; do not proceed with execution validation. |
| Component readiness | `GET /api/ops/runtime/health` → `runtimeHealth.components` | All relevant components true: eventBus, marketStateEngine, positionStore, orderManager, botRuntime, riskEngine, killSwitch. | One or more components false → runtime composition incomplete or health not yet reported. |
| Event bus subscriptions | Code / design | Intent and fill handlers are registered in `wireIntentAndFillHandlers` on start; no exception during subscription. | Subscriptions not registered → intents or fills will not flow. |
| StreamRuntime health visible | Heartbeat metadata → `runtimeHealth` | Health object present with **lifecycleStatus**, **streams.marketConnection** / **userConnection** (real state: status, lastOpenAt, lastMessageAt, reconnectAttempts), **operationalReadiness**, **degradedReasons**, **counts.schedulerBacklog** (from bot), **executionPolicy**, components, counts. | Missing → worker may not be using StreamRuntime or heartbeat not writing. |
| Stale/degraded counts | `runtimeHealth.counts.staleAssetCount`, `degradedAssetCount` | Reasonable for environment (e.g. 0 or low if market data is flowing). | High counts with no recovery → market WS or engine issue. |
| Scheduler backlog | `runtimeHealth.counts.schedulerBacklog` | Real queue depth from bot scheduler (not hardcoded 0). | Fake 0 → scheduler did not expose getQueueSize/getInFlightCount. |
| Reconcile failure diagnostics | `runtimeHealth.diagnostics.reconcileFailureCount`, `lastReconcileFailureAt/Reason/IntentId` | Recorded when reconcileIntents fails. | Unhandled rejections if not caught. |
| Paper/live mode indicator | `runtimeHealth.mode`, `runtimeHealth.executionPolicy` | `paper` (or intended mode). Never `live`. liveTradingBlocked from policy. | `live` or unexpected mode → config or health mapping bug. |
| Order manager initialized | Component true; no throw on first intent (in paper mode) | Order manager present; when an intent is emitted in paper mode, no crash. | Crashes on intent → adapter or lifecycle wiring issue. |
| Risk engine initialized | Component true; health includes risk-related state | riskEngine and killSwitch true; `globalAutomationEnabled` matches kill switch state. | Risk not initialized → guardrails or exposure may not run. |

---

## 5. Market Data Validation

| Check | What to do | Expected result | Common failure interpretation |
|-------|------------|-----------------|------------------------------|
| Market WS events arriving | Watch worker logs or metrics for market WS activity | Logs or connectivity indicate messages received (e.g. "Market WebSocket connected", or no disconnect errors). | WS not connected or no tracked assets → no updates. |
| Normalized updates enter Market State Engine | Trigger or wait for market events; then call debug | `GET /api/ops/runtime/market-state` shows assets with non-empty quote/depth and recent snapshot. | Normalizer or engine not receiving → check WS → normalizer → engine chain. |
| Per-asset quote/depth/health | Same debug endpoint; optional `?assetId=...` | Per-asset quote (bestBid, bestAsk, mid), depth (bidTopSize, askTopSize), health (isStale, isDegraded). | Missing or stale → feed or engine patch/tick issue. |
| Stale transitions | Let time pass without market events or use health config | Assets eventually show isStale true (e.g. after staleAfterMs). | Stale never set → tick() or health config issue. |
| Recovery transitions | After stale, send or simulate new market event | isStale flips back to false; recovery reflected in state. | Recovery not detected → health or event application bug. |
| Tracked asset changes | Change tracked set (if your env supports it); refresh | Engine tracked count and sample assets align with new set. | Tracked set not propagating → subscription/refresh logic. |
| Live market detail API | `GET /api/markets/live/detail?assetId=<token_id>` | `available: true` and quote/depth/health/botSummary when runtime is attached. | `available: false` → engine or bot not registered for debug in this process. |

---

## 6. Bot Runtime Validation

| Check | What to do | Expected result | How to tell evaluation vs execution |
|-------|------------|----------------|-------------------------------------|
| Bot evaluation triggers on market events | Ensure market WS is feeding; wait or trigger market events | Bot scheduler enqueues assets; evaluations run (e.g. logs or diagnostics show bot activity). | **Evaluation:** `bot.decision.evaluated` events or telemetry; no new orders in lifecycle store from bot. **Execution:** `order.intent.created` → (in paper only) `reconcileIntents` → new/updated orders in store. |
| Event bursts coalesced | Send or simulate many market updates in short window | Scheduler coalesces; not one evaluation per raw message (coalesce window ~50ms in default config). | Too many evaluations per second → coalesce or enqueue logic. |
| BotDecisionContext builds | No crash when bot runs | Bot completes handleDecision without throw; context includes market state, position, open orders, risk state. | Crashes in buildBotDecisionContext or evaluate → missing store or bad snapshot. |
| Decisions / intents / telemetry emitted | In paper mode with healthy market: expect some intents | `bot.decision.evaluated` every evaluation; `order.intent.created` when strategy returns PLACE_ENTRY/PLACE_EXIT/UPDATE_QUOTES. | No intents ever → strategy always NOOP (e.g. kill switch, stale market, or no favorable conditions). |
| observe_only evaluates but does not execute | Set `RUNTIME_MODE=observe_only`; run; trigger market activity | Bot evaluations and possibly `order.intent.created` events; **no** new orders in order lifecycle store from reconciliation. | Orders appear in store in observe_only → mode gate bug. |
| disabled does not execute | Set `RUNTIME_MODE=disabled` | Same as observe_only: no reconciliation; no new orders from intents. | Orders appear → disabled gate broken. |

---

## 7. Mode Gate Validation

Validate each runtime mode explicitly. Use `RUNTIME_MODE` (or equivalent) and confirm behavior.

| Mode | Should happen | Must NOT happen | What to verify (logs / events / state) |
|------|----------------|------------------|----------------------------------------|
| **disabled** | Runtime may start; bot may or may not run (current code starts bot). Intent handler does **not** call `reconcileIntents`. | No order manager execution; no paper orders created from intents. | `isPaperOrLiveStubExecutionAllowed` false → handler returns without reconcile. Order store: no new orders from bot intents. |
| **observe_only** | Bot evaluates; `bot.decision.evaluated` and possibly `order.intent.created` emitted. Intent handler does **not** call `reconcileIntents`. | No order manager execution; no paper orders from intents. | Same as disabled: no new orders in store from intents. Telemetry shows evaluations. |
| **paper** | Bot evaluates; intents emitted; intent handler **does** call `reconcileIntents`; paper adapter receives submissions; order lifecycle and (on fill) position store update. | No real exchange submission; no live adapter used. | New orders in lifecycle store; health shows mode paper; adapter is paper only. |
| **live_stub** | If ever enabled in config: same execution path as paper (intent handler may reconcile). Adapter remains paper or stub—no real orders. | No real exchange submission. | Current rollout does not set live_stub from env (clamped to default). If tested via override: execution path may run but adapter must not be live. |
| **live** | **Must remain fail-closed.** Intent handler must not reconcile; if something called `reconcileIntents` with live adapter, `assertNoLiveOrderPlacement()` or adapter health check must throw. | No real order placement; no live adapter in use. | Config does not return live from env. If simulated: intent handler returns without calling reconcile; calling reconcile with live adapter throws. |

**Verification method:** For each mode, set env, restart worker, trigger conditions that would produce an intent (e.g. paper mode with favorable market), then inspect order store and logs. In disabled/observe_only: order store must not gain new orders from bot. In paper: orders may appear; adapter must be paper.

---

## 8. Guardrail and Risk Validation

| Check | What to do | Expected result | Notes |
|-------|------------|----------------|--------|
| Guardrails run before reconciliation | In paper mode, cause an intent to be emitted | Guardrails evaluate before `reconcileIntents` (intent handler flow). Blocked verdict → no call to `reconcileIntents`. | Implemented in stream-runtime intent handler: evaluate → if not allowed, return. |
| Blocked intents do not reach executable action | Force a block (see scenarios below) | No new/updated order in lifecycle store for that intent; optional `risk.limit_hit` or equivalent on bus. | Check order store before/after; no new order when guardrail blocks. |
| risk.limit_hit or equivalent | Trigger a limit breach (e.g. exposure, working orders) | Event or telemetry shows limit hit; reconciliation still blocked. | Guardrails emit `risk.limit_hit` when limits breached. |
| Exposure updates when orders/positions change | After fills or new orders, inspect risk state (e.g. via health or debug) | Risk engine state shows updated gross exposure and working order count (net may remain 0 per current impl). | `updateRiskExposureFromStores` runs at start of each intent handling. |
| Kill switch blocks execution | Set global kill switch (e.g. default on startup with `globalAutomationDisabledByDefault`); emit intents | Guardrails see `globalAutomationEnabled` false; verdict blocked; no reconciliation. | Placeholder strategy also checks kill switch; guardrails check risk state. |
| Stale/degraded market blocks | Use asset with stale or degraded health in context | Guardrails block; no submission for that asset. | Market health in context; guardrails check market_stale / market_degraded. |
| Low liquidity / unhealthy markets blocked | If supported: asset with low liquidity or not tradable | Guardrails block (e.g. liquidity_below_threshold, not_tradable). | Per DefaultRuntimeGuardrails: liquidity and tradability checks. |

**Sample scenarios to simulate**

1. **observe_only:** Set `RUNTIME_MODE=observe_only`. Run; trigger intents. Verify no orders created.
2. **Global kill switch:** Start with default (global stop) or call kill switch on; verify no reconciliation.
3. **Tiny max exposure:** Set a very low limit (if configurable) so exposure is over limit; verify block and optional risk.limit_hit.
4. **Stale market state:** Use an asset that is stale (or mock context with stale); verify guardrail blocks.

---

## 9. Order Manager / Paper Execution Validation

| Check | What to inspect | Expected result | Evidence |
|-------|-----------------|----------------|----------|
| order.intent.created reaches Order Manager in paper mode | With `RUNTIME_MODE=paper`, trigger bot to emit intent | Order Manager receives intent; `reconcileIntents` runs. | New or updated order in order lifecycle store; order.submitted or order.ack in event path. |
| reconcileIntents runs | Logs or diagnostics (if wired) | Reconciliation actions (e.g. PLACE, KEEP) recorded; no throw from PaperOrderManager. | Diagnostics collector records reconciliation actions; store shows new orders. |
| Action plan produced | Reconciler output | For given intents and working orders, actions are KEEP/PLACE/CANCEL/CANCEL_REPLACE as expected. | Infer from store: new order = PLACE; canceled = CANCEL; etc. |
| Paper adapter accepts simulated submissions | No throw on submit | Paper adapter returns success and exchangeOrderId; lifecycle handler applies ack. | Order moves to working; order.ack emitted. |
| Lifecycle store reflects transitions | Order store state | pending_submit → working (after ack); working → filled/canceled (after fill/cancel). | Query or debug order store; status and timestamps. |
| Stale sweeper behavior | Wait for stale sweep interval (e.g. 60s) or trigger | Stale orders (e.g. pending_submit no ack, working too old) get cancel or order.stale. | order.stale events or store status changes. |
| Live adapter path blocked | Attempt to use live adapter (e.g. in test) | PaperOrderManager throws (assertNoLiveOrderPlacement or "Live adapter not allowed"). | Never pass live adapter in production path; unit test confirms throw. |

---

## 10. Fill and Position Validation

| Check | What to do | Expected result | Notes |
|-------|------------|----------------|--------|
| Position updates only from lifecycle events | In paper mode, cause an order to fill (paper adapter or user WS fill) | Runtime Position Store updated by **order.partial_fill** / **order.filled** subscribers only; delta = eventFilledSize − order.appliedPositionFilledSize; setAppliedPositionFilledSize after apply (capped). | User-feed path does not call positionUpdater. |
| position.changed emitted | Subscribe or watch for position events | After applyFill (delta), position.changed emitted when material. | Updater emits on material net/realized change. |
| Inventory reflects fill results | Inspect position store (or API that reads it) | Position for asset matches expected side/size/price from fills. | Long/short and size from lifecycle-driven fills only. |
| Repeated fills not double-counted | Duplicate order.partial_fill or order.filled for same order | Delta is 0 after first apply; appliedPositionFilledSize not cleared on filled; idempotent. | appliedPositionFilledSize on order record. |
| Partial fills update position | Partially filled orders | Both partial_fill and filled subscribed; delta from order.appliedPositionFilledSize; numeric invariants (filledSize ≤ size, appliedPositionFilledSize ≤ filledSize). | Lifecycle store transition guards; no mutation on terminal. |
| Exposure updates follow fills | After fill, next intent handling | Risk engine exposure (gross and net) includes position notionals; working order count updated if order closed. | updateRiskExposureFromStores runs on next intent. |

**Known caveats and remaining limitations**

- **appliedPositionFilledSize in-memory only:** Idempotency is per order record; after process restart, replay of fill events would re-apply unless the store (or appliedPositionFilledSize) is persisted. Restart/replay durability is limited.
- **pending_cancel:** Status exists in the lifecycle model but is not actively set by current code paths.
- **Partial fill ordering:** Delta from order.appliedPositionFilledSize; store caps and transition guards limit drift. Deduplication is per order in process.
- **Net exposure:** Single-funder view; multi-funder net would require per-funder aggregation if needed.

---

## 11. Debug / Health / Observability Validation

| Check | What to inspect | Expected |
|-------|-----------------|----------|
| Runtime debug endpoints | `GET /api/ops/runtime/health`, `GET /api/ops/runtime/dashboard`, `GET /api/ops/runtime/snapshot`, `GET /api/ops/runtime/market-state`, `GET /api/markets/live/detail?assetId=...` | 200; health has **lifecycleStatus**, **streams.marketConnection** / **userConnection** (real state), **operationalReadiness**, **degradedReasons**, **counts.schedulerBacklog**, **executionPolicy**, components, counts, diagnostics (including reconcileFailureCount); dashboard/snapshot use policy for liveTradingBlocked (not hardcoded). |
| Market state debug visibility | market-state response | trackedAssetCount, totalAssetCount, fresh/stale/degraded counts, sample assets with quote/depth/health. |
| Health summaries | runtimeHealth in heartbeat or health API | **lifecycleStatus**, status, mode, **operationalReadiness**, **degradedReasons**, **streams** (marketConnection, userConnection with status/timestamps/reconnectAttempts), **counts.schedulerBacklog**, **executionPolicy**, globalAutomationEnabled, components, counts. |
| Diagnostics / telemetry | If diagnostics collector wired: health.diagnostics or logs | Counts for market updates, events by type, bot evaluations, reconciliation actions, fills, etc. |
| Mode visibility | runtimeHealth.mode or runtimeMode | Clearly paper (or current mode); allowedModes list. |
| Blocked vs allowed intent visibility | Logs or risk events | When guardrail blocks: no order; optional risk.limit_hit or reason in logs. When allowed: order appears in store. |
| Order/fill/position events | Event bus subscribers; logs | order.submitted, order.ack, order.filled, order.canceled, position.changed when applicable. |

---

## 12. Paper Session Test Scenarios

Run these in order for a full validation pass.

### Session 1 — Observe-only smoke test

- **Setup:** `RUNTIME_MODE=observe_only`, `USE_STREAM_RUNTIME=true`; start worker; ensure market WS (and optionally user WS) connected.
- **Actions:** Let runtime run; trigger or wait for market updates so bot can evaluate.
- **Verify:** Bot evaluations (and possibly intents) in telemetry/logs; **no** new orders in order lifecycle store from bot.
- **Pass criteria:** No reconciliation; no paper orders from intents; no errors.
- **Stop/fail:** Any new order in store that can be attributed to bot intent in this mode.

### Session 2 — Paper mode single-market test

- **Setup:** `RUNTIME_MODE=paper`; one or few tracked assets; kill switch can be off for this test if desired.
- **Actions:** Start runtime; wait for market data and bot evaluations; allow intents to flow.
- **Verify:** Intents lead to orders in lifecycle store; paper adapter acks; order.submitted/order.ack; no live adapter.
- **Pass criteria:** At least one intent results in one order in store; lifecycle transitions correct.
- **Stop/fail:** Live adapter used; crash; or orders not created when intents are emitted.

### Session 3 — Paper mode multi-market burst test

- **Setup:** Paper mode; multiple tracked assets so multiple intents can be emitted in a short window.
- **Actions:** Run; observe coalescing and multiple assets; multiple orders possible.
- **Verify:** Scheduler coalesces; multiple orders (or KEEP/CANCEL) as expected; no duplicate or runaway orders.
- **Pass criteria:** Stable behavior; exposure/working count reasonable; no crash.
- **Stop/fail:** Runaway orders; duplicate submissions; crash under load.

### Session 4 — Guardrail block scenarios

- **Setup:** Paper mode; then repeat with kill switch on, or observe_only, or (if possible) forced stale market or low limit.
- **Actions:** Trigger intents; confirm blocks.
- **Verify:** When guardrail should block: no new order; optional risk.limit_hit or logs.
- **Pass criteria:** Each scenario blocks as expected.
- **Stop/fail:** Execution when it should be blocked.

### Session 5 — Fill/inventory consistency test

- **Setup:** Paper mode; orders that can “fill” (paper adapter or user WS fills).
- **Verify:** order.filled received; Runtime Position Store updated; position.changed; inventory and exposure as expected; no double-count.
- **Pass criteria:** Fills flow to position store; numbers consistent.
- **Stop/fail:** Fills do not update position store; double-count; exposure not updating.

### Session 6 — Runtime restart/recovery test

- **Setup:** After a short paper run, stop worker cleanly; restart with same config.
- **Verify:** Startup passes; no orphan state; health and debug endpoints work after restart.
- **Pass criteria:** Clean shutdown and restart; health and components good.
- **Stop/fail:** Crash on shutdown/startup; stale or inconsistent state after restart.

---

## 13. Failure Conditions / Stop Criteria

Stop paper validation immediately if any of the following occurs:

- **Execution in an unexpected mode:** Orders are created or reconciled when mode is disabled or observe_only.
- **Live path appears reachable:** Any code path could submit to a live adapter; or health/adapter indicates live.
- **Fills do not update runtime positions:** order.filled is emitted but Runtime Position Store does not change for that funder/asset.
- **Risk blocks do not prevent reconciliation:** Guardrail should block (e.g. kill switch, stale market, limit breach) but order still appears in store.
- **Runtime health degraded without clear recovery:** Health status degraded/unhealthy and does not recover with normal data/connectivity.
- **Duplicate fills or runaway inventory:** Same fill applied twice; or position/inventory grows without corresponding fills.
- **Inconsistent order lifecycle state:** Order in store in impossible status (e.g. filled but remaining size > 0); or store and events disagree.

Document the condition, logs, and state when stopping; fix before resuming validation.

---

## 14. Exit Criteria for “Paper Validated”

Before the team can say paper trading is validated, all of the following must be true:

- [ ] **Repeated successful paper sessions** across Sessions 1–6 (or equivalent) without stop criteria triggered.
- [ ] **Mode gating stable:** disabled and observe_only never execute; paper executes only with paper adapter; live never used.
- [ ] **Guardrails confirmed:** Block scenarios prevent reconciliation; risk.limit_hit or equivalent when expected; exposure updates before guardrails.
- [ ] **Fill→position sync confirmed:** Positions updated only from order.partial_fill and order.filled (lifecycle-driven); appliedPositionFilledSize idempotency; position.changed and inventory consistent; no double-count; user-feed path does not apply position.
- [ ] **No accidental live execution path:** Central execution policy gates all surfaces; no live adapter in startup; assertNoLiveOrderPlacement and adapter health check in place and tested; manual/API routes return 403 when policy blocks.
- [ ] **Observability sufficient:** Health, debug endpoints, and logs allow debugging incidents and verifying mode/guardrails/fills during sessions.

---

## 15. Next Steps After Paper Validation

Once paper validation exit criteria are met, recommended next steps (grounded in current gaps):

- **Stronger reconciliation tests:** Add integration tests for intent→reconcile→lifecycle and fill→position under various scenarios (partial + full fill ordering).
- **Real live adapter:** Implement live Polymarket CLOB adapter behind an explicit, gated enablement (config + code guard); keep paper default.
- **Staged live rollout checklist:** Separate checklist for first live enablement: credentials, rate limits, circuit breakers, monitoring, rollback.

---

*Checklist version: aligned with StreamRuntime, central execution policy, intent→Order Manager wiring, lifecycle-driven position updates (order.partial_fill + order.filled, appliedPositionFilledSize idempotency), truthful health (lifecycleStatus, stream state, operationalReadiness, degradedReasons, real schedulerBacklog, reconcile failure diagnostics), and paper-only execution path as implemented. Verified after execution-policy, readiness/degraded-state, and fill-idempotency hardening. See docs/PAPER_RUNTIME_FINALIZATION_SUMMARY.md and docs/ORDER_LIFECYCLE_FILL_IDEMPOTENCY_AUDIT.md.*
