# ShadowCandidate intent path — root cause

## Observed state

- Market subscription coverage: non-empty `desiredTrackedAssetIds` and `currentlySubscribedAssetIds`, `inSync = true`, `lastSuccessfulSubscriptionSyncAt` recent.
- **ShadowCandidate total = 0.**
- Therefore the remaining blocker is that **`order.intent.created` is never emitted**, or the shadow recording path is never reached.

---

## 1. Where ShadowCandidate is created

ShadowCandidate rows are created only in **one place**: `lib/shadow-telemetry/record.ts` → `recordShadowCandidate()` → `prisma.shadowCandidate.create()`.

That function is **only** called from **worker/stream-runtime.ts**, inside the **`order.intent.created`** subscriber (wireIntentAndFillHandlers), in three situations:

| Path | When | wasBlocked |
|------|------|------------|
| **A** | Guardrails block (e.g. freshness, kill switch, exchange truth) | `true` |
| **B** | Execution policy blocks after intent created | `true` |
| **C** | Execution policy allows → intent ready for reconciliation | `false` |

So **no ShadowCandidate is created unless the `order.intent.created` handler runs**. The handler runs only when the event bus receives an `order.intent.created` event.

---

## 2. Where order.intent.created is emitted

`order.intent.created` is emitted in **one place**: **lib/runtime/bot-runtime/bot-runtime.ts** → `emitIntentIfNeeded()`:

- Called from `handleDecision(envelope)` **only when** `output.action !== "NOOP"`.
- So it is emitted only when the **live strategy placeholder** returns an action such as `UPDATE_QUOTES`, `PLACE_ENTRY`, `PLACE_EXIT`, `CANCEL_ORDERS`, or `REDUCE_RISK`.

So **if the strategy always returns NOOP, order.intent.created is never published** → the intent handler never runs → **ShadowCandidate is never created**.

---

## 3. Preconditions for ShadowCandidate creation (full chain)

For a ShadowCandidate row to be created, the following must all hold:

1. **Bot runtime is running**  
   - `botRuntime.start()` has been called (stream-runtime does this after rebuild).

2. **Scheduler receives market events**  
   - Event bus gets `market.quote.changed`, `market.depth.changed`, `market.liquidity.changed`, etc., from the **market state engine** (which is updated by the market WebSocket via `feedNormalizedUpdatesToEngine`).

3. **Scheduler evaluates an asset**  
   - Scheduler dequeues an asset and calls `handleDecision(envelope)` with a context built from **contextProvider.createSnapshot()** and **marketStateStore.getAsset(assetId)**.

4. **Strategy returns non-NOOP**  
   - `evaluateLiveStrategyPlaceholder(context, config)` must return an action that is not `NOOP`. It returns NOOP when:
     - **Risk:** `!risk.globalAutomationEnabled` (kill switch) → reason `"kill_switch"`.
     - **Risk:** `risk.haltedAssetIds?.includes(assetId)` → `"asset_halted"`.
     - **Market health:** `asset.health?.isStale` → `"market_stale"` (or CANCEL_ORDERS if open orders).
     - **Market health:** `asset.health?.isDegraded && !config.allowDegradedForPaper` → `"market_degraded"`.
     - **Market:** `liquidity?.isTradable === false` → `"market_not_tradable"`.
     - **No asset:** `asset` is null (e.g. no market state for that assetId) → `"no_signal"`.
     - **Position:** `position?.confidence === "degraded"` → `"position_degraded"`.
     - **Spread/liquidity:** `spreadBps`, `qualityScore`, or `mid` fail thresholds → `"no_signal"`.

5. **Intent handler runs**  
   - Subscriber receives `order.intent.created`. It can still exit **without** calling `recordShadowCandidate` in two cases:
     - `!this.isAutomationAllowed()` (i.e. `this.status !== "ready"`) → returns early; **no ShadowCandidate**.
     - `!isExecutionAllowed("runtime_automated")` (execution policy) → returns early; **no ShadowCandidate**.

   Only after that does it run guardrails and then either:
   - record ShadowCandidate (blocked) + return, or
   - create ledger intent → execution policy → record ShadowCandidate (blocked or allowed) or continue to reconcile.

So **ShadowCandidate total = 0** implies at least one of:

- **No `order.intent.created` events** (strategy always NOOP), or  
- **Intent handler returns before guardrails** (status !== `"ready"` or execution policy blocks), and in those early exits we **do not** call `recordShadowCandidate`.

The most likely case when subscription coverage is healthy is **strategy always NOOP**: no intents are ever emitted.

---

## 4. Is order.intent.created being emitted?

- **order.intent.created** is only emitted when the strategy returns a non-NOOP action.
- The **runtime diagnostics** (in-memory in the worker) count:
  - `bot.decision.evaluated` → number of strategy evaluations,
  - `decisionTypesByAction` → NOOP vs UPDATE_QUOTES vs etc.,
  - `noopReasonsByCode` → why NOOP was chosen,
  - `orderIntentsGenerated` → number of `order.intent.created` events.

