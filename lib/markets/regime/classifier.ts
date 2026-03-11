/**
 * Deterministic regime classifier: threshold-based labels for market state.
 * Explainable, no ML. Used by bot and recommendations to distinguish range vs trend vs unsafe.
 */

import type { MarketRegimeFeatures } from "./features";

export type RegimeLabel =
  | "RANGE_MEAN_REVERTING"
  | "TRENDING_UP"
  | "TRENDING_DOWN"
  | "NEWS_SHOCK"
  | "ILLIQUID_NOISY"
  | "NEAR_RESOLUTION_UNSAFE";

export interface RegimeResult {
  regime: RegimeLabel;
  explanation: string;
}

// Thresholds (tunable, explainable)
const HOURS_NEAR_RESOLUTION = 72;
const LIQUIDITY_MIN = 0.15;
const NEWS_SHOCK_MIN_LINKS = 2;
const TREND_UP_MIN = 0.58;
const TREND_DOWN_MAX = 0.42;
const VOLATILITY_MIN_FOR_RANGE = 0.05;

/**
 * Classify market regime from features. Order of checks matters: most specific first.
 */
export function classifyRegime(features: MarketRegimeFeatures): RegimeResult {
  if (features.hoursToResolution != null && features.hoursToResolution < HOURS_NEAR_RESOLUTION) {
    return {
      regime: "NEAR_RESOLUTION_UNSAFE",
      explanation: `Market resolves in ${Math.round(features.hoursToResolution)}h; treat as unsafe for new mean-reversion.`,
    };
  }

  if (features.spreadLiquidityQuality < LIQUIDITY_MIN) {
    return {
      regime: "ILLIQUID_NOISY",
      explanation: `Liquidity quality ${(features.spreadLiquidityQuality * 100).toFixed(0)}% below threshold; price may be noisy.`,
    };
  }

  if (features.newsShockProxy >= NEWS_SHOCK_MIN_LINKS || features.newsActivityCount >= 5) {
    return {
      regime: "NEWS_SHOCK",
      explanation: `Event/news activity (events: ${features.newsShockProxy}, news: ${features.newsActivityCount}); repricing risk.`,
    };
  }

  if (features.trendScore >= TREND_UP_MIN) {
    return {
      regime: "TRENDING_UP",
      explanation: `Trend score ${(features.trendScore * 100).toFixed(0)}% indicates upward momentum; not range.`,
    };
  }

  if (features.trendScore <= TREND_DOWN_MAX) {
    return {
      regime: "TRENDING_DOWN",
      explanation: `Trend score ${(features.trendScore * 100).toFixed(0)}% indicates downward momentum; not range.`,
    };
  }

  if (
    features.volatilityScore >= VOLATILITY_MIN_FOR_RANGE &&
    features.rollingLow != null &&
    features.rollingHigh != null
  ) {
    return {
      regime: "RANGE_MEAN_REVERTING",
      explanation: `Volatility ${(features.volatilityScore * 100).toFixed(0)}%, range [${(features.rollingLow * 100).toFixed(1)}¢–${(features.rollingHigh * 100).toFixed(1)}¢]; suitable for mean-reversion.`,
    };
  }

  return {
    regime: "RANGE_MEAN_REVERTING",
    explanation: "Default: flat or insufficient data; classified as range.",
  };
}
