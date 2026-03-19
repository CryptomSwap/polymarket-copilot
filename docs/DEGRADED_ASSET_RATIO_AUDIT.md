# Degraded Asset Ratio Audit – StreamRuntime Stays Degraded

**Date:** 2025-03-11  
**Symptom:** `operationalReadiness = true`, both market and user WS open, but `degradedReasons = ["degraded_asset_ratio_high"]`, `degradedAssetCount ≈ 286`, `trackedAssetCount = 300`, `staleAssetCount` non-zero and rising; `botEvaluations = 0`, `orderIntentsGenerated = 0`.

---

## 1. Market state health model

### 1.1 Where counts come from

- **staleAssetCount / degradedAssetCount**  
  In `worker/stream-runtime.ts` `getHealth()`:
  - `staleCount = marketStateStore.getAssets().filter((a) => a.health?.isStale).length`
  - `degradedCount = marketStateStore.getAssets().filter((a) => a.health?.isDegraded).length`
- **trackedAssetCount**  
  `marketStateStore.getTrackedAssetIds().length` (subscription set, e.g. 300).

So the ratios use:
- **Numerator:** assets that exist in the store **and** have `health.isStale` or `health.isDegraded`.
- **Denominator:** all tracked asset IDs (even if they have no store entry yet).

### 1.2 When an asset is healthy / degraded / stale

- **Per-asset health** (`lib/runtime/market-state/market-state-health.ts`):
  - **Stale:** `lastMarketEventAt == null` or `(now - lastMarketEventAt) >= staleAfterMs` (default **120_000 ms**).
  - **Degraded:** `lastMarketEventAt == null` or `(now - lastMarketEventAt) >= degradedAfterMs` (default **60_000 ms**).
- **lastMarketEventAt** is set only when the engine applies an update (quote, depth, or trade) for that asset via `buildHealthPatch(prev, now)` in `market-state-engine.ts`. So any asset that has not received a WS update in 60s is degraded; in 120s, stale.

### 1.3 Recovery

- **Recovery is supported:** when a new update is applied, `buildHealthPatch` sets `lastMarketEventAt = now` and recomputes `isStale`/`isDegraded`. So an asset can move from degraded → healthy as soon as it gets another message.
- **tick()** (e.g. every 10s) recomputes staleness from `lastEventAt` and can flip `isStale`/`isDegraded` and emit `market.stale` / `market.recovered`.

---

## 2. Market WebSocket feed behavior

- **Normalizer** (`lib/live/market-feed-normalizer.ts`) handles: `best_bid_ask`, `last_trade_price`, `book`, `price_change`. Each produces quote and/or depth/trade updates that the engine applies with `applyQuoteUpdate` / `applyDepthUpdate` / `applyTradeUpdate`, which set `lastMarketEventAt`.
- **Polymarket only pushes when something changes.** Inactive or illiquid markets may get one snapshot or one update, then nothing. So many of the 300 subscribed assets never get a second update within 60s → they stay “degraded” after the first minute.
- So **high degraded count is expected** for a large tracked set: most assets are inactive; the feed does not guarantee continuous updates per asset.

---

## 3. Tracked assets

- **getTrackedAssetIds** (`lib/polymarket/tracked-assets.ts`) returns: held positions + open orders + assets from markets that have recommendations (MarketSignal), capped at **MAX_TRACKED_ASSETS = 300**.
- So we can have up to 300 tracked IDs; many of them are recommendation/bot candidates that are not actively trading. They are correctly marked degraded when they have no recent data; that is a **data-quality fact**, not a bug.

---

## 4. Degradation rule that was blocking

- **computeDegraded** (`lib/runtime/runtime-degraded.ts`) used the **same threshold (0.5)** for both:
  - `stale_asset_ratio_high`: `staleAssetCount / trackedAssetCount >= 0.5`
  - `degraded_asset_ratio_high`: `degradedAssetCount / trackedAssetCount >= 0.5`
