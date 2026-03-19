/**
 * Market quality stage: liquidity, crowding, news saturation, data quality.
 * Separate from edge; can block or warn.
 */

import type { MarketQualityResult, StagedDecisionInput } from "./types";

const LIQUIDITY_POOR = 0.15;
const LIQUIDITY_DEGRADED = 0.25;
const NEWS_SATURATION_BLOCK = 0.15;

export function evaluateMarketQuality(input: StagedDecisionInput): MarketQualityResult {
  const reasons: string[] = [];
  const warnings: string[] = [];
  let block = false;

  if (input.liquidityScore < LIQUIDITY_POOR) {
    reasons.push("Liquidity too low.");
    block = true;
  } else if (input.liquidityScore < LIQUIDITY_DEGRADED) {
    reasons.push("Moderate liquidity; execution risk.");
    warnings.push("Lower liquidity.");
  }
  if (input.signalTypeLabel === "OVERCROWDED_THEME" || input.signalType === "OVERCROWDED_THEME") {
    reasons.push("Market crowded or low liquidity.");
    block = true;
  }
  if (input.newsSaturationPenalty >= NEWS_SATURATION_BLOCK) {
    reasons.push("News saturation.");
    warnings.push("High news saturation.");
  }
  if (input.newsCatalystBoost > 0.03) {
    reasons.push("Catalyst support.");
  }

  let marketQualityState: MarketQualityResult["marketQualityState"] = "ok";
  if (block) marketQualityState = "poor";
  else if (reasons.length > 0 || warnings.length > 0) marketQualityState = "degraded";

  return {
    marketQualityState,
    marketQualityReasons: reasons,
    block,
    warnings,
  };
}
