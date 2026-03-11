# StreamRuntime / Orchestration Layer Audit

**Audit date:** 2025-03-10  
**Scope:** Startup ordering, dependency wiring, event registration, shutdown, degraded-mode handling, WebSocket and scheduler integration, health/readiness, failure isolation, restart behavior.

---

## 1. Exact Startup Sequence

### 1.1 Worker entry (`worker/index.ts`)

1. **WebSocket polyfill** — If `globalThis.WebSocket` is undefined, require `ws` and attach to global.
2. **Heartbeat started** — `startHeartbeat({ workerName, intervalMs: 30_000, getMetadata: () => streamRuntime ? { runtimeHealth: streamRuntime.getHealth() } : {} })`. First tick runs immediately; then every 30s. When StreamRuntime is running, metadata includes full runtime health.
3. **Branch on `USE_STREAM_RUNTIME`**:
   - **If true:** `streamRuntime = new StreamRuntime({ paperMode: true, globalAutomationDisabledByDefault: true })`; `streamRuntime.start().then(...)` (fire-and-forget Promise).
   - **If false:** `startWebsockets()` (creates its own event bus, engine, store, bot, WS; no StreamRuntime).
4. **Scheduled jobs** — `scheduleJobs()` registers all `JOB_NAMES` intervals (no dependency on StreamRuntime).
5. **Signal handlers** — `SIGINT` / `SIGTERM` → `shutdown()`.

So when `USE_STREAM_RUNTIME=true`, **StreamRuntime.start() is not awaited** by the worker. The worker continues to schedule jobs and heartbeat; runtime startup runs in parallel.

### 1.2 StreamRuntime.start() (`worker/stream-runtime.ts`)

Order of operations:

| Step | Action |
|------|--------|
| 1 | If `this.deps` already set → return (idempotent). |
| 2 | `this.status = "starting"`. |
| 3 | **Async:** `funder = this.options.funderAddress ?? await getFunderForRecompute() ?? ""`. |
| 4 | **Sync:** Create `eventBus`, `marketStateStore`, `marketStateEngine`; `setMarketStateEngineForDebug(marketStateEngine)`. |
| 5 | **Sync:** Create `positionStore`, `positionUpdater` (with eventBus). |
| 6 | **Sync:** Create `riskState`, `riskEngine`, `killSwitch`; optionally `killSwitch.setGlobalStop(...)`. |
| 7 | **Sync:** Create `orderStore`, `orderLifecycleHandler`, `exchangeAdapter` (Paper), `intentReconciler`, `diagnostics`, `orderManager`, `staleSweeper`. |
| 8 | **Sync:** Create `guardrails`, `contextProvider`, `botRuntime` (not started yet). |
| 9 | **Sync:** Assign `this.deps`. |
| 10 | **Sync:** `setBotRuntimeForDebug(botRuntime)`. |
| 11 | **Sync:** `wireIntentAndFillHandlers(...)` → subscribe to `order.intent.created`, `order.partial_fill`, `order.filled`; store unsub functions in `intentAndFillUnsubscribes`. |
| 12 | **Sync:** Start `marketTickInterval` (every 10s → `marketStateEngine.tick()`). |
| 13 | **Sync:** Start `staleSweepInterval` (every 60s → `staleSweeper.sweep()`). |
| 14 | **Sync:** `botRuntime.start()` — subscribes to 13 event types on the same eventBus (market, position, order, regime, risk). |
| 15 | **Async:** `await startWebsocketsWithRuntime(deps, funder)` — see below. |
| 16 | **Sync:** `this.startedAt = new Date()`, `this.status = "ready"`. |

So **status becomes "ready" only after `startWebsocketsWithRuntime` resolves**. That function does **not** await the actual WebSocket `connect()` promises; it kicks off `userWs.connect()` and `marketWs.connect()` and returns. So "ready" means "WS connect() has been called", not "WS is open".

### 1.3 startWebsocketsWithRuntime() (`worker/websockets.ts`)

