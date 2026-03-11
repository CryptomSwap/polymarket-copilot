/**
 * Rolling features and regime at a single timestep for backtest replay.
 * Pure functions from snapshot slices; no DB. Aligns with regime scanner thresholds.
 */

import type { PriceSnapshotRow } from "./data";
import type { BacktestFeatures, RegimeLabel } from "./types";

const MS_1H = 60 * 60 * 1000;
const MS_6H = 6 * 60 * 60 * 1000;
const MS_24H = 24 * 60 * 60 * 1000;
const MIN_SNAPSHOTS_FOR_RANGE = 3;

// Reuse regime classifier thresholds
const HOURS_NEAR_RESOLUTION = 72;
const LIQUIDITY_MIN = 0.15;
const TREND_UP_MIN = 0.58;
const TREND_DOWN_MAX = 0.42;
const VOLATILITY_MIN_FOR_RANGE = 0.05;

function classifyRegimeFromFeatures(
  rollingLow: number | null,
  rollingHigh: number | null,
  volatilityScore: number,
  trendScore: number,
  spreadLiquidityQuality: number,
  hoursToResolution: number | null
): RegimeLabel {
  if (hoursToResolution != null && hoursToResolution < HOURS_NEAR_RESOLUTION) {
    return "NEAR_RESOLUTION_UNSAFE";
  }
  if (spreadLiquidityQuality < LIQUIDITY_MIN) {
    return "ILLIQUID_NOISY";
  }
  if (trendScore >= TREND_UP_MIN) return "TRENDING_UP";
  if (trendScore <= TREND_DOWN_MAX) return "TRENDING_DOWN";
  if (
    volatilityScore >= VOLATILITY_MIN_FOR_RANGE &&
    rollingLow != null &&
    rollingHigh != null
  ) {
    return "RANGE_MEAN_REVERTING";
  }
  return "RANGE_MEAN_REVERTING";
}

/**
 * Compute backtest features at the last snapshot in the window.
 * Window = snapshots in [now - rollingWindowMs, now]; "now" = last snapshot's time.
 */
export function computeFeaturesAt(
  snapshots: PriceSnapshotRow[],
  nowMs: number,
  rollingWindowMs: number,
  marketEndDate: Date | null,
  liquidityFallback: number
): BacktestFeatures | null {
  if (snapshots.length === 0) return null;
  const windowStart = nowMs - rollingWindowMs;
  const inWindow = snapshots.filter((s) => s.capturedAt.getTime() <= nowMs && s.capturedAt.getTime() >= windowStart);
  const sorted = [...inWindow].sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime());
  if (sorted.length === 0) return null;

  const last = sorted[sorted.length - 1];
  const price = last.price > 0 && last.price < 1 ? last.price : 0.5;

  const p1h = sorted.find((s) => s.capturedAt.getTime() <= nowMs - MS_1H);
  const p6h = sorted.find((s) => s.capturedAt.getTime() <= nowMs - MS_6H);
  const p24h = sorted.find((s) => s.capturedAt.getTime() <= nowMs - MS_24H);
  const return1h = p1h && p1h.price > 0 ? (price - p1h.price) / p1h.price : 0;
  const return6h = p6h && p6h.price > 0 ? (price - p6h.price) / p6h.price : 0;
  const return24h = p24h && p24h.price > 0 ? (price - p24h.price) / p24h.price : 0;

  const avgReturn = [return1h, return6h, return24h].filter((r) => Number.isFinite(r));
  const trendScore =
    avgReturn.length > 0
      ? Math.max(0, Math.min(1, 0.5 + (avgReturn.reduce((a, b) => a + b, 0) / avgReturn.length) * 2))
      : 0.5;

  let rollingLow: number | null = null;
  let rollingHigh: number | null = null;
  if (sorted.length >= MIN_SNAPSHOTS_FOR_RANGE) {
    rollingLow = Math.min(...sorted.map((s) => s.price));
    rollingHigh = Math.max(...sorted.map((s) => s.price));
  }

  const prices = sorted.map((s) => s.price);
  const mean = prices.length > 0 ? prices.reduce((a, b) => a + b, 0) / prices.length : price;
  const variance =
    prices.length >= 2 ? prices.reduce((s, p) => s + (p - mean) ** 2, 0) / prices.length : 0;
  const vol = Math.sqrt(variance);
  const volatilityScore = Math.min(1, Math.max(0, vol * 10));

  let distanceFromRangeLow: number | null = null;
  let distanceFromRangeHigh: number | null = null;
  if (rollingLow != null && rollingHigh != null && rollingHigh > rollingLow) {
    distanceFromRangeLow = (price - rollingLow) / (rollingHigh - rollingLow);
    distanceFromRangeHigh = (rollingHigh - price) / (rollingHigh - rollingLow);
  }

  const liquidity = last.liquidity > 0 ? last.liquidity : liquidityFallback;
  const spreadLiquidityQuality = Math.min(1, Math.max(0, liquidity / 1e6));

  let hoursToResolution: number | null = null;
  if (marketEndDate) {
    const h = (marketEndDate.getTime() - nowMs) / (60 * 60 * 1000);
    hoursToResolution = h > 0 ? h : 0;
  }

  const regime = classifyRegimeFromFeatures(
    rollingLow,
    rollingHigh,
    volatilityScore,
    trendScore,
    spreadLiquidityQuality,
    hoursToResolution
  );

  return {
    price,
    rollingLow,
    rollingHigh,
    volatilityScore,
    trendScore,
    distanceFromRangeLow,
    distanceFromRangeHigh,
    spreadLiquidityQuality,
    hoursToResolution,
    regime,
    at: new Date(nowMs),
  };
}
