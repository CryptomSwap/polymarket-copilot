# Freshness guardrail block — root cause and fix

**Observed:** Every emitted intent is blocked by guardrails; reason codes are freshness-related (`market_data_stale`, `user_data_stale`, `reconciliation_stale`). ShadowCandidates are all blocked; none allowed/submitted.

---

## 1. How the three freshness inputs are computed (at intent time)

Computed in `worker/stream-runtime.ts` in the `order.intent.created` handler, then passed to `guardrails.evaluate(..., { freshness })`.

| Input | Formula | Source state | Threshold |
|-------|--------|---------------|-----------|
| **marketDataFresh** | `market?.status !== "open" \|\| (market?.lastDataEventAt != null && now - lastDataEventAt <= threshold)` | `streamStatus.marketConnection` from `getStreamRuntimeStatus()` (market WS connection state). `lastDataEventAt` is set by the market WS when **real data** (book/quote/trade) is received. | `config.marketDataDegradedThresholdMs` = **60_000** ms (DEFAULT_STREAM_WATCHDOG_CONFIG). |
| **userDataFresh** | `user?.status !== "open" \|\| (user?.lastDataEventAt != null && now - lastDataEventAt <= threshold)` | `streamStatus.userConnection`. `lastDataEventAt` set by user WS when **real data** (order/fill) is received. | `config.userDataDegradedThresholdMs` = **90_000** ms. |
| **reconciliationFresh** | `!!lastRecAt && lastRecOk && now - new Date(lastRecAt) <= RECONCILE_FRESHNESS_MS` | `diagnostics.getSnapshot().lastRuntimeReconciliationAt` (ISO string), `lastRuntimeReconciliationStatus` ("ok" | "failure"). Set when `recordRuntimeReconciliationRun()` or `recordRuntimeReconciliationFailure()` is called after each reconciliation run. | **RECONCILE_FRESHNESS_MS** = **120_000** ms. |

So:

- **marketDataFresh** is false when the market socket is open but the last **real** market data event was more than 60s ago (heartbeat alone does not update `lastDataEventAt`).
- **userDataFresh** is false when the user socket is open but the last **real** user data event was more than 90s ago (and guardrails also require open orders to push USER_DATA_STALE).
- **reconciliationFresh** is false when there is no successful reconciliation timestamp, or the last run failed, or the last success was more than 120s ago.

---

## 2. What updates each source

| Input | Updated by | When |
|-------|------------|------|
| **market lastDataEventAt** | `lib/polymarket/ws-market.ts`: `markRealDataEvent()` | Called when the market WS receives book/quote/trade messages (not heartbeat). |
| **user lastDataEventAt** | `lib/polymarket/ws-user.ts`: `markRealDataEvent()` | Called when the user WS receives order/fill events. |
| **lastRuntimeReconciliationAt / Status** | `lib/runtime/telemetry/runtime-diagnostics.ts`: `recordRuntimeReconciliationRun()` / `recordRuntimeReconciliationFailure()` | Called from the stream-runtime reconcile interval (every **RUNTIME_RECONCILE_INTERVAL_MS** = 60s) after `runRuntimeReconciliation()` completes. Success → Run(), failure → Failure(). |

---

## 3. Why they may remain false in paper mode

- **marketDataFresh:** Market WS may not receive book/quote/trade events within 60s (e.g. subscription not yet active, or no trading activity on subscribed markets). Heartbeat does not set `lastDataEventAt`, so the timestamp can be old or null.
- **userDataFresh:** User WS may not receive order/fill events within 90s (e.g. no open orders or fills in paper). If there are no open orders, guardrails do not add USER_DATA_STALE, but the flag can still be false.
- **reconciliationFresh:** Reconciliation runs every 60s. If the first run fails (e.g. exchange truth pull fails or errors in paper), `lastRuntimeReconciliationStatus` is "failure" and `reconciliationFresh` is false. Even after one success, the strict check requires the last success to be within 120s, so any gap (e.g. slow run, clock skew) can make it false.

