/**
 * Default staged decision boundaries.
 * Values aligned with lib/decision/stages/* and evaluate-staged.ts; do not change runtime behavior until callers use this config.
 */

import type { DecisionStageThresholds } from "./types";

export const defaultDecisionStageThresholds: DecisionStageThresholds = {
  eligibilityLowConvictionThreshold: 0.6,
  edgeHighConvictionThreshold: 0.65,
  edgeMediumConvictionThreshold: 0.45,
  edgeLowConvictionThreshold: 0.25,
  marketQualityWarnLiquidityThreshold: 0.25,
  marketQualityBlockLiquidityThreshold: 0.15,
  marketQualityCrowdingWarnThreshold: 0.15,
  marketQualityCrowdingBlockThreshold: 0.15,
  portfolioFitPenaltyWarnThreshold: 0.15,
  portfolioFitPenaltyBlockThreshold: 0.3,
  portfolioFitTopConcBlockPct: 50,
  sizingMinMultiplier: 0.2,
  sizingReviewMultiplier: 0.8,
  sizingStrongConvictionMultiplier: 0.1,
  concentrationBlockPct: 50,
};

let currentThresholds: DecisionStageThresholds = { ...defaultDecisionStageThresholds };

export function getDecisionStageThresholds(): DecisionStageThresholds {
  return { ...currentThresholds };
}

export function setDecisionStageThresholds(thresholds: Partial<DecisionStageThresholds>): void {
  currentThresholds = { ...currentThresholds, ...thresholds };
}