| Step | Action |
|------|--------|
| 1 | Assign module-level refs: `marketStateEngine`, `orderStore`, `orderLifecycleHandler`, `runtimePositionUpdater`, `botRuntime` from `deps`. |
| 2 | `funder = funderOverride ?? await getFunderForRecompute() ?? ""`. |
| 3 | Create `userWs = createUserWs({ log })`; set `userWs.onMessage(...)` (normalize → `feedUserFeedResultToRuntime` with orderStore, lifecycleHandler, positionUpdater). |
| 4 | **Fire-and-forget:** `userWs.connect().then(...)` — no await. |
| 5 | `assetIds = await getTrackedAssetIds(...)`; `updateStreamSyncState(...)`; `marketStateEngine.setTrackedAssetIds(assetIds)`. |
| 6 | If `assetIds.length > 0`: create `marketWs`, set `marketWs.onMessage(...)` (normalize → `feedNormalizedUpdatesToEngine(..., marketStateEngine)`); **fire-and-forget** `marketWs.connect().then(...)`. Else log "deferred". |
| 7 | `refreshInterval = setInterval(refreshTrackedAssetsAndSubscriptions, 90_000)`. |
| 8 | **Return** (resolve the Promise). |

So the Promise resolves after setting handlers and kicking off connects; **actual TCP/WS open is not awaited**. Heartbeat and health can report `marketWsActive: true` / `userWsActive: true` (because `marketWs` / `userWs` are non-null) before the sockets are actually open.

---

## 2. Exact Shutdown Sequence

### 2.1 shutdown() (`worker/index.ts`)

1. `clearScheduledJobs()` — clear all job intervals.
2. If `streamRuntime`: `await streamRuntime.stop()`; `streamRuntime = null`. Else: `stopWebsockets()`.
3. `await stopHeartbeat(WORKER_NAME)` — clear heartbeat interval, upsert heartbeat status to "idle".
4. `process.exit(0)`.

### 2.2 StreamRuntime.stop()

| Step | Action |
|------|--------|
| 1 | `setBotRuntimeForDebug(null)`. |
| 2 | Run all `intentAndFillUnsubscribes` (unsubscribe from order.intent.created, order.partial_fill, order.filled). |
| 3 | `intentAndFillUnsubscribes = []`. |
| 4 | Clear `marketTickInterval` and `staleSweepInterval`. |
| 5 | `this.deps.botRuntime.stop()` — unsubscribes from all 13 event types, clears scheduler queue, stops drain timer. |
| 6 | `stopWebsockets()` — see below. |
| 7 | `this.deps = null`, `startedAt = null`, `this.status = "stopped"`. |

### 2.3 stopWebsockets()

| Step | Action |
|------|--------|
| 1 | Clear `refreshInterval`. |
| 2 | Clear `marketStateTickInterval` (only used when StreamRuntime is **not** used; with StreamRuntime, the tick is in stream-runtime.ts). |
| 3 | Set `marketStateEngine = null`, `orderLifecycleHandler = null`, `runtimePositionUpdater = null`, `orderStore = null`. |
| 4 | `setBotRuntimeForDebug(null)` (redundant with StreamRuntime.stop() step 1). |
| 5 | If `botRuntime`: `botRuntime.stop()` (redundant with StreamRuntime.stop() step 5); `botRuntime = null`. |
| 6 | If `userWs`: `userWs.close()`; `userWs = null`. |
| 7 | If `marketWs`: `marketWs.close()`; `marketWs = null`. |

**Observation:** Refs (`marketStateEngine`, `orderStore`, etc.) are nulled **before** closing the WebSockets. Any in-flight message that arrives after refs are nulled could see null in the closure and cause a throw or no-op (e.g. `feedNormalizedUpdatesToEngine(updates, marketStateEngine)` with null engine). The WS libraries typically stop delivering messages after `close()`, but there is a small window where a message could be in the event loop. So there is a **theoretical race** between nulling refs and the last WS message.

---