So in paper mode, strict time windows (60s / 90s / 120s) plus “real data only” and “last run success within 120s” make it easy for one or more of the three to be false and thus for guardrails to block every intent.

---

## 4. Dominant freshness blocker (from logs)

After the change below, when an intent is still blocked, the worker logs **"ShadowCandidate blocked (diagnostics)"** with:

- **freshnessInputSummary:** `marketDataFresh`, `userDataFresh`, `reconciliationFresh` (raw values before paper relaxation).
- **freshnessAgesMs:** `marketDataAgeMs`, `userDataAgeMs`, `reconciliationAgeMs`, and the thresholds, so you can see which condition failed and by how much.
- **dominantFreshnessBlocker:** array of which of the three were false (e.g. `["marketDataFresh","reconciliationFresh"]`).

From these, the dominant blocker is whichever of the three appears most often in logs when intents are blocked (or the one with the largest age over threshold).

---

## 5. Smallest correct fix: narrow paper-mode freshness relaxation

**Change (in `worker/stream-runtime.ts` only):** When **paper mode** is true, the values passed to guardrails for the three freshness flags are **relaxed** so that:

- **marketDataFresh:** `market?.status === "open"` (socket open is enough; we do not require `lastDataEventAt` within 60s).
- **userDataFresh:** `(user?.status === "open") || openOrders.length === 0` (socket open or no open orders; we do not require user data within 90s when there are no orders).
- **reconciliationFresh:** `!!lastRecAt && lastRecOk` (at least one successful reconciliation and last result "ok"; we do **not** require last success within 120s).

All other guardrail checks are unchanged (kill switch, limits, exchange truth when there are open orders, etc.). Only the three freshness inputs passed into `guardrails.evaluate()` are relaxed in paper mode. Live mode still uses the strict formulas.

---

## 6. Files changed

| File | Change |
|------|--------|
| **`worker/stream-runtime.ts`** | (1) Compute `marketDataAgeMs`, `userDataAgeMs`, `reconciliationAgeMs` for diagnostics. (2) When `this.options.paperMode === true`, build relaxed freshness for guardrails: `marketDataFreshForGuardrails` = market socket open, `userDataFreshForGuardrails` = user socket open or no open orders, `reconciliationFreshForGuardrails` = lastRecAt and lastRecOk (no 120s window). Pass these into `GuardrailFreshnessInput` instead of the strict values. (3) In the blocked-candidate diagnostic log, add `freshnessAgesMs`, `dominantFreshnessBlocker` (list of which raw freshness flags were false), and `paperModeRelaxationApplied`. |

---

## 7. Commands to verify

```bash
# 1) Restart worker (paper mode)
npm run worker

# 2) After sockets open and at least one successful reconciliation, check dashboard and ShadowCandidate counts
curl -s http://localhost:3000/api/ops/runtime/dashboard | jq '{ orderIntentsGenerated: .diagnostics.orderIntentsGenerated, intentsBlockedByGuardrails: .diagnostics.intentsBlockedByGuardrails }'

npm run check:shadow-pipeline
# Expect: allowed > 0 and/or submitted > 0 once relaxation applies and guardrails pass.
```

---

## 8. Evidence that allowed/submitted ShadowCandidates become reachable

- **Dashboard:** `intentsBlockedByGuardrails` stops increasing (or increases more slowly) once freshness is relaxed in paper; `orderIntentsGenerated` continues to increase.
- **check-shadow-pipeline:** ShadowCandidate **allowed** count and/or **submitted** count increase; recent rows show `wasBlocked: false`, `wasSubmitted: true` for some candidates.
- **Worker logs:** When an intent is allowed, there is no "ShadowCandidate blocked (diagnostics)" for that intent; when one is still blocked (e.g. by limits or exchange truth), the log still shows `dominantFreshnessBlocker` and `freshnessAgesMs` for diagnosis.
- **DB:** `SELECT COUNT(*) FROM "ShadowCandidate" WHERE "wasBlocked" = false` increases over time after the fix, with `wasSubmitted = true` for paper-submitted intents.

Relaxation applies only when `paperMode === true` and only to the three freshness inputs; all other guardrail logic is unchanged.
