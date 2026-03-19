# NOOP Market Tradability Root Cause

**Purpose:** Explain why the strategy returns NOOP with reasons `market_not_tradable`, `market_stale`, and `no_signal` even when runtime readiness is healthy and automation is enabled, and what minimal fix or diagnostic makes intent generation reachable in paper mode.

---

## 1. Exact code path for `market_not_tradable`

**File:** `lib/runtime/bot-runtime/live-strategy-placeholder.ts`

```ts
// After risk gating and market health (stale/degraded) checks:
if (liquidity?.isTradable === false) {
  return { action: "NOOP", assetId, marketId, reason: "market_not_tradable" };
}
```

**When this runs:** The strategy has already confirmed `asset` exists, `health?.isStale` is false, and (if not `allowDegradedForPaper`) `health?.isDegraded` is false. So the only remaining gate before “favorable spread → UPDATE_QUOTES” is `liquidity.isTradable`.

**Where `liquidity.isTradable` is set:**

- **Market state engine** (`lib/runtime/market-state/market-state-engine.ts`): On every `applyQuoteUpdate` and `applyDepthUpdate`, the engine sets  
  `liquidity.isTradable = computeIsTradable(quote, depth, prev.liquidity, metricConfig)`.
- **`computeIsTradable`** (`lib/runtime/market-state/market-state-metrics.ts`):  
  - If `liquidity.isTradable` is already defined (from a previous patch), it returns that value.  
  - Otherwise it returns `isBookTradable(quote.bestBid, quote.bestAsk, depth.bidTopSize, depth.askTopSize, config)`.
- **`isBookTradable`** requires:
  - `bestBid` and `bestAsk` both non-null, `bestAsk > bestBid`
  - `spread >= config.minSpreadAbs` (default `0.0001`)
  - `(bidTopSize + askTopSize) >= config.minSizeForImbalance` (default `0.001`)

**Implication:** If the engine has only received **quote** updates (no depth), or depth is all null/zero, `bidTopSize + askTopSize` is 0 and `isBookTradable` is **false**. So **quote-only (or zero-depth) assets never get `isTradable === true`** and always hit `market_not_tradable` in the strategy.

**Runtime fields the check depends on:**

- `context.assetLiveState` from `snapshot.marketStateStore.getAsset(assetId)` (see `bot-context.ts`).
- `asset.liquidity.isTradable` (boolean) coming from the market state engine’s last quote/depth update.

**Are those fields missing/blank for subscribed assets?**

- If an asset is in the store but has only ever received quote updates (or depth never applied), `liquidity.isTradable` stays false (or default from empty state).
- Default empty state (`createEmptyAssetState` in `market-state-types.ts`) sets `liquidity.isTradable: false`, so any asset that has never had a “tradable” update will remain not tradable.

---

## 2. Exact code path for `market_stale`

**File:** `lib/runtime/bot-runtime/live-strategy-placeholder.ts`

```ts
if (asset) {
  const health = asset.health;
  // ...
  if (health?.isStale) {
    if (openOrders.length > 0) {
      return { action: "CANCEL_ORDERS", assetId, marketId, reason: "market_stale_cancel" };
    }
    return { action: "NOOP", assetId, marketId, reason: "market_stale" };
  }
  // ...
}
```

**When this runs:** For any asset that exists in context, the strategy checks `health.isStale` first (before tradability).

**Where `health.isStale` is set:**

- **On each quote/depth/trade update** (`market-state-engine.ts`): `buildHealthPatch(prev, now)` sets `lastMarketEventAt = now` and `isStale = isStale(now, now, healthConfig)` → **false**. So after any update, that asset’s health is fresh.
- **Periodic tick** (`market-state-engine.tick()`): For every asset in the store, it recomputes  
  `nowStale = isStale(asset.health.lastMarketEventAt ?? lastUpdateForAsset(asset), now, healthConfig)`  
  and patches `health.isStale` / `health.isDegraded` accordingly.
- **`isStale`** (`lib/runtime/market-state/market-state-health.ts`):  
  `lastMarketEventAt == null` → true; else `(now - lastMarketEventAt) >= config.staleAfterMs` (default **120_000** ms).

**Runtime fields the check depends on:**

- `asset.health.isStale`
- `asset.health.lastMarketEventAt` (and, in tick, `lastUpdateForAsset(asset)`)

**When are they missing/wrong?**

