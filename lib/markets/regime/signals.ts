/**
 * Rule-based candidate signals from regime and features.
 * Explainable, threshold-based. Reusable by recommendation engine and bot dry-run.
 */

import type { MarketRegimeFeatures } from "./features";
import type { RegimeLabel } from "./classifier";

const NEAR_LOW_THRESHOLD = 0.35;
const NEAR_HIGH_THRESHOLD = 0.35;

export interface RegimeSignals {
  meanReversionBuyCandidate: boolean;
  meanReversionSellCandidate: boolean;
  breakoutRisk: boolean;
  explanation: string[];
}

/**
 * Compute candidate signals from features and regime.
 * meanReversionBuyCandidate: in range regime and price near rolling low.
 * meanReversionSellCandidate: in range regime and price near rolling high.
 * breakoutRisk: regime is trend or news shock (unsafe for mean reversion).
 */
export function getRegimeSignals(
  features: MarketRegimeFeatures,
  regime: RegimeLabel
): RegimeSignals {
  const explanation: string[] = [];

  const nearLow =
    features.distanceFromRangeLow != null && features.distanceFromRangeLow < NEAR_LOW_THRESHOLD;
  const nearHigh =
    features.distanceFromRangeHigh != null && features.distanceFromRangeHigh < NEAR_HIGH_THRESHOLD;

  const meanReversionBuyCandidate =
    regime === "RANGE_MEAN_REVERTING" && nearLow;
  const meanReversionSellCandidate =
    regime === "RANGE_MEAN_REVERTING" && nearHigh;
  const breakoutRisk =
    regime === "TRENDING_UP" ||
    regime === "TRENDING_DOWN" ||
    regime === "NEWS_SHOCK";

  if (meanReversionBuyCandidate) {
    explanation.push("Buy-low candidate: range regime, price near rolling low.");
  }
  if (meanReversionSellCandidate) {
    explanation.push("Sell-high candidate: range regime, price near rolling high.");
  }
  if (breakoutRisk) {
    explanation.push("Breakout/repricing risk: trend or news shock; avoid mean-reversion.");
  }
  if (!meanReversionBuyCandidate && !meanReversionSellCandidate && !breakoutRisk) {
    if (regime === "RANGE_MEAN_REVERTING") {
      explanation.push("Range regime but not near band; neutral for mean reversion.");
    } else if (regime === "ILLIQUID_NOISY" || regime === "NEAR_RESOLUTION_UNSAFE") {
      explanation.push("Unsafe or illiquid; no signal.");
    }
  }

  return {
    meanReversionBuyCandidate,
    meanReversionSellCandidate,
    breakoutRisk,
    explanation,
  };
}
