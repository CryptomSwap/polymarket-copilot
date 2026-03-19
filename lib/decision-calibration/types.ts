/**
 * Decision-stage boundary calibration: reviewable recommendations only.
 * No auto-apply; descriptive and conservative.
 */

export type DecisionStageSubtype =
  | "eligibility_block"
  | "low_conviction_edge"
  | "medium_conviction_edge"
  | "high_conviction_edge"
  | "poor_market_quality"
  | "borderline_market_quality"
  | "poor_portfolio_fit"
  | "portfolio_fit_penalty"
  | "size_reduced"
  | "size_zero"
  | "exit_trim_logic"
  | "other_decision_stage";

export type DecisionCalibrationRecommendation =
  | "keep_strict"
  | "review_loosen"
  | "review_tighten"
  | "insufficient_data"
  | "monitor";

export interface DecisionStageSubtypeStats {
  subtype: DecisionStageSubtype;
  blockedCount: number;
  reducedCount: number;
  allowedCount: number;
  evaluatedBlocked: number;
  evaluatedReduced: number;
  evaluatedAllowed: number;
  goodBlockCount: number;
  badBlockCount: number;
  goodAllowCount: number;
  badAllowCount: number;
  goodReducedCount: number;
  badReducedCount: number;
  averageMarkout24hBlocked: number | null;
  averageMarkout24hAllowed: number | null;
  averageMarkout24hReduced: number | null;
  rawSamples: string[];
}

export interface DecisionCalibrationRecommendationRow {
  subtype: DecisionStageSubtype;
  recommendation: DecisionCalibrationRecommendation;
  summary: string;
  blockedCount: number;
  evaluatedBlocked: number;
  goodBlockCount: number;
  badBlockCount: number;
  reducedCount: number;
  evaluatedReduced: number;
  badReducedCount: number;
  allowedCount: number;
  evaluatedAllowed: number;
  badAllowCount: number;
  minEvaluatedForRecommendation: number;
}

export interface DecisionStageCalibrationReport {
  currentThresholds: Record<string, number>;
  perSubtype: Record<DecisionStageSubtype, DecisionStageSubtypeStats | undefined>;
  recommendations: DecisionCalibrationRecommendationRow[];
  totalCandidates: number;
  decisionRelevantCandidates: number;
  filters: { funderAddress?: string; minEvaluated?: number; subtype?: string; source?: string };
}