- **Asset not in store:** Then we never reach this branch; we hit `no_signal` (see below).
- **Asset in store but never updated:** Default empty state has `health.isStale: true`, `health.isDegraded: true`, so we get `market_stale` (or `market_degraded` if that branch is taken first).
- **Asset was updated long ago:** If no quote/depth/trade has been applied for >120s, the next `tick()` sets `isStale = true`, so subsequent evaluations return `market_stale`.

So `market_stale` is expected when: (1) asset exists but has never had a feed update, or (2) last update is older than `staleAfterMs`.

---

## 3. Exact code path for `no_signal`

**File:** `lib/runtime/bot-runtime/live-strategy-placeholder.ts`

```ts
const asset = getAssetState(context);  // ctx.assetLiveState from marketStateStore.getAsset(assetId)
// ...
if (asset) {
  // ... health and liquidity checks ...
} else {
  return { action: "NOOP", assetId, marketId, reason: "no_signal" };
}
// ... later, if spread/quality/mid fail:
return { action: "NOOP", assetId, marketId, reason: "no_signal" };
```

**Two cases:**

1. **Early `no_signal`:** `asset` is null. So `snapshot.marketStateStore.getAsset(assetId)` returned null. The store only gets an asset when the market state engine has applied at least one **quote**, **depth**, **trade**, or **repair** update for that `assetId`. If the bot evaluates an asset that was enqueued (e.g. via `riskGlobal` → `enqueueBatch(getTrackedAssetIds())`) but the engine has never received any update for it, `getAsset(assetId)` is null → **no_signal**.
2. **Late `no_signal`:** Asset exists and passed health/tradability, but the “favorable spread/liquidity” condition fails:  
   `spreadBps >= minSpreadBpsForQuotes` (default 5), `qualityScore >= minLiquidityForQuotes` (default 0.3), and `mid` finite. If any of these fail, the strategy falls through to the final `return { action: "NOOP", ..., reason: "no_signal" }`.

**Runtime fields:**

- For early no_signal: presence of `asset` in `marketStateStore` (i.e. at least one engine update for that asset).
- For late no_signal: `asset.quote.spreadBps`, `asset.liquidity.qualityScore`, `asset.quote.mid` (or bestBid/bestAsk).

---

## 4. How `noopReasonsByCode` is populated (cumulative vs current window)

**File:** `lib/runtime/telemetry/runtime-diagnostics.ts`

- On every `bot.decision.evaluated` event, if `action === "NOOP"` and `payload.reason` is a non-empty string, the diagnostics layer does  
  `safeIncr(this.noopReasonsByCode, p.reason.trim())`.
- `noopReasonsByCode` is included in `getSnapshot()` and is **reset only** when `diagnostics.reset()` is called (e.g. on worker restart or explicit reset).

So **noopReasonsByCode is cumulative** over the lifetime of the process (or since last reset), not a sliding window. High counts for `market_not_tradable` mean that, over that period, most NOOPs were due to tradability; they do not imply that “right now” every asset is untradable.

---

## 5. Are thresholds too strict for paper mode?

- **Stale/degraded:** Defaults are `staleAfterMs: 120_000`, `degradedAfterMs: 60_000`. For paper, `allowDegradedForPaper: true` is already passed by the worker so we do **not** NOOP for `market_degraded`; we only NOOP for `market_stale`. So degraded is already relaxed in paper.
- **Tradability:** The strict part is **requiring depth** for `isBookTradable`. In many feeds, depth may arrive later than quote or not at all for some books. That makes **market_not_tradable** the dominant blocker when quote-only (or thin depth) is common.
- **Strategy quote thresholds:** `minSpreadBpsForQuotes: 5`, `minLiquidityForQuotes: 0.3`. These are reasonable; the main issue is that we never reach them because we NOOP earlier on `liquidity.isTradable === false` or `no_signal` (no asset).

So for paper mode, the main source of “too strict” behavior is **requiring depth for tradability**, which prevents quote-only (or zero-depth) assets from ever being considered tradable and thus from reaching the spread/liquidity branch that could emit UPDATE_QUOTES.

---

## 6. Minimal safe fix to make intent generation reachable in paper mode

**Goal:** Allow some intents (e.g. UPDATE_QUOTES) in paper mode when we have a valid quote (spread, mid) but the book is currently marked not tradable (e.g. no or zero depth), without changing live behavior or the market state engine’s notion of “tradable.”

