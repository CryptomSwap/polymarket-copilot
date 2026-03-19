/**
 * Explanation assembly: ordered, human-readable reasoning from all stages.
 * Blockers first, then edge, market quality, portfolio fit, sizing.
 */

import type {
  EligibilityResult,
  EdgeResult,
  MarketQualityResult,
  PortfolioFitResult,
  SizingResult,
  StagedDecisionResult,
} from "./types";

export function assembleExplanation(
  eligibility: EligibilityResult,
  edge: EdgeResult,
  marketQuality: MarketQualityResult,
  portfolioFit: PortfolioFitResult,
  sizing: SizingResult
): string[] {
  const lines: string[] = [];
  if (eligibility.blockers.length > 0) {
    lines.push("Blockers: " + eligibility.blockers.join("; "));
  }
  if (eligibility.warnings.length > 0) {
    lines.push("Warnings: " + eligibility.warnings.join("; "));
  }
  if (edge.edgeReasons.length > 0) {
    lines.push("Edge: " + edge.edgeReasons.join(" "));
  }
  if (marketQuality.marketQualityReasons.length > 0) {
    lines.push("Market quality: " + marketQuality.marketQualityReasons.join("; "));
  }
  if (marketQuality.warnings.length > 0) {
    lines.push("Market: " + marketQuality.warnings.join("; "));
  }
  if (portfolioFit.reasons.length > 0) {
    lines.push("Portfolio fit: " + portfolioFit.reasons.join("; "));
  }
  if (sizing.sizingReasons.length > 0) {
    lines.push("Sizing: " + sizing.sizingReasons.join("; "));
  }
  return lines;
}

export function buildReasoningBreakdown(result: StagedDecisionResult): StagedDecisionResult["reasoningBreakdown"] {
  return {
    blockers: result.eligibility.blockers,
    supportive: result.edge.edgeReasons.filter((r) => r.includes("Strong") || r.includes("Catalyst") || r.includes("support")),
    edgeReasons: result.edge.edgeReasons,
    marketQualityReasons: result.marketQuality.marketQualityReasons,
    portfolioFitReasons: result.portfolioFit.reasons,
    sizingReasons: result.sizing.sizingReasons,
  };
}