## 3. Component Dependency Graph

```
Worker (index.ts)
  ├── Heartbeat (interval; getMetadata → streamRuntime?.getHealth())
  ├── StreamRuntime (when USE_STREAM_RUNTIME=true)
  │     ├── eventBus (InMemoryRuntimeEventBus)
  │     ├── marketStateStore
  │     ├── marketStateEngine (subscribes to store; publishes market.* events)
  │     ├── positionStore, positionUpdater (subscribes to eventBus for position.changed? no - updater applies fills from order.* events)
  │     ├── riskEngine, killSwitch (killSwitch writes to riskEngine via applyToRiskState - not called in StreamRuntime; risk state updated by contextProvider.updateRiskState(riskEngine.getState()) in intent handler)
  │     ├── orderStore, orderLifecycleHandler (handler publishes order.ack, order.partial_fill, order.filled, etc.)
  │     ├── orderManager (PaperOrderManager) → reconciler, adapter (Paper), lifecycleHandler
  │     ├── staleSweeper (reads orderStore, writes via lifecycleHandler.applyCancelAck)
  │     ├── contextProvider (reads marketStateStore, positionStore, orderStore via getOpenOrdersForAsset)
  │     ├── guardrails (reads risk state, context)
  │     ├── botRuntime (subscribes to eventBus: market.*, position.changed, order.*, regime.changed, risk.*)
  │     ├── diagnostics (in-memory counters)
  │     ├── wireIntentAndFillHandlers (subscribes: order.intent.created, order.partial_fill, order.filled)
  │     ├── marketTickInterval → marketStateEngine.tick()
  │     ├── staleSweepInterval → staleSweeper.sweep()
  │     └── startWebsocketsWithRuntime() → websockets module
  │             ├── userWs (onMessage → feedUserFeedResultToRuntime → orderStore, lifecycleHandler, positionUpdater)
  │             ├── marketWs (onMessage → feedNormalizedUpdatesToEngine → marketStateEngine)
  │             └── refreshInterval → refreshTrackedAssetsAndSubscriptions (marketWs.setTrackedAssetIds, marketStateEngine.setTrackedAssetIds)
  └── Scheduled jobs (independent of StreamRuntime)
```

**Data flow (events):**

- **Market WS** → normalize → `feedNormalizedUpdatesToEngine` → `marketStateEngine.applyQuoteUpdate` / `applyTradeUpdate` / `applyDepthUpdate` → store updated, engine publishes `market.quote.changed`, `market.depth.changed`, etc. → **BotRuntime** (scheduler enqueue) and any other subscribers.
- **BotRuntime** scheduler drain → `handleDecision` → `emitIntentIfNeeded` → publish `order.intent.created` → **StreamRuntime intent handler** → (mode/guardrails) → `orderManager.reconcileIntents` → store + adapter (paper).
- **Order lifecycle** (ack/fill/cancel) → `orderLifecycleHandler` → store + publish `order.ack`, `order.partial_fill`, `order.filled`, etc. → **StreamRuntime fill handlers** → positionUpdater.applyFill; **BotRuntime** also subscribes to order.partial_fill, order.filled, order.stale (for re-evaluation).

---

## 4. Event Bus Subscriptions and Unsubscriptions

### 4.1 Who subscribes

| Subscriber | Event types | Registered in | Unsubscribed in |
|------------|-------------|--------------|------------------|
| StreamRuntime (intent/fill handlers) | `order.intent.created`, `order.partial_fill`, `order.filled` | `wireIntentAndFillHandlers()` during start() | `stop()` via `intentAndFillUnsubscribes` |
| BotRuntime | `market.quote.changed`, `market.depth.changed`, `market.trade.printed`, `market.volatility.changed`, `market.liquidity.changed`, `market.stale`, `market.recovered`, `position.changed`, `order.partial_fill`, `order.filled`, `order.stale`, `regime.changed`, `risk.limit_hit`, `risk.kill_switch_changed` | `botRuntime.start()` → `subscribeToEvents()` | `botRuntime.stop()` |

