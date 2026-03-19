# Stream Watchdog Implementation Summary

## Goal

Production-grade Stream Watchdog that distinguishes **socket open**, **heartbeat alive**, and **real data flowing**, and eliminates false-green health states where the WebSocket heartbeat is active but market/user data is stale.

---

## 1. Freshness timestamps (both streams)

### StreamConnectionState (`lib/runtime/stream-connection-state.ts`)

- **Market stream** (set in `ws-market.ts`):
  - `lastSocketFrameAt` – any frame received
  - `lastHeartbeatAt` – PING sent / PONG received (not real data)
  - `lastDataEventAt` – real exchange data only (never updated by heartbeat)
  - `lastBookEventAt` – book (order book) events
  - `lastTradeEventAt` – last_trade_price / trade events

- **User stream** (set in `ws-user.ts`):
  - `lastSocketFrameAt`, `lastHeartbeatAt`, `lastDataEventAt`
  - `lastOrderEventAt` – order lifecycle (ack, cancel, etc.)
  - `lastFillEventAt` – fill/trade events

- `lastDataEventAt` is **never** updated from PING/PONG; only real exchange events update it and the typed event timestamps.

---

## 2. WebSocket implementations

### `lib/polymarket/ws-market.ts`

- On **open**: set `lastOpenAt`, `lastMessageAt`, `lastSocketFrameAt`; do **not** set `lastDataEventAt`.
- **Heartbeat timer**: only updates `lastHeartbeatAt` (and DB status); does **not** touch `lastMessageAt` or `lastDataEventAt`.
- **onmessage**:
  - Every message: set `lastSocketFrameAt`, `lastMessageAt`.
  - **PONG**: set `lastHeartbeatAt` only; return (no `lastDataEventAt`).
  - **Real data**: parse `event_type`/`type`, call `markRealDataEvent(type)` to set `lastDataEventAt` and `lastBookEventAt` or `lastTradeEventAt` as appropriate.
- `getConnectionState()` uses `cloneStreamConnectionState()` so all new timestamps are exposed safely.

### `lib/polymarket/ws-user.ts`

- Same pattern: heartbeat only updates `lastHeartbeatAt`; real order/fill messages update `lastDataEventAt`, `lastOrderEventAt`, `lastFillEventAt` via `markRealDataEvent("order" | "fill")`.
- PONG and heartbeat timer never update `lastDataEventAt`.

### `worker/websockets.ts`

- No logic changes; `getStreamConnectionStates()` already returns the full connection state from `getConnectionState()`, which now includes the new fields.

---

## 3. Stream Watchdog config

### `lib/runtime/stream-watchdog-config.ts` (new)

Single config with defaults:

- `marketDataWarnThresholdMs` (30_000)
- `marketDataDegradedThresholdMs` (60_000)
- `marketDataKillSwitchThresholdMs` (180_000)
- `userDataDegradedThresholdMs` (90_000)
- `userDataKillSwitchWithOrdersThresholdMs` (120_000)
- `reconnectChurnAttemptsThreshold` (5), `reconnectChurnWindowMs` (120_000)
- `watchdogIntervalMs` (15_000)

---

## 4. Stream Watchdog logic

### `lib/runtime/stream-watchdog.ts` (new)

- `evaluateStreamWatchdog(inputs)` returns `{ reasons, degraded, triggerKillSwitch, killSwitchReason }`.
- Evaluates:
  - **Market data silence**: open + tracked assets > 0 and no recent `lastDataEventAt` (warn → degraded → kill switch by threshold).
  - **User data silence**: open and no/old `lastDataEventAt`; with working orders, can trigger degraded and kill switch.
  - **Reconnect churn**: `reconnectAttempts` above threshold.
- Does **not** mutate the kill switch; caller applies the result.

### `worker/stream-runtime.ts`

- **Watchdog interval** (every `watchdogIntervalMs`): gets connection states, tracked count, open order count; runs `evaluateStreamWatchdog()`; stores `lastWatchdogReasons` and, if `triggerKillSwitch`, calls `killSwitch.setGlobalStop("stream_watchdog: ...")` and logs.
- **getHealth()**:
  - Computes `socketOpen`, `heartbeatHealthy`, `dataFlowHealthy`, `operationalReadiness` (socket open + data flow healthy).
  - Fills `marketLastDataEventAt`, `userLastDataEventAt`, `marketLastHeartbeatAt`, `userLastHeartbeatAt` (ISO).
  - Passes `marketDataStaleThresholdMs`, `userDataStaleThresholdMs`, `openOrderCount`, `reconnectChurnAttemptsThreshold` into `computeDegraded`.
  - Merges `degradedResult.reasons` with `lastWatchdogReasons` for `degradedReasons`.
  - Sets `watchdogReasons` and `watchdogState` ("ok" | "degraded" | "kill_switch").

---

## 5. Degraded rules

### `lib/runtime/runtime-degraded.ts`