These are exposed when the worker is running via:

- **Worker heartbeat** → stored in `WorkerHeartbeat.metadataJson` as `runtimeHealth.diagnostics`.
- **GET /api/ops/runtime/dashboard** → reads that heartbeat and returns `diagnostics` (e.g. `botEvaluations`, `orderIntentsGenerated`, `noopReasonsByCode`).

So:

- If **botEvaluations > 0** and **orderIntentsGenerated === 0** → strategy is running but **always returning NOOP**; the reason distribution is in `noopReasonsByCode` (e.g. `kill_switch`, `no_signal`, `market_stale`, `market_degraded`).
- If **botEvaluations === 0** → no strategy evaluations; either no market events are reaching the scheduler, or the bot runtime is not running / not subscribed.

---

## 5. Why the bot might choose NOOP (most likely blockers)

With market subscription in sync and data flowing:

1. **kill_switch**  
   - `risk.globalAutomationEnabled === false`.  
   - Fix: ensure kill switch is cleared (e.g. RuntimeControl clear) and that **watchdogState** is no longer reported as `kill_switch` after clear (see runtime readiness intent-unblock fix).

2. **no_signal**  
   - `marketStateStore.getAsset(assetId)` returns null, or the asset has no valid quote (e.g. `spreadBps`, `qualityScore`, or `mid` missing or below threshold).  
   - Possible causes: market state engine not receiving updates for that asset, or engine not publishing `market.quote.changed` (e.g. mid/spread unchanged so `maybeEmitQuoteEvent` skips), or store not populated for that assetId.

3. **market_stale** / **market_degraded**  
   - `asset.health.isStale` or `asset.health.isDegraded` (and not `allowDegradedForPaper`).  
   - Health is derived from last event time in the market state engine. If events are infrequent or threshold is tight, assets can stay stale/degraded.

4. **market_not_tradable**  
   - `liquidity.isTradable === false` in the asset state.

---

## 6. Exact minimal fix or next diagnostic

**Diagnostic (recommended first):**

- Run **tools/check-intent-emission.ts** (e.g. `npm run check:intent-emission`). It uses:
  - **GET /api/ops/runtime/dashboard** (when worker is running) for `botEvaluations`, `orderIntentsGenerated`, `noopReasonsByCode`, `intentsBlockedByMode`, `intentsBlockedByGuardrails`.
  - DB: recent Recommendations, OrderIntent, ExecutedOrder, ShadowCandidate.
- From that you get a **plain-English verdict** on whether the blocker is:
  - no strategy evaluations (no market events / scheduler),
  - strategy always NOOP (reasons in `noopReasonsByCode`),
  - or intents emitted but blocked before guardrails (status or execution policy).

**Minimal fix (depends on diagnostic):**

- If **no_signal** dominates: ensure market state engine is receiving and applying book/trade updates for tracked assets, and that it publishes quote/depth events (e.g. so that `getAsset(assetId)` has quote with spreadBps/qualityScore/mid). Optionally relax strategy thresholds (e.g. `minSpreadBpsForQuotes`, `minLiquidityForQuotes`) for paper mode.
- If **kill_switch** or **market_stale** / **market_degraded**: apply or verify the runtime readiness fixes (watchdogState only when kill switch active; userDataHealthy when no open orders; user truth freshness). Ensure `globalAutomationEnabled` is true after clear and that market/user data freshness is sufficient so the strategy and guardrails do not keep forcing NOOP.
- If **orderIntentsGenerated > 0** but **ShadowCandidate total still 0**: then intents are blocked before the guardrail/record path (e.g. `isAutomationAllowed()` false or execution policy). In that case, ensure runtime status is `"ready"` and execution policy allows `runtime_automated` when you expect shadow recording.

---

## 7. Summary

| Question | Answer |
|----------|--------|
| Where is ShadowCandidate created? | Only in `recordShadowCandidate()` in the **order.intent.created** handler in worker/stream-runtime.ts (guardrail block, execution policy block, or execution policy allow path). |
| What must happen before it is created? | order.intent.created must be emitted (strategy non-NOOP) and the handler must not return early (status === "ready", execution policy allows). Then guardrails/policy run and recordShadowCandidate is called. |
| Is order.intent.created emitted? | Only when strategy returns non-NOOP. Check runtime diagnostics: `orderIntentsGenerated` and `noopReasonsByCode` (via dashboard/heartbeat). |
| If not, what prevents it? | Strategy returns NOOP: typically kill_switch, no_signal, market_stale, or market_degraded. Use check-intent-emission and noopReasonsByCode to identify. |
| Is the bot choosing NOOP and why? | Yes if botEvaluations > 0 and orderIntentsGenerated === 0. Reason codes in noopReasonsByCode. |
| Minimal fix / next step? | Run check-intent-emission; then target the dominant NOOP reason (kill switch, no_signal, or market health) or the early-exit path (status / execution policy) as above. |
