# Root cause: intents blocked by market_degraded / not_tradable guardrails

## Summary

After paper-mode freshness relaxation, intents are still blocked by guardrails with `blockingReasons` mainly `["market_degraded","not_tradable"]`. The cause is a **policy mismatch**: the strategy was relaxed for paper (allowing UPDATE_QUOTES for degraded / not-tradable assets) but the guardrails were not, so they still block on the same asset state.

## Where guardrails assign these codes

**File:** `lib/runtime/risk/runtime-guardrails.ts`

- **`market_degraded`** (`GUARDRAIL_REASON_CODES.MARKET_DEGRADED`): pushed when `asset.health?.isDegraded === true` and `riskState.marketStateHealthGatingEnabled` is true (lines 257–259). Only added when `!options?.allowDegradedAndNotTradableForPaper`.
- **`not_tradable`** (`GUARDRAIL_REASON_CODES.NOT_TRADABLE`): pushed when `asset.liquidity?.isTradable === false` (lines 270–272). Only added when `!options?.allowDegradedAndNotTradableForPaper`.
- **`market_stale`** (`GUARDRAIL_REASON_CODES.MARKET_STALE`): pushed when `asset.health?.isStale === true`. Also skipped when `allowDegradedAndNotTradableForPaper` is true.

Runtime fields used:

| Code             | Field                          | Source                |
|------------------|--------------------------------|------------------------|
| market_degraded  | `asset.health.isDegraded`      | Market state engine   |
| not_tradable     | `asset.liquidity.isTradable`   | Market state engine   |
| market_stale     | `asset.health.isStale`        | Market state engine   |

Additional guardrail checks in the same block: `asset.health?.isStale`, `qualityScore < minLiquidityQualityScore` → `LIQUIDITY_BELOW_THRESHOLD`, `spreadBps < minQuoteSpreadBps` → `SPREAD_BELOW_THRESHOLD`. Asset comes from `getAssetLiveState(context)` (i.e. `context.assetLiveState`), same snapshot the strategy uses.

## Strategy allow-path vs guardrail block-path

- **Strategy** (`live-strategy-placeholder.ts`): In paper mode, `allowDegradedForPaper` and `allowQuoteOnlyForPaper` skip NOOP for `market_degraded` and `market_not_tradable`. The strategy can therefore emit UPDATE_QUOTES for assets with `health.isDegraded === true` and `liquidity.isTradable === false`.
- **Guardrails** (before fix): Always evaluated `asset.health?.isDegraded` and `asset.liquidity?.isTradable` from the same `context.assetLiveState`. No paper-mode relaxation, so they blocked those intents.

So the same asset that the strategy allows (due to paper relaxations) was blocked by guardrails because guardrails did not have an equivalent relaxation. This is a **policy mismatch**, not stale or miscomputed state: the strategy and guardrails use the same snapshot; the strategy was relaxed for paper, the guardrails were not.

## Fix (minimal, paper-mode only)

1. **New option** in `GuardrailEvaluationOptions`: `allowDegradedAndNotTradableForPaper?: boolean`.
2. **In `DefaultRuntimeGuardrails.evaluate()`**: When `options?.allowDegradedAndNotTradableForPaper === true`, do **not** push:
   - `MARKET_STALE`
   - `MARKET_DEGRADED`
   - `NOT_TRADABLE`
3. **In worker** (`worker/stream-runtime.ts`): When handling `order.intent.created`, pass `allowDegradedAndNotTradableForPaper: paperMode` (i.e. `this.options.paperMode === true`) into `guardrails.evaluate(..., { freshness, allowDegradedAndNotTradableForPaper: paperMode })`.

This aligns guardrails with the strategy’s paper-mode behavior so that shadow-only intents for degraded / not-tradable markets can become allowed and reach submitted ShadowCandidates. Live guardrails are unchanged when the option is not set.

## Diagnostics added

When an intent is blocked, the worker logs **`ShadowCandidate blocked (diagnostics)`** with:

- **`marketHealthAndLiquidity`** (when `context.assetLiveState` is present):
  - `assetId`, `healthIsDegraded`, `healthIsStale`, `healthLastMarketEventAt` (ISO string)
  - `liquidityIsTradable`, `liquidityQualityScore`
  - `quoteBestBid`, `quoteBestAsk`, `quoteMid`, `quoteSpreadBps`
  - `depthBidTopSize`, `depthAskTopSize`
- **`blockingReasonCodes`**: exact guardrail reason codes (e.g. `["market_degraded","not_tradable"]`).
- **`allowDegradedAndNotTradableForPaper`**: whether the paper-mode relaxation was passed to guardrails (should be true in paper mode).

Use these to confirm which asset state drove the block and that the new option is applied.

## Files changed

- **`lib/runtime/risk/runtime-guardrails.ts`**
  - Extended `GuardrailEvaluationOptions` with `allowDegradedAndNotTradableForPaper` and optional `guardrailDiagnosticLog`.
  - In the market-state block: only push `MARKET_STALE`, `MARKET_DEGRADED`, `NOT_TRADABLE` when `!skipMarketHealthForPaper` (where `skipMarketHealthForPaper = options?.allowDegradedAndNotTradableForPaper === true`). When the asset block runs, call `options?.guardrailDiagnosticLog?.({ allowDegradedAndNotTradableForPaper, skipMarketHealthForPaper })` so the caller can log what the guardrails received.
