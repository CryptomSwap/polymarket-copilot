/**
 * Mean-reversion strategy: entry and exit rules for backtest.
 * Deterministic, threshold-based. Reuses policy/regime concepts.
 */

import type { BacktestFeatures } from "./types";

export interface StrategyConfig {
  targetProfitPct: number;
  maxHoldHours: number;
  minLiquidity: number;
  nearResolutionHours: number;
  entryNearLowThreshold: number;
  exitNearHighThreshold: number;
}

export function canEnter(config: StrategyConfig, f: BacktestFeatures): { ok: boolean; reason?: string } {
  if (f.regime !== "RANGE_MEAN_REVERTING") {
    return { ok: false, reason: "regime_not_range" };
  }
  if (f.distanceFromRangeLow == null || f.distanceFromRangeLow >= config.entryNearLowThreshold) {
    return { ok: false, reason: "not_near_low" };
  }
  if (f.spreadLiquidityQuality < config.minLiquidity) {
    return { ok: false, reason: "low_liquidity" };
  }
  if (f.hoursToResolution != null && f.hoursToResolution < config.nearResolutionHours) {
    return { ok: false, reason: "near_resolution" };
  }
  if (f.regime === "NEWS_SHOCK") {
    return { ok: false, reason: "news_shock" };
  }
  return { ok: true };
}

export type ExitReason = "near_high" | "target_profit" | "regime_change" | "near_resolution" | "max_hold";

export function shouldExit(
  config: StrategyConfig,
  f: BacktestFeatures,
  entryPrice: number,
  entryAt: Date
): { exit: boolean; reason?: ExitReason } {
  const holdMs = f.at.getTime() - entryAt.getTime();
  const holdHours = holdMs / (60 * 60 * 1000);

  if (holdHours >= config.maxHoldHours) {
    return { exit: true, reason: "max_hold" };
  }
  if (f.hoursToResolution != null && f.hoursToResolution < config.nearResolutionHours) {
    return { exit: true, reason: "near_resolution" };
  }
  if (f.regime !== "RANGE_MEAN_REVERTING") {
    return { exit: true, reason: "regime_change" };
  }
  const pnlPct = (f.price - entryPrice) / entryPrice;
  if (pnlPct >= config.targetProfitPct) {
    return { exit: true, reason: "target_profit" };
  }
  if (
    f.distanceFromRangeHigh != null &&
    f.distanceFromRangeHigh < config.exitNearHighThreshold
  ) {
    return { exit: true, reason: "near_high" };
  }
  return { exit: false };
}
