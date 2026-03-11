/**
 * Pure derived-metric computation for live market state.
 * No store mutation; intended for use by Market State Engine when applying quote/depth/trade inputs.
 */

import type { AssetDepth, AssetLastTrade, AssetLiveState, AssetLiquidity, AssetQuote } from "./market-state-types";

// ---------- Configurable thresholds (engine can override via helpers that accept config) ----------

export interface MetricConfig {
  /** Minimum spread (abs) to consider quote valid; below this spread may be treated as crossed/tiny. */
  minSpreadAbs: number;
  /** Minimum total size (bid + ask) for meaningful imbalance; avoid div-by-zero. */
  minSizeForImbalance: number;
  /** Minimum liquidity (notional) to consider book tradable. */
  minLiquidityNotional: number;
  /** Max spread bps above which liquidity quality is penalized. */
  maxSpreadBpsForFullQuality: number;
  /** Probability market price bounds [0, 1]; used for valid mid. */
  priceFloor: number;
  priceCap: number;
}

export const DEFAULT_METRIC_CONFIG: MetricConfig = {
  minSpreadAbs: 0.0001,
  minSizeForImbalance: 0.001,
  minLiquidityNotional: 1,
  maxSpreadBpsForFullQuality: 50,
  priceFloor: 0,
  priceCap: 1,
};

// ---------- Safe numeric handling (project-consistent) ----------

function safeNum(value: number | null | undefined): number | null {
  if (value == null) return null;
  return Number.isFinite(value) ? value : null;
}

function safeNumOrZero(value: number | null | undefined): number {
  const n = safeNum(value);
  return n ?? 0;
}

// ---------- Quote-derived metrics ----------

/**
 * Mid price from best bid and ask. Returns null if either is missing or invalid.
 * Intended for use when applying quote updates.
 */
export function computeMidFromQuote(
  bestBid: number | null | undefined,
  bestAsk: number | null | undefined
): number | null {
  const bid = safeNum(bestBid);
  const ask = safeNum(bestAsk);
  if (bid == null || ask == null) return null;
  const mid = (bid + ask) / 2;
  return Number.isFinite(mid) ? mid : null;
}

/**
 * Absolute spread (ask - bid). Returns null if either side missing.
 */
export function computeSpreadAbs(
  bestBid: number | null | undefined,
  bestAsk: number | null | undefined
): number | null {
  const bid = safeNum(bestBid);
  const ask = safeNum(bestAsk);
  if (bid == null || ask == null) return null;
  const spread = ask - bid;
  return Number.isFinite(spread) ? spread : null;
}

/**
 * Spread in basis points. Uses mid for conversion; if mid is 0 or invalid, returns null.
 */
export function computeSpreadBps(
  bestBid: number | null | undefined,
  bestAsk: number | null | undefined,
  midOverride?: number | null
): number | null {
  const spread = computeSpreadAbs(bestBid, bestAsk);
  if (spread == null || spread < 0) return null;
  const mid = midOverride != null ? safeNum(midOverride) : computeMidFromQuote(bestBid, bestAsk);
  if (mid == null || mid <= 0 || !Number.isFinite(mid)) return null;
  const bps = (spread / mid) * 10_000;
  return Number.isFinite(bps) ? bps : null;
}

// ---------- Depth-derived metrics ----------

/**
 * Top-of-book imbalance: (bidSize - askSize) / (bidSize + askSize).
 * Returns value in [-1, 1]; null if insufficient size or both zero.
 */
export function computeTopOfBookImbalance(
  bidTopSize: number | null | undefined,
  askTopSize: number | null | undefined,
  config: MetricConfig = DEFAULT_METRIC_CONFIG
): number | null {
  const bid = safeNumOrZero(bidTopSize);
  const ask = safeNumOrZero(askTopSize);
  const total = bid + ask;
  if (total < config.minSizeForImbalance) return null;
  const imb = (bid - ask) / total;
  return Number.isFinite(imb) ? imb : null;
}

