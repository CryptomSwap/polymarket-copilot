/**
 * Staged decision model: shared types for eligibility, edge, market quality, portfolio fit, sizing, explanation.
 * No black-box blending; each stage has explicit inputs and outputs.
 */

export interface EligibilityResult {
  eligible: boolean;
  blockers: string[];
  warnings: string[];
}

export type EdgeState = "high" | "medium" | "low" | "negative";

export interface EdgeResult {
  edgeState: EdgeState;
  convictionScore: number;
  edgeReasons: string[];
}

export type MarketQualityState = "ok" | "degraded" | "poor";

export interface MarketQualityResult {
  marketQualityState: MarketQualityState;
  marketQualityReasons: string[];
  block: boolean;
  warnings: string[];
}

export type PortfolioFitState = "ok" | "caution" | "block";

export interface PortfolioFitResult {
  portfolioFitState: PortfolioFitState;
  portfolioFitPenalty: number;
  reasons: string[];
}

export interface SizingResult {
  suggestedSize: number;
  sizeMultiplier: number;
  sizingReasons: string[];
}

export interface StagedDecisionInput {
  action: string;
  blockedReason: string | null;
  qualityBlocker: string | null;
  heuristicPriorityScore: number;
  mlScore: number | null;
  newsCatalystBoost: number;
  newsSaturationPenalty: number;
  themeExposurePct: number;
  topThemeConcentrationPct: number;
  behaviorPenalty: number;
  portfolioPenalty: number;
  setupActedWinRate: number | null;
  setupOverrideWinRate: number | null;
  setupSampleCount: number;
  reviewStatus: string;
  signalType: string | null;
  suggestedSizeFromRec: number;
  hasExistingPosition: boolean;
  liquidityScore: number;
  /** e.g. OVERCROWDED_THEME, LATE_CHASE */
  signalTypeLabel?: string | null;
}

export interface StagedDecisionResult {
  eligibility: EligibilityResult;
  edge: EdgeResult;
  marketQuality: MarketQualityResult;
  portfolioFit: PortfolioFitResult;
  sizing: SizingResult;
  explanation: string[];
  /** Legacy-compatible 0-1 score for DecisionPolicySnapshot.blendedScore */
  blendedScore: number;
  policyState: string;
  blockReason: string | null;
  sizeMultiplier: number;
  finalSuggestedSize: number;
  /** For reasoningJson: same shape as before where possible */
  reasoningBreakdown: {
    blockers: string[];
    supportive: string[];
    edgeReasons: string[];
    marketQualityReasons: string[];
    portfolioFitReasons: string[];
    sizingReasons: string[];
  };
}