All use the **same** `eventBus` instance owned by StreamRuntime. Unsubscription is explicit and tied to lifecycle.

### 4.2 Duplicate-listener risks

- **start() idempotence:** `StreamRuntime.start()` returns immediately if `this.deps` is already set, so a second call does not add a second set of intent/fill handlers or a second bot subscription.
- **Single code path:** When `USE_STREAM_RUNTIME=true`, only `startWebsocketsWithRuntime` runs; when false, only `startWebsockets()` runs (which builds its own bus/engine/bot). So there is no mixing of two busses or double subscription to the same bus.
- **Risk:** If someone called `streamRuntime.start()` again after `streamRuntime.stop()` (deps nulled), a **new** eventBus and new subscriptions would be created. The **websocket module** would still hold the old `marketStateEngine` / `orderStore` refs (it reassigns them in `startWebsocketsWithRuntime`). So a second `start()` would create a new runtime graph and then call `startWebsocketsWithRuntime(deps, …)` again, which overwrites the module-level refs and creates **new** userWs and marketWs. The old WS clients would remain open (no close) because `stopWebsockets()` is not called between the two starts. So **restart-by-calling-start-again** without going through worker shutdown would leak WebSockets and leave the old bus/runtime unreachable but still in memory. So: **no duplicate listeners on the same bus**, but **restart is not supported** without full worker restart.

---

## 5. WebSocket Startup / Reconnect Integration

### 5.1 Startup

- **User WS:** `createUserWs({ log })`; `onMessage` set; `connect()` called (Promise not awaited). Connects to `wss://clob.polymarket.com/ws` with API key/passphrase. On open: `updateWsStatus(funder, "user-feed", { connected: true })`, start heartbeat interval (30s).
- **Market WS:** Created only if `assetIds.length > 0`. Connects to `wss://ws-subscriptions-clob.polymarket.com/ws/market`. On open: send initial subscription (`assets_ids`), start heartbeat (10s PING). `getStreamRuntimeStatus()` returns `marketWsActive: !!marketWs`, so true as soon as `marketWs` is assigned, **before** connect() resolves.

### 5.2 Reconnect

- **User WS** (`ws-user.ts`): On `onclose`, if `!closed && retryCount < maxRetries`, `setTimeout(() => connect().catch(() => {}), getBackoffDelay())`. Exponential backoff (1s base, 30s max, 10 max retries). No explicit "reconnect" event to runtime; health comes from heartbeat metadata and WS ref existence.
- **Market WS** (`ws-market.ts`): Same pattern in `onclose`: `setTimeout(() => connect().catch(() => {}), getBackoffDelay())`. Backoff 1s–30s, max 10 retries.

Reconnect is **internal** to the WS clients; StreamRuntime and the websocket module do not register for "reconnected" or adjust state. After reconnect, the same `onMessage` handlers continue to run, so no duplicate registration. **Risk:** If `stopWebsockets()` is called while a reconnect is scheduled, the closed refs (e.g. `marketStateEngine`) are null; when the delayed `connect()` runs, it will assign a new `ws` and new `onopen`; when messages arrive, the handler will call `feedNormalizedUpdatesToEngine(updates, marketStateEngine)` with `marketStateEngine === null`. So **reconnect-after-stop** can run with null refs. Mitigation: `close()` sets `closed = true`, and `onclose` only reconnects when `!closed`. So after `userWs.close()` / `marketWs.close()`, the reconnect path is not taken. The only danger is a reconnect timer that fired **after** we nulled refs but **before** we called `close()`. That window is small.

### 5.3 refreshTrackedAssetsAndSubscriptions (90s)

- If `marketWs` exists: `marketWs.setTrackedAssetIds(assetIds)`, `marketStateEngine.setTrackedAssetIds(assetIds)`; return.
- If no `marketWs` and `assetIds.length > 0`: create **new** `marketWs`, set `onMessage`, call `connect()`. So if the first connection failed or was never created (e.g. zero assets at start), the refresh can create the market WS later. With StreamRuntime, `marketStateEngine` is the runtime’s engine; after `stopWebsockets()`, `marketStateEngine` is null and `refreshInterval` is cleared, so refresh does not run after stop.