/**
 * Near-touch (1% depth) imbalance: (bidDepth1pct - askDepth1pct) / (bidDepth1pct + askDepth1pct).
 * Null if insufficient total depth.
 */
export function computeNearTouchDepthImbalance(
  bidDepth1pct: number | null | undefined,
  askDepth1pct: number | null | undefined,
  config: MetricConfig = DEFAULT_METRIC_CONFIG
): number | null {
  const bid = safeNumOrZero(bidDepth1pct);
  const ask = safeNumOrZero(askDepth1pct);
  const total = bid + ask;
  if (total < config.minSizeForImbalance) return null;
  const imb = (bid - ask) / total;
  return Number.isFinite(imb) ? imb : null;
}

// ---------- Return / volatility (placeholders) ----------

/**
 * One-minute return: (currentPrice - price1mAgo) / price1mAgo.
 * Returns null if either price missing or price1mAgo is 0.
 */
export function computeReturn1m(
  currentPrice: number | null | undefined,
  price1mAgo: number | null | undefined
): number | null {
  const curr = safeNum(currentPrice);
  const past = safeNum(price1mAgo);
  if (curr == null || past == null || past <= 0) return null;
  const ret = (curr - past) / past;
  return Number.isFinite(ret) ? ret : null;
}

/**
 * Rolling realized volatility placeholder: std dev of returns over a window.
 * Caller supplies array of period returns; returns annualized vol proxy or null if insufficient data.
 * Engine can feed this from a rolling buffer of mid prices or returns.
 */
export function computeRollingRealizedVolatilityPlaceholder(
  periodReturns: number[],
  periodsPerYear: number = 365 * 24 * 60
): number | null {
  if (periodReturns.length < 2) return null;
  const mean = periodReturns.reduce((a, b) => a + b, 0) / periodReturns.length;
  const variance =
    periodReturns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (periodReturns.length - 1);
  if (!Number.isFinite(variance) || variance < 0) return null;
  const vol = Math.sqrt(variance * periodsPerYear);
  return Number.isFinite(vol) ? vol : null;
}

// ---------- Liquidity quality ----------

/**
 * Liquidity quality score in [0, 1] from quote and depth.
 * Penalizes wide spread and thin depth; configurable via MetricConfig.
 */
export function computeLiquidityQualityScore(
  bestBid: number | null | undefined,
  bestAsk: number | null | undefined,
  bidTopSize: number | null | undefined,
  askTopSize: number | null | undefined,
  config: MetricConfig = DEFAULT_METRIC_CONFIG
): number | null {
  const bid = safeNumOrZero(bestBid);
  const ask = safeNumOrZero(bestAsk);
  const bidSize = safeNumOrZero(bidTopSize);
  const askSize = safeNumOrZero(askTopSize);
  const mid = computeMidFromQuote(bestBid, bestAsk);
  if (mid == null || mid <= 0) return null;
  const spreadBps = computeSpreadBps(bestBid, bestAsk, mid);
  const notional = bid * bidSize + ask * askSize;
  if (notional < config.minLiquidityNotional) return 0;
  let score = 1;
  if (spreadBps != null && spreadBps > config.maxSpreadBpsForFullQuality) {
    score *= Math.max(0, 1 - (spreadBps - config.maxSpreadBpsForFullQuality) / 1000);
  }
  return Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : null;
}

// ---------- Tradability checks ----------

/**
 * Whether the book is tradable: valid two-sided quote, sufficient spread, and optional min size.
 */
export function isBookTradable(
  bestBid: number | null | undefined,
  bestAsk: number | null | undefined,
  bidTopSize: number | null | undefined,
  askTopSize: number | null | undefined,
  config: MetricConfig = DEFAULT_METRIC_CONFIG
): boolean {
  const bid = safeNum(bestBid);
  const ask = safeNum(bestAsk);
  if (bid == null || ask == null) return false;
  if (ask <= bid) return false;
  const spread = computeSpreadAbs(bestBid, bestAsk);
  if (spread == null || spread < config.minSpreadAbs) return false;
  const bidSize = safeNumOrZero(bidTopSize);
  const askSize = safeNumOrZero(askTopSize);
  return bidSize + askSize >= config.minSizeForImbalance;
}