**Option A (recommended): Paper-only relaxation in the strategy**

1. Add an optional config flag, e.g. `allowQuoteOnlyForPaper?: boolean` (default `false`), to `LiveStrategyPlaceholderConfig`.
2. When `allowQuoteOnlyForPaper` is true and `liquidity?.isTradable === false`:
   - Do **not** return `market_not_tradable` immediately.
   - Fall through to the existing “favorable spread/liquidity → UPDATE_QUOTES” block.
3. In that block, when computing whether to emit UPDATE_QUOTES, if `qualityScore` is null (e.g. no depth) and `allowQuoteOnlyForPaper` is true, treat quality as acceptable for paper (e.g. use a sentinel like `0.5` for the threshold check so that `minLiquidityForQuotes` is satisfied).
4. Pass `allowQuoteOnlyForPaper: true` only when in paper mode (e.g. from the same place that sets `allowDegradedForPaper: true` in the worker).

Effect: In paper, quote-only or zero-depth assets can still produce UPDATE_QUOTES if spread and mid are valid; live behavior and engine semantics stay unchanged.

**Option B: Relax engine tradability when depth is missing (higher impact)**

- In `computeIsTradable` or in the engine, when depth is missing or zero, set `isTradable` from quote-only (e.g. valid two-sided quote and spread). This would change the engine’s meaning of “tradable” and could affect other consumers (guardrails, execution policy); it is a broader change and should be done only if desired for all modes.

**Recommendation:** Implement **Option A** so that paper mode can generate intents for quote-only books without altering the market state engine or live checks. After applying it, run the diagnostic script `npm run check:noop-reasons` and inspect `noopReasonsByCode` and intent counts to confirm that some assets are now intent-eligible.

**Implemented:** Option A is implemented. The strategy supports `allowQuoteOnlyForPaper` (default false). When true (worker passes it in paper mode), the strategy does not NOOP for `market_not_tradable` and uses a sentinel quality score (0.5) when `liquidity.qualityScore` is null so that quote-only assets with valid spread and mid can emit UPDATE_QUOTES. See `live-strategy-placeholder.ts` and `worker/stream-runtime.ts` (strategyConfig).

---

## 7. Summary table

| NOOP reason             | Code path (file:line)                    | Depends on (runtime fields)                          | Typical cause                                                                 |
|-------------------------|------------------------------------------|------------------------------------------------------|-------------------------------------------------------------------------------|
| `market_not_tradable`   | live-strategy-placeholder.ts:122         | `asset.liquidity.isTradable === false`               | Quote-only or zero depth; `isBookTradable` requires depth size ≥ minSizeForImbalance. |
| `market_stale`          | live-strategy-placeholder.ts:109–114     | `asset.health.isStale`                               | Asset never updated, or last update &gt; 120s ago (tick marks stale).         |
| `no_signal` (early)     | live-strategy-placeholder.ts:124         | `asset` null (not in store)                         | Asset enqueued but engine never received quote/depth/trade/repair for it.      |
| `no_signal` (late)      | live-strategy-placeholder.ts:166         | `quote.spreadBps`, `liquidity.qualityScore`, `mid`   | Spread or liquidity quality below strategy thresholds, or mid missing.         |

---

## 8. References

- Strategy: `lib/runtime/bot-runtime/live-strategy-placeholder.ts`
- Context build: `lib/runtime/bot-runtime/bot-context.ts` (`buildBotDecisionContext` → `marketStateStore.getAsset(assetId)`)
- Engine: `lib/runtime/market-state/market-state-engine.ts` (`applyQuoteUpdate`, `applyDepthUpdate`, `buildHealthPatch`, `tick`)
- Tradability: `lib/runtime/market-state/market-state-metrics.ts` (`computeIsTradable`, `isBookTradable`)
- Health: `lib/runtime/market-state/market-state-health.ts` (`isStale`, `isDegraded`, `DEFAULT_HEALTH_CONFIG`)
- Defaults / empty state: `lib/runtime/market-state/market-state-types.ts` (`createEmptyAssetState`, default liquidity/health)
- Diagnostics: `lib/runtime/telemetry/runtime-diagnostics.ts` (NOOP reason counting, reset)
- Diagnostic script: `tools/check-noop-reasons.ts` (run: `npm run check:noop-reasons`)
- Debug map: `audit-dumps/noop-market-tradability-debug-map.md`