---

## 6. Scheduler Integration and Backlog Metrics

### 6.1 Bot scheduler (`EventDrivenBotScheduler`)

- **Queue:** `Map<string, TriggerPriority>` (assetId → priority). No public getter for size.
- **Drain:** After `coalesceMs` (50ms), `drainQueue()` runs; processes queue and clears it; for each asset calls `onDecision(envelope)` (async); `inFlight` set prevents duplicate concurrent evaluation per asset.
- **Backlog:** Health and dashboard expose `schedulerBacklog` but it is **hardcoded to 0** in `StreamRuntime.getHealth()` (`counts.schedulerBacklog: 0`). The scheduler’s queue size is never read. So **backlog is not surfaced**; only diagnostics (e.g. bot evaluation counts) indicate activity.

### 6.2 Recommendation

Expose `scheduler.getQueueSize()` (or equivalent) and use it in `getHealth()` so dashboard and health reflect actual backlog.

---

## 7. Health / Readiness Logic

### 7.1 What is reported

- **Status:** `starting` (during start()), then `ready` (after start() resolves), or `stopped` (after stop()). **Never set to `degraded`** in code; `RuntimeHealthStatus` type allows `"degraded"` but nothing assigns it.
- **Streams:** `marketWsConnected: !!marketWs`, `userWsConnected: !!userWs`, `trackedAssetCount` from store. So "connected" means "WS client exists", not "socket is open".
- **Components:** All true when deps exist (eventBus, marketStateEngine, positionStore, orderManager, botRuntime, riskEngine, killSwitch). No per-component readiness checks.
- **Counts:** staleAssetCount, degradedAssetCount (from market store health), openOrderCount, positionCount, grossExposure, netExposure, **schedulerBacklog: 0**.

### 7.2 Where degraded state is surfaced

- **Per-asset:** Market state engine marks assets as stale/degraded (e.g. `market.stale`, `market.recovered`). Health exposes **counts**: `staleAssetCount`, `degradedAssetCount`. Guardrails use these to block (e.g. MARKET_STALE, MARKET_DEGRADED). Strategy placeholder returns NOOP for `market_degraded` / `position_degraded`.
- **Overall runtime status** is never set to `"degraded"`. So there is no single "runtime degraded" flag; only asset-level and count-level visibility.

### 7.3 Readiness vs actual connectivity

- **Ready** is set when `startWebsocketsWithRuntime` has returned, which is before WebSocket `onopen`. So readiness is **optimistic** with respect to WS connectivity.
- Dashboard and health can show `marketWsConnected: true` / `userWsActive: true` while the socket is still connecting or reconnecting. So **readiness does not guarantee connected**.

---

## 8. Failure Isolation and Restart Behavior

### 8.1 Failure isolation

- **Event bus:** One handler throw/reject is caught and logged; other handlers for the same event still run. No crash propagation.
- **Intent handler:** `void orderManager.reconcileIntents([intent])` — rejections are not awaited; an error in `reconcileIntents` will be an unhandled rejection unless the Promise is later observed.
- **Bot scheduler:** `Promise.resolve(this.onDecision(envelope)).then(...).catch(...)` — inFlight is cleared on both success and failure; one asset’s failure does not stop others.
- **Stale sweeper:** `sweep()` is synchronous and called from setInterval; if it throws, the interval keeps firing (next tick). No try/catch around the interval callback in stream-runtime.
- **Market tick:** Same: `this.deps.marketStateEngine.tick()` in interval; no try/catch in stream-runtime.
- **WebSocket onMessage:** Normalizer and feed functions are in try/catch in websockets.ts; errors are logged, message is skipped.

### 8.2 Restart behavior

