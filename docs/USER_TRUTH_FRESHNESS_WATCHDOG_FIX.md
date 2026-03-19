# User truth freshness watchdog fix

## Observed problem

The runtime repeatedly triggered the kill switch with:

- **Reason:** `user_data_silence_with_working_orders`
- **Reasons:** `[user_data_silence_with_orders]`

while:

- **user_sync** was succeeding (GET /data/orders and GET /data/trades returning 200, orders/trades normalized and persisted).
- **stream-health** showed **userLastDataEventAt** blank (user WebSocket had no order/fill messages).
- **marketConnection_status: open**, **userConnection_status: open**.
- **ShadowCandidate** total stayed 0 because the runtime never became operational (kill switch blocked intent flow).

So the watchdog treated “no user WS data events” as “user data silence” and triggered the kill switch even when authenticated REST user truth (orders/trades) had just been refreshed successfully.

## Root cause

The stream watchdog only looked at **userConnection.lastDataEventAt** (set by the **user WebSocket** when it receives order/fill message types). It did **not** consider successful **user_sync** (REST polling of GET /data/orders and GET /data/trades).

So when:

- The user WS was open but had not received any order/fill messages (e.g. quiet account or WS lag), and  
- There were working orders (openOrderCount > 0),

the watchdog saw **userDataAt == null**, added **user_data_silence_with_orders**, and triggered the kill switch. That was a **false negative**: exchange truth was actually fresh via user_sync, but the watchdog had no way to know.

## Why REST user truth should count as freshness

- **user_sync** uses the same L2 credentials as the runtime and calls the same endpoints (GET /data/orders, GET /data/trades) that represent the authoritative order/trade state.
- When user_sync completes without throwing, we have just refreshed that truth and persisted it; the runtime’s view of orders/fills is therefore fresh for watchdog purposes.
- Treating “last successful user_sync” as valid user-data freshness avoids false kill-switch when the WS is silent but REST polling is healthy, while still requiring either WS data or recent REST success.

## Exact fix

1. **User truth timestamp**
   - **lib/live/user-truth-freshness.ts** (new): in-memory `lastSuccessfulUserTruthFetchAt`, with **setLastSuccessfulUserTruthFetchAt(at)** and **getLastSuccessfulUserTruthFetchAt()**. Same process only; job sets it, runtime reads it.

2. **Job updates timestamp**
   - **lib/ops/scheduled-jobs.ts**: After **user_sync** and **stream_repair** complete (after `await syncUser()`), call **setLastSuccessfulUserTruthFetchAt(new Date())**. So any run that finishes without throwing records a successful user truth fetch.

3. **Watchdog accepts user truth as user freshness**
   - **lib/runtime/stream-watchdog.ts**:
     - **StreamWatchdogInputs** extended with optional **lastSuccessfulUserTruthFetchAt?: Date | null**.
     - **effectiveUserDataAt**: if **userConnection.lastDataEventAt** is set, use it; else if **lastSuccessfulUserTruthFetchAt** is set and within **config.userDataDegradedThresholdMs** (90s), use that timestamp; otherwise null.
     - All user “data silence” and “stale” logic (reasons and kill-switch) use **effectiveUserDataAt** instead of **userDataAt**. So when user_sync has run recently, we do not add **user_data_silence_with_orders** and do not trigger the kill switch for user data.

4. **Runtime passes timestamp into watchdog**
   - **worker/stream-runtime.ts**: When calling **evaluateStreamWatchdog**, pass **lastSuccessfulUserTruthFetchAt: getLastSuccessfulUserTruthFetchAt()**.

No change to live trading logic; only watchdog inputs and job-side timestamp updates. Behavior remains conservative: we still require either WS user data or a recent successful user_sync.

## Regression test

In **lib/runtime/__tests__/stream-watchdog-degraded-tests.ts**:

- **“Watchdog: recent user truth fetch counts as user data (no false kill-switch)”**: user connection has **lastDataEventAt** undefined and **openOrderCount: 1**; **lastSuccessfulUserTruthFetchAt** is set to 30s ago. Assert: **user_data_silence_with_orders** is not in reasons and **triggerKillSwitch === false**.

Run:

```bash
npx ts-node --project tsconfig.tests.json -r tsconfig-paths/register lib/runtime/__tests__/stream-watchdog-degraded-tests.ts
```

## How to verify ShadowCandidate creation afterward

1. **Watchdog no longer false-triggers:** With user_sync running every 2 minutes and succeeding, the watchdog should not trigger for **user_data_silence_with_working_orders** when the user WS has no events but user_sync has completed recently (within 90s).
2. **Runtime can become operational:** Once the kill switch is not being set by this path (and any existing kill switch is cleared if applicable), **operationalReadiness** and intent flow can proceed so long as other conditions are met.
3. **ShadowCandidates:** Run **npm run check:shadow-pipeline** periodically; after the runtime is healthy and the bot is emitting intents (allowed or blocked), **ShadowCandidate total** should increase.

## Old behavior (false negative)

Previously, “user data freshness” was defined only as **userConnection.lastDataEventAt** (WS message path). So:

- If the user WS never received an order/fill message (or only PONG/open), **lastDataEventAt** stayed null.
- With **openOrderCount > 0**, the watchdog always added **user_data_silence_with_orders** and could trigger the kill switch, even when user_sync had just successfully refreshed orders/trades via REST.

That was a false negative: the runtime was penalized for “user data silence” despite having fresh user truth from REST.