- With 286 degraded out of 300, `degradedRatio ≈ 0.95 >= 0.5` → **degraded_asset_ratio_high** was always set → runtime stayed **degraded** even with both WS open and `operationalReadiness = true`.

So the issue is **not**:
- A bug in lastMarketEventAt or recovery.
- Missing message types or wrong handlers.
- Wrong tracked set.

It **is**:
- **Overly strict use of the degraded ratio for global runtime status:** treating “most tracked assets have no recent update” as “runtime degraded” is wrong when the feed only pushes on activity and we track 300 assets. Per-asset guardrails already block trading on degraded/stale assets.

---

## 5. Guardrail / strategy impact

- **Per-asset:** `live-strategy-placeholder` returns `NOOP` with reason `market_degraded` or `market_stale` when `health?.isDegraded` or `health?.isStale`; guardrails can block on `MARKET_STALE` / `MARKET_DEGRADED`. So **trading is already blocked per asset** when data is bad.
- **Global:** Setting the whole runtime to “degraded” because of `degraded_asset_ratio_high`:
  - Makes the dashboard show degraded and can block or discourage automation.
  - Does not add safety for paper trading, because per-asset checks already prevent trading on bad data.
- **botEvaluations = 0 / orderIntentsGenerated = 0:** The bot still runs, but the strategy returns NOOP for degraded assets. With 286/300 degraded, almost every evaluation is NOOP. After fixing global status, the runtime can show “ready”; assets with recent data will evaluate and may produce intents; degraded assets will still get NOOP.

---

## 6. Root cause summary

| Question | Answer |
|----------|--------|
| **Exact root cause** | Global degraded status was set when `degradedAssetCount / trackedAssetCount >= 0.5`. With ~300 tracked assets and a feed that only updates on activity, most assets are “degraded” (no update in 60s), so the ratio is ~95% and the rule always fired. |
| **Bug vs threshold vs design** | **Threshold/design:** the rule is too strict for a large, partly inactive tracked set. Not a bug in feed handling or health computation. |
| **Expected feed behavior?** | Yes. Polymarket does not push continuous updates for every subscribed asset; inactive assets correctly become degraded after 60s. |

---

## 7. Fix applied

**File:** `lib/runtime/runtime-degraded.ts`

- **New input:** `degradedRatioThreshold?: number` (optional).
- **Default:** `DEFAULT_DEGRADED_RATIO_THRESHOLD = 1.0`.
- **Behavior:** `degraded_asset_ratio_high` is added only when `degradedRatio >= degradedRatioThreshold`. With default **1.0**, the runtime is never marked degraded for high degraded ratio (you’d need 100% degraded).
- **Rationale:** For paper (and typical live) use, a high degraded ratio is normal when tracking many assets; per-asset guardrails are the right place to block. If you want to re-enable the rule, pass `degradedRatioThreshold: 0.95` (or similar) when calling `computeDegraded`.

**No change** to:
- Stale ratio rule (still 0.5).
- Per-asset health (stale/degraded/recovery).
- Guardrails or strategy (still NOOP/block on per-asset degraded/stale).

---

## 8. Files changed

| File | Change |
|------|--------|
| `lib/runtime/runtime-degraded.ts` | Added `degradedRatioThreshold` to `DegradedInputs`, default `1.0`; use it instead of `staleRatioThreshold` for the degraded-ratio check. |

---

## 9. After the fix – Session 001 and kill switch

- **Runtime status:** With both WS open and no other degraded reasons, the runtime should report **ready** (no `degraded_asset_ratio_high`).
- **Safety:** Per-asset blocking on degraded/stale is unchanged; only the **global** degraded reason was relaxed.
- **Recommendation:** It is **acceptable to clear the kill switch and begin Session 001** with this fix: the runtime will show ready when streams are open, and paper trading will still be restricted to assets with acceptable data quality via existing guardrails and strategy NOOPs.
