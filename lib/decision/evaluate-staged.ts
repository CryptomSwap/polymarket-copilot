/**
 * Staged decision evaluator: runs eligibility → edge → market quality → portfolio fit → sizing → explanation.
 * Returns legacy-compatible blendedScore, policyState, blockReason, sizeMultiplier, finalSuggestedSize, reasoningBreakdown.
 */

import type { StagedDecisionInput, StagedDecisionResult } from "./stages/types";
import { evaluateEligibility } from "./stages/eligibility";
import { evaluateEdge } from "./stages/edge";
import { evaluateMarketQuality } from "./stages/market-quality";
import { evaluatePortfolioFit } from "./stages/portfolio-fit";
import { evaluateSizing } from "./stages/sizing";
import { assembleExplanation } from "./stages/explanation";

const CONCENTRATION_BLOCK_PCT = 50;

export type { StagedDecisionInput, StagedDecisionResult };

/**
 * Run the full staged pipeline and return result with legacy-compatible fields.
 */
export function evaluateDecisionStaged(input: StagedDecisionInput): StagedDecisionResult {
  const eligibility = evaluateEligibility(input);
  const edge = evaluateEdge(input);
  const marketQuality = evaluateMarketQuality(input);
  const portfolioFit = evaluatePortfolioFit(input);
  const sizing = evaluateSizing(input, eligibility, marketQuality, portfolioFit, edge.convictionScore);

  let blockReason: string | null = null;
  if (eligibility.blockers.length > 0) {
    blockReason = eligibility.blockers[0];
    if (blockReason.toLowerCase().includes("review")) {
      blockReason = "Review required.";
    }
  }
  if (!blockReason && input.topThemeConcentrationPct >= CONCENTRATION_BLOCK_PCT && input.action !== "TRIM" && input.action !== "EXIT") {
    blockReason = `Theme concentration ${input.topThemeConcentrationPct.toFixed(0)}% exceeds limit.`;
  }
  if (!blockReason && portfolioFit.portfolioFitState === "block") {
    blockReason = portfolioFit.reasons[0] ?? "Portfolio fit block.";
  }
  if (!blockReason && marketQuality.block) {
    blockReason = marketQuality.marketQualityReasons[0] ?? "Market quality block.";
  }

  const blendedScore = Math.max(
    0,
    Math.min(1, edge.convictionScore - portfolioFit.portfolioFitPenalty)
  );

  let policyState: string;
  if (blockReason) {
    policyState = blockReason.toLowerCase().includes("review") ? "REVIEW_REQUIRED" : "BLOCK";
  } else if (input.action === "EXIT") {
    policyState = "EXIT";
  } else if (input.action === "TRIM") {
    policyState = "TRIM";
  } else if (input.action === "NO_TRADE" || input.action === "WATCH") {
    policyState = blendedScore >= 0.5 ? "REVIEW_REQUIRED" : "BLOCK";
  } else {
    if (blendedScore >= 0.7 && sizing.sizeMultiplier >= 0.9 && input.reviewStatus === "APPROVED") {
      policyState = "ALLOW_HIGH_CONVICTION";
    } else if (blendedScore >= 0.5 && sizing.suggestedSize > 0) {
      policyState = sizing.suggestedSize <= 0.3 ? "ALLOW_SMALL" : "ALLOW_NORMAL";
    } else if (blendedScore >= 0.4) {
      policyState = "REVIEW_REQUIRED";
    } else {
      policyState = "BLOCK";
    }
  }

  const explanation = assembleExplanation(eligibility, edge, marketQuality, portfolioFit, sizing);

  const result: StagedDecisionResult = {
    eligibility,
    edge,
    marketQuality,
    portfolioFit,
    sizing,
    explanation,
    blendedScore,
    policyState,
    blockReason,
    sizeMultiplier: sizing.sizeMultiplier,
    finalSuggestedSize: sizing.suggestedSize,
    reasoningBreakdown: {
      blockers: eligibility.blockers,
      supportive: edge.edgeReasons.filter((r) => r.includes("Strong") || r.includes("Catalyst") || r.includes("support")),
      edgeReasons: edge.edgeReasons,
      marketQualityReasons: marketQuality.marketQualityReasons,
      portfolioFitReasons: portfolioFit.reasons,
      sizingReasons: sizing.sizingReasons,
    },
  };
  return result;
}