- **Worker process:** No built-in "restart StreamRuntime" without exiting. To "restart", operator stops the worker (SIGTERM/SIGINT) and starts it again. Then a **new** StreamRuntime is created and started; new bus, new WS, new intervals.
- **In-process "restart":** If code called `streamRuntime.stop()` then `streamRuntime.start()` again (e.g. for config reload): after stop(), `this.deps` is null and websocket module refs are null; `start()` would create a new graph and call `startWebsocketsWithRuntime(deps, …)`, which reassigns module-level refs and creates **new** userWs and marketWs. The old WS instances were closed in `stopWebsockets()`, so no leak. So in-process restart is **supported** as long as it’s stop() then start() in sequence. The worker does not do this today; it only starts once.

---

## 9. Race Conditions (Summary)

| Scenario | Risk | Severity |
|----------|------|----------|
| Status "ready" / WS "active" before socket open | Health/dashboard show ready and connected before TCP/WS open. | Low (cosmetic / operational confusion). |
| Last WS message after refs nulled in stopWebsockets | `marketStateEngine` or `orderStore` null when handler runs. | Low (narrow window; close() usually stops delivery). |
| Reconnect timer fires after refs nulled but before close() | Reconnect would run with null refs; but close() sets `closed`, so next onclose won’t reconnect. Timer could still fire once. | Low. |
| streamRuntime.start() not awaited in worker | Worker logs "StreamRuntime started" only when start() resolves; jobs and heartbeat run regardless. If start() never resolves (e.g. getFunderForRecompute hangs), status stays "starting" and no WS is started. | Medium (startup hang; no automatic recovery). |
| Unhandled rejection in reconcileIntents | Intent handler uses `void orderManager.reconcileIntents([intent])`. Rejection is unhandled. | Medium (errors can be silent or crash Node if unhandled-rejection mode is strict). |

---

## 10. Specific Hardening Recommendations

1. **Await WebSocket connectivity for "ready"**  
   Have `startWebsocketsWithRuntime` await `Promise.all([userWs.connect(), marketWs?.connect() ?? Promise.resolve()])` (or similar) so that `status = "ready"` is set only after sockets are open, and/or expose a separate `streams.connected` that reflects actual open state (e.g. from WS `readyState` or a small wrapper that resolves on open).

2. **Surface scheduler backlog**  
   Add `getQueueSize()` (or equivalent) to `EventDrivenBotScheduler`, and have `StreamRuntime.getHealth()` (or a shared health builder) pass real backlog into `counts.schedulerBacklog` instead of 0.

3. **Set overall status to "degraded" when appropriate**  
   For example: when `degradedAssetCount > 0` or `staleAssetCount` exceeds a threshold, or when WS has been disconnected for longer than N seconds. Then dashboard/health can show a single "degraded" state and operators can act on it.

4. **Handle reconcileIntents rejections**  
   In the intent handler, use `orderManager.reconcileIntents([intent]).catch((err) => { diagnostics.log("error", ...); })` (or similar) so that reconciliation failures are logged and do not become unhandled rejections.

5. **Null refs after closing WebSockets**  
   In `stopWebsockets()`, close userWs and marketWs first, then null engine/store/handler/updater/botRuntime. That reduces the chance of a late message seeing null refs (at the cost of possibly processing one more message after close in some runtimes).

6. **Try/catch around interval callbacks**  
   Wrap `marketStateEngine.tick()` and `staleSweeper.sweep()` in try/catch in stream-runtime so a single throw does not prevent future ticks (and log the error).

7. **Optional: await start() in worker**  
   If startup order matters (e.g. don’t run jobs until runtime is ready), await `streamRuntime.start()` before `scheduleJobs()`, and surface startup failures (e.g. exit 1 or retry) instead of fire-and-forget.

8. **Document restart semantics**  
   State clearly that in-process restart is stop() then start(); that the worker does not restart the runtime on its own; and that heartbeat metadata reflects the current runtime only when StreamRuntime is running.

---

**End of audit.**