/**
 * Combined tradability from quote, depth, and existing liquidity block.
 * Respects liquidity.isTradable if already set; otherwise derives from book.
 */
export function computeIsTradable(
  quote: AssetQuote,
  depth: AssetDepth,
  liquidity: AssetLiquidity,
  config: MetricConfig = DEFAULT_METRIC_CONFIG
): boolean {
  if (liquidity.isTradable !== undefined && liquidity.isTradable !== null) {
    return liquidity.isTradable;
  }
  return isBookTradable(
    quote.bestBid,
    quote.bestAsk,
    depth.bidTopSize,
    depth.askTopSize,
    config
  );
}

// ---------- Aggregate from AssetLiveState (pure read) ----------

/**
 * Latest timestamp from any updated block. For use by metrics computer and health.
 */
export function lastUpdateForAsset(a: AssetLiveState): Date | null {
  const candidates = [
    a.quote.updatedAt,
    a.lastTrade.timestamp,
    a.depth.updatedAt,
    a.volatility.updatedAt,
    a.liquidity.updatedAt,
    a.health.lastMarketEventAt,
    a.health.lastRepairAt,
  ].filter((d): d is Date => d != null);
  if (candidates.length === 0) return null;
  return new Date(Math.max(...candidates.map((d) => d.getTime())));
}

/**
 * Recompute quote-derived fields (mid, spreadAbs, spreadBps) from quote block.
 * Returns partial quote patch; engine applies to store via patchAsset.
 */
export function deriveQuoteMetrics(
  quote: AssetQuote,
  config: MetricConfig = DEFAULT_METRIC_CONFIG
): Partial<Pick<AssetQuote, "mid" | "spreadAbs" | "spreadBps">> {
  const mid = computeMidFromQuote(quote.bestBid, quote.bestAsk);
  const spreadAbs = computeSpreadAbs(quote.bestBid, quote.bestAsk);
  const spreadBps = computeSpreadBps(quote.bestBid, quote.bestAsk, mid);
  const out: Partial<Pick<AssetQuote, "mid" | "spreadAbs" | "spreadBps">> = {};
  if (mid != null) out.mid = mid;
  if (spreadAbs != null) out.spreadAbs = spreadAbs;
  if (spreadBps != null) out.spreadBps = spreadBps;
  return out;
}

/**
 * Recompute depth-derived imbalance fields from depth block.
 */
export function deriveDepthImbalances(
  depth: AssetDepth,
  config: MetricConfig = DEFAULT_METRIC_CONFIG
): Partial<Pick<AssetDepth, "imbalanceTop" | "imbalance1pct">> {
  const imbalanceTop = computeTopOfBookImbalance(
    depth.bidTopSize,
    depth.askTopSize,
    config
  );
  const imbalance1pct = computeNearTouchDepthImbalance(
    depth.bidDepth1pct,
    depth.askDepth1pct,
    config
  );
  const out: Partial<Pick<AssetDepth, "imbalanceTop" | "imbalance1pct">> = {};
  if (imbalanceTop != null) out.imbalanceTop = imbalanceTop;
  if (imbalance1pct != null) out.imbalance1pct = imbalance1pct;
  return out;
}

// ---------- Aggregated metrics type and computer ----------

export interface MarketStateMetrics {
  trackedAssetCount: number;
  lastUpdateAt: Date | null;
}

export interface MarketStateMetricsComputer {
  computeForAssets(assets: Iterable<AssetLiveState>): MarketStateMetrics;
}

export class BasicMarketStateMetricsComputer implements MarketStateMetricsComputer {
  computeForAssets(assets: Iterable<AssetLiveState>): MarketStateMetrics {
    let count = 0;
    let last: Date | null = null;
    for (const a of assets) {
      count++;
      const t = lastUpdateForAsset(a);
      if (t && (!last || t > last)) last = t;
    }
    return {
      trackedAssetCount: count,
      lastUpdateAt: last,
    };
  }
}
