/**
 * Sizing stage: runs after eligibility, edge, market quality, portfolio fit.
 * Blocked recommendations size to zero; concentration affects sizing, not core edge.
 */

import type { EligibilityResult, MarketQualityResult, PortfolioFitResult, SizingResult, StagedDecisionInput } from "./types";

const CONCENTRATION_BLOCK_PCT = 50;
const THEME_WARN_PCT = 40;
const THEME_SIZE_REDUCE_PCT = 25;
const TOP_CONC_SIZE_REDUCE_PCT = 35;

export function evaluateSizing(
  input: StagedDecisionInput,
  eligibility: EligibilityResult,
  marketQuality: MarketQualityResult,
  portfolioFit: PortfolioFitResult,
  convictionScore: number
): SizingResult {
  const reasons: string[] = [];
  let sizeMultiplier = 1;
  let suggestedSize = input.suggestedSizeFromRec;

  if (!eligibility.eligible || portfolioFit.portfolioFitState === "block" || marketQuality.block) {
    return {
      suggestedSize: 0,
      sizeMultiplier: 0,
      sizingReasons: [...eligibility.blockers, ...(portfolioFit.portfolioFitState === "block" ? portfolioFit.reasons : []), ...(marketQuality.block ? marketQuality.marketQualityReasons : [])],
    };
  }

  if (input.action === "EXIT") {
    return {
      suggestedSize: Math.min(1, suggestedSize),
      sizeMultiplier: 1,
      sizingReasons: ["Exit: full size."],
    };
  }
  if (input.action === "TRIM") {
    sizeMultiplier = 0.8;
    suggestedSize = Math.min(0.5, suggestedSize * 0.8);
    return { suggestedSize, sizeMultiplier, sizingReasons: ["Trim: reduced size."] };
  }
  if (input.action === "NO_TRADE" || input.action === "WATCH") {
    return {
      suggestedSize: 0,
      sizeMultiplier: 0,
      sizingReasons: [input.action === "NO_TRADE" ? "No-trade recommendation." : "Watch only."],
    };
  }

  sizeMultiplier -= portfolioFit.portfolioFitPenalty;
  if (input.themeExposurePct > THEME_SIZE_REDUCE_PCT) {
    sizeMultiplier *= 0.7;
    reasons.push("Theme exposure reduces size.");
  }
  if (input.topThemeConcentrationPct > TOP_CONC_SIZE_REDUCE_PCT) {
    sizeMultiplier *= 0.6;
    reasons.push("Concentration reduces size.");
  }
  if (input.reviewStatus !== "APPROVED") {
    sizeMultiplier *= 0.8;
    reasons.push("Review pending; reduced size.");
  }
  if (input.mlScore != null && Math.abs(input.heuristicPriorityScore - input.mlScore) > 0.25 && input.mlScore < input.heuristicPriorityScore) {
    sizeMultiplier *= 0.7;
    reasons.push("ML disagrees with heuristic; reduced size.");
  }
  if (convictionScore >= 0.6) {
    sizeMultiplier = Math.min(1.1, sizeMultiplier + 0.1);
    reasons.push("High conviction; slight size boost.");
  }
  sizeMultiplier = Math.max(0.2, Math.min(1.2, sizeMultiplier));
  suggestedSize = input.suggestedSizeFromRec * sizeMultiplier;
  suggestedSize = Math.max(0, Math.min(1, suggestedSize));

  return {
    suggestedSize,
    sizeMultiplier,
    sizingReasons: reasons.length > 0 ? reasons : ["Default sizing."],
  };
}