- **Data freshness**: Uses `lastDataEventAt` when present; heartbeat alone does **not** count as data.
- **market_data_silence**: When market is open, `trackedAssetCount > 0`, and `lastDataEventAt == null` (socket may be open and heartbeat active).
- **user_data_silence_with_orders**: When user is open, `openOrderCount > 0`, and `lastDataEventAt == null`.
- **market_data_stale** / **user_data_stale**: When `lastDataEventAt` is set but older than threshold.
- **reconnect_churn**: When `reconnectAttempts` ≥ threshold.
- New optional inputs: `marketDataStaleThresholdMs`, `userDataStaleThresholdMs`, `openOrderCount`, `reconnectChurnAttemptsThreshold`.

---

## 6. Health reporting

### `lib/runtime/runtime-health.ts`

- **streams**: Added `socketOpen`, `heartbeatHealthy`, `dataFlowHealthy`, `operationalReadiness`, `marketLastDataEventAt`, `userLastDataEventAt`, `marketLastHeartbeatAt`, `userLastHeartbeatAt`.
- **degradedReasons**: Combined from `computeDegraded` and watchdog.
- **watchdogReasons**, **watchdogState** ("ok" | "degraded" | "kill_switch").

### API routes

- **GET /api/ops/runtime/health** – Returns heartbeat metadata including `runtimeHealth` (unchanged contract; payload now includes the new fields).
- **GET /api/ops/runtime/dashboard** – Exposes `streams.socketOpen`, `heartbeatHealthy`, `dataFlowHealthy`, `marketLastDataEventAt`, `userLastDataEventAt`, `marketLastHeartbeatAt`, `userLastHeartbeatAt`, `watchdogReasons`, `watchdogState`.
- **GET /api/ops/runtime/snapshot** – Same new stream and watchdog fields.
- **GET /api/live/stream-health** – When worker heartbeat has `runtimeHealth`, adds `runtime` with `socketOpen`, `heartbeatHealthy`, `dataFlowHealthy`, `operationalReadiness`, `*LastDataEventAt`, `*LastHeartbeatAt`, `watchdogState`, `watchdogReasons`.

---

## 7. Behavior summary

- **Socket open + heartbeat only + no data** → degraded (`market_data_silence` when tracked assets > 0).
- **Heartbeat alone** never updates `lastDataEventAt`; health is not “green” on heartbeat only when data is required.
- **Market/user data resumes** (recent `lastDataEventAt`) → recovered (no degraded reasons).
- **Working orders + stale user stream** → degraded (`user_data_stale` or `user_data_silence_with_orders`).
- **Severe stream silence** (thresholds exceeded) → watchdog sets `triggerKillSwitch`; runtime calls `killSwitch.setGlobalStop(...)`.
- **Reconnect churn** → `reconnect_churn` reason and degraded.
- **Fail-closed**: Existing philosophy preserved; degraded and kill-switch behavior are additive.

---

## 8. Tests

- **lib/runtime/__tests__/stream-watchdog-degraded-tests.ts** (new):
  - Socket open + heartbeat only + no data ⇒ degraded.
  - Heartbeat alone never counts as real data flow.
  - Market data resumes ⇒ recovered.
  - Working orders + stale user stream ⇒ degraded.
  - User data silence with working orders ⇒ `user_data_silence_with_orders`.
  - Severe stream silence ⇒ kill switch suggested.
  - Reconnect churn ⇒ watchdog reason.
- **lib/runtime/__tests__/runtime-readiness-degraded-tests.ts**:
  - “All healthy” case updated to use connection state with `lastDataEventAt` set so that “real data flowing” is required for healthy.

**Run tests:**

- `npm run test:stream-watchdog`
- `npm run test:runtime-degraded`

---

## 9. Files changed

| File | Change |
|------|--------|
| `lib/runtime/stream-connection-state.ts` | Extended with optional freshness timestamps; `createInitialStreamConnectionState` and `cloneStreamConnectionState()`.
| `lib/runtime/stream-watchdog-config.ts` | **New** – threshold config.
| `lib/runtime/stream-watchdog.ts` | **New** – watchdog evaluation.
| `lib/polymarket/ws-market.ts` | Freshness timestamps; heartbeat does not update `lastDataEventAt`; `markRealDataEvent(type)`.
| `lib/polymarket/ws-user.ts` | Same pattern; `markRealDataEvent("order" \| "fill")`.
| `lib/runtime/runtime-degraded.ts` | Data-freshness rules; `market_data_silence`, `user_data_silence_with_orders`, `reconnect_churn`; new optional inputs.
| `lib/runtime/runtime-health.ts` | New stream and watchdog fields in interface and default.
| `worker/stream-runtime.ts` | Watchdog interval; getHealth() uses new thresholds and exposes new fields.
| `app/api/ops/runtime/dashboard/route.ts` | Exposes new stream and watchdog fields.
| `app/api/ops/runtime/snapshot/route.ts` | Same.
| `app/api/live/stream-health/route.ts` | Optional `runtime` block from worker heartbeat.
| `lib/runtime/__tests__/stream-watchdog-degraded-tests.ts` | **New** – watchdog and data-freshness tests.
| `lib/runtime/__tests__/runtime-readiness-degraded-tests.ts` | “All healthy” uses state with `lastDataEventAt`.
| `package.json` | Scripts `test:stream-watchdog`, `test:runtime-degraded`.
| `docs/STREAM_WATCHDOG_IMPLEMENTATION.md` | **New** – this summary.
