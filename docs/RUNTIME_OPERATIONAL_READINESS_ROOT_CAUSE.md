# Runtime operational readiness — root cause

## Observed state

- **stream-health:** `socketOpen = true`, `marketLastDataEventAt` recent, `dataFlowHealthy = false`, `operationalReadiness = false`, `watchdogState = kill_switch`, **`userLastDataEventAt` blank**
- **ws-status:** `userFeed.connected = true` but `lastMessageAt` stale; `marketFeed.connected = false` (can disagree with runtime)
- **ShadowCandidate total = 0**

---

## 1. Why watchdogState is kill_switch

The stream watchdog runs on an interval and can call **killSwitch.setGlobalStop()** when:

- **Market:** socket open, `trackedAssetCount > 0`, and either no `lastDataEventAt` (**market_data_silence**) or data older than `marketDataKillSwitchThresholdMs` (180s).
- **User:** socket open, no `lastDataEventAt`, and **openOrderCount > 0** (**user_data_silence_with_orders**), or data older than threshold with orders.

When that happens, the runtime sets **`lastWatchdogKillSwitchTriggered = true`** and never clears it. Health then reports:

```ts
watchdogState: this.lastWatchdogKillSwitchTriggered ? "kill_switch" : (...)
```

So once the watchdog has triggered the kill switch, **watchdogState stays `"kill_switch"`** even after:

- Market (or user) data is flowing again, and/or  
- The operator clears the kill switch via RuntimeControl (worker calls `killSwitch.clearGlobalStop()`).

So the runtime keeps reporting **kill_switch** until the flag is reset. That leaves **globalAutomationEnabled = false** (until the operator clears it) and, as long as the flag is still true, the UI still shows **kill_switch** even after a manual clear.

**Root cause:** A one-time watchdog trigger sets a sticky flag that is never cleared when the kill switch is cleared or when conditions improve.

---

## 2. Why dataFlowHealthy is false

Health defines:

```ts
dataFlowHealthy = marketDataHealthy && userDataHealthy
```

With:

- **marketDataHealthy:** market socket open, `lastDataEventAt` set, and age ≤ `marketDataDegradedThresholdMs` (60s).
- **userDataHealthy:** user socket open, **`lastDataEventAt` set**, and age ≤ `userDataDegradedThresholdMs` (90s).

So **both** streams must have a recent **real data** timestamp. `lastDataEventAt` is **not** set on connection open or on PONG; it is only set when a **real** event is processed:

- **Market:** book / trade / price_change, etc. (in ws-market).
- **User:** PLACEMENT, ORDER, CANCELLATION, UPDATE, TRADE, fill (in ws-user).

If the user feed has never received an order or fill, **user `lastDataEventAt` stays null**, so **userDataHealthy is false** and **dataFlowHealthy is false**. So a connected user feed with no orders/fills (e.g. paper account, no recent activity) will keep **dataFlowHealthy** and **operationalReadiness** false.

---

## 3. Why userLastDataEventAt is blank while userFeed.connected is true

- **userFeed.connected = true** means the user WS **socket** is open (and/or the DB row says so). Connection open and PONG both update `lastMessageAt` and the persisted status; they do **not** set **lastDataEventAt**.
- **lastDataEventAt** is set only in **markRealDataEvent("order" | "fill")**, which is called only for message types: PLACEMENT, ORDER, CANCELLATION, UPDATE, TRADE, fill.

So with no orders or fills on the user feed, **userLastDataEventAt** stays **null** even though the socket is connected and PONGs may be updating **lastMessageAt**. That’s why stream-health can show **userLastDataEventAt** blank while **userFeed.connected** is true and **lastMessageAt** (in ws-status) may be recent from heartbeats.

---

## 4. Does this alone block order.intent.created?

Yes, in two ways:

1. **Kill switch → no intents emitted**  
   The **live strategy placeholder** checks **risk.globalAutomationEnabled**. When the kill switch has been triggered, that is false and the strategy returns **NOOP** with reason **"kill_switch"**. So the bot never returns PLACE_ENTRY / PLACE_EXIT / UPDATE_QUOTES, and **order.intent.created** is never published. No intents → no handler runs → **no ShadowCandidates** (neither allowed nor blocked).

2. **Guardrails would block even if intents were emitted**  
   The intent handler uses **userDataFresh** (and market/reconciliation freshness) in guardrails. If **user.lastDataEventAt** is null while the user socket is open, **userDataFresh** is false, so guardrails would block and we’d only get **blocked** ShadowCandidates, not submitted orders. So the main blocker for **any** ShadowCandidates is (1): the kill switch prevents intents from being emitted at all.