- **`worker/stream-runtime.ts`**
  - Constructor: log `StreamRuntime options (paperMode for guardrail relaxation)` with `paperMode` and `allowDegradedAndNotTradableForPaperWillBe`.
  - Intent handler: on first intent, log `Intent handler paperMode (first intent)` with `paperModeFromOptions`, `paperMode`, `allowDegradedAndNotTradableForPaper`.
  - Pass `allowDegradedAndNotTradableForPaper: paperMode` and `guardrailDiagnosticLog` (first 5 invocations) into `guardrails.evaluate(...)`.
  - In the blocked-intent branch, add `marketHealthAndLiquidity` to `ShadowCandidate blocked (diagnostics)` and add `paperMode`, `allowDegradedAndNotTradableForPaper`, `blockingReasonCodes` to both that log and `Intent blocked by guardrails`.

## Why the relaxation might not be taking effect (diagnosis)

If intents are still blocked with `["market_degraded","not_tradable"]` after the fix:

1. **`paperMode` is false at runtime**  
   `allowDegradedAndNotTradableForPaper` is only set when `this.options.paperMode === true`. If the worker does not pass `paperMode: true` when creating `StreamRuntime`, or a different entry point creates the runtime without that option, the relaxation is never applied.

2. **Options not received in guardrails**  
   The fourth argument to `guardrails.evaluate(..., options)` must be the same object that includes `allowDegradedAndNotTradableForPaper`. If a wrapper or alternate code path calls `evaluate` without that option, the guardrails will still add the codes.

3. **Stale build**  
   An old build of `runtime-guardrails.ts` (without the `skipMarketHealthForPaper` checks) could be running. Rebuild and restart the worker.

4. **Single call site**  
   The only handler that calls `guardrails.evaluate` for intents is the `order.intent.created` subscriber in `worker/stream-runtime.ts` (`wireIntentAndFillHandlers`). There are no other guardrail evaluation paths for these intents.

## Diagnostics added for “relaxation not taking effect”

- **At StreamRuntime construction**  
  Log: `StreamRuntime options (paperMode for guardrail relaxation)` with `paperMode` and `allowDegradedAndNotTradableForPaperWillBe`. Confirms what the runtime was constructed with.

- **On first intent**  
  Log: `Intent handler paperMode (first intent)` with `paperModeFromOptions`, `paperMode`, `allowDegradedAndNotTradableForPaper`. Confirms what the intent handler uses when calling guardrails.

- **Inside guardrails (first 5 intents with asset + health gating)**  
  Log: `guardrail market-health option (from guardrails)` with `allowDegradedAndNotTradableForPaper`, `skipMarketHealthForPaper`, `callCount`. Confirms what the guardrails module received and computed.

- **On every blocked intent**  
  Log: `Intent blocked by guardrails` and `ShadowCandidate blocked (diagnostics)` now include `paperMode`, `allowDegradedAndNotTradableForPaper`, and `blockingReasonCodes`. If you see `blockingReasonCodes: ["market_degraded","not_tradable"]` and `allowDegradedAndNotTradableForPaper: true`, the option is being passed but the running guardrails code is not applying the skip (e.g. stale build). If `allowDegradedAndNotTradableForPaper: false`, then `paperMode` is false at the call site (wrong options or entry point).

## How to verify

1. Run worker in paper mode: `npm run worker` (with paper mode enabled).
2. Confirm in logs:
   - **Startup:** `StreamRuntime options (paperMode for guardrail relaxation)` with `paperMode: true`, `allowDegradedAndNotTradableForPaperWillBe: true`.
   - **First intent:** `Intent handler paperMode (first intent)` with `paperMode: true`, `allowDegradedAndNotTradableForPaper: true`.
   - **First 5 asset evaluations in guardrails:** `guardrail market-health option (from guardrails)` with `skipMarketHealthForPaper: true`.
   - For previously blocked intents, either `verdict === "allowed"` or `blockingReasonCodes` no longer dominated by `market_degraded` / `not_tradable`.
3. Run shadow pipeline check: `npm run check:shadow-pipeline` (or equivalent). Expect:
   - `allowed` / `submitted` / `evaluated` counts to increase.
   - New ShadowCandidate rows with `wasBlocked: false` for assets that were previously blocked only by market_degraded/not_tradable.

**Exact verification command (after restart):**

```bash
npm run worker
```

Then inspect runtime logs for the lines above. If `paperMode` or `allowDegradedAndNotTradableForPaper` is false, fix the StreamRuntime construction (e.g. ensure `worker/index.ts` passes `paperMode: true`). If both are true but `skipMarketHealthForPaper` is false in the guardrail log, the guardrails module is not receiving the option or an old build is running.

## Evidence that allowed/submitted ShadowCandidates are reachable

- **Before:** All intents blocked by guardrails; `blockingReasons` mainly `["market_degraded","not_tradable"]`; `intentsBlockedByGuardrails === orderIntentsGenerated`.
- **After (with fix):** For paper mode, guardrails no longer add `market_degraded` or `not_tradable` (or `market_stale`) when `allowDegradedAndNotTradableForPaper` is true. Intents that were blocked only by those codes now get `verdict === "allowed"`, flow to submission (paper), and produce ShadowCandidates with `wasBlocked: false` and non-zero allowed/submitted/evaluated counts in the shadow pipeline report.