---

## 5. Inconsistency between ws-status and runtime stream health

- **stream-health** (when the worker is running) uses **getStreamRuntimeStatus()**: in-memory **marketConnection** and **userConnection** from the worker’s market/user WS instances.
- **ws-status** reads **WebsocketConnectionStatus** from the DB (updated by **updateWsStatus** in ws-user / ws-market).

So:

- **marketFeed** in ws-status is keyed by channel **"market-feed"**, which is written with **funderAddress = "system"**. The ws-status API often filters by the **user’s funder**. If the query is `where: { funderAddress: funder }`, the market-feed row (system) is not returned, so **marketFeed** defaults to **connected: false**. So ws-status can show **marketFeed.connected = false** even when the runtime’s market WS is open and **stream-health** shows **socketOpen = true** and recent **marketLastDataEventAt**.

---

## 6. Exact minimal fix to make ShadowCandidate generation reachable

Goals:

1. **Stop reporting kill_switch after the operator has cleared it** so the strategy can emit intents again.
2. **Treat “user feed open but no order/fill events” as acceptable when there are no open orders** so dataFlowHealthy and operationalReadiness can become true when only user data is missing.

### Fix A — Watchdog state after kill switch clear

**Where:** `worker/stream-runtime.ts` (health and any other place that sets **watchdogState**).

**Current:**  
`watchdogState = this.lastWatchdogKillSwitchTriggered ? "kill_switch" : (...)`

**Change:** Base **kill_switch** on both the sticky flag and the current risk state. If the kill switch has been cleared, do not report **kill_switch**:

- When building health, if `d.riskEngine.getState().globalAutomationEnabled === true`, do **not** use **lastWatchdogKillSwitchTriggered** to force **kill_switch**. For example:

  `watchdogState = (this.lastWatchdogKillSwitchTriggered && !d.riskEngine.getState().globalAutomationEnabled) ? "kill_switch" : (this.lastWatchdogReasons.length > 0 ? "degraded" : "ok")`

- Optionally, when the worker clears the kill switch (e.g. in the RuntimeControl poll), have the runtime reset **lastWatchdogKillSwitchTriggered = false** so the “who triggered” state is consistent (or rely on the above derivation so that once cleared, we never show kill_switch from the watchdog).

Effect: After the operator clears the kill switch, **watchdogState** can become **ok** or **degraded**, **globalAutomationEnabled** stays true, the strategy stops returning NOOP for kill_switch, and **order.intent.created** (and thus ShadowCandidates) can flow again.

### Fix B — userDataHealthy when there are no open orders

**Where:** `worker/stream-runtime.ts` (**getHealth()**), where **userDataHealthy** is computed.

**Current:**  
`userDataHealthy = user?.status === "open" && user?.lastDataEventAt != null && (now - user.lastDataEventAt.getTime() <= threshold)`  
So with no user order/fill event, **userDataHealthy** is always false.

**Change:** When the user socket is open and there are **no open orders**, treat the user stream as “healthy” even if **lastDataEventAt** has never been set (no orders/fills to protect):

- e.g.  
  `userDataHealthy = user?.status === "open" && (user?.lastDataEventAt != null && now - user.lastDataEventAt.getTime() <= config.userDataDegradedThresholdMs || openOrders.length === 0)`

Use the same **openOrders** definition as elsewhere (e.g. orders in pending_submit, working, partially_filled, pending_cancel). Then **dataFlowHealthy** and **operationalReadiness** can become true when market data is fresh and user is connected with no open orders, so guardrails and readiness no longer block purely due to “no user data event yet.”

Together, **Fix A** restores intent emission (and thus ShadowCandidate flow), and **Fix B** allows the runtime to become operational and pass guardrails when the only missing piece is a user data event and there are no open orders.

---

## 7. Verification after fix

1. Clear the kill switch (e.g. via RuntimeControl / UI) and confirm **watchdogState** is no longer **kill_switch** once cleared; **stream-health** should show **operationalReadiness = true** when market (and user, or user with no orders per Fix B) is healthy.
2. Run **check:shadow-pipeline** and confirm **ShadowCandidate total** increases after the bot has run and emitted intents (allowed or blocked).
3. Optionally confirm **ws-status** vs **stream-health**: if ws-status is filtered by user funder only, document that market-feed is stored under **system** so marketFeed in ws-status may not reflect the runtime’s market WS.
