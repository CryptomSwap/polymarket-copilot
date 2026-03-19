/**
 * Portfolio-risk threshold calibration: reviewable recommendations only.
 * No auto-apply; descriptive and conservative.
 */

export type PortfolioRiskSubtype =
  | "total_exposure"
  | "single_market_concentration"
  | "single_theme_concentration"
  | "near_resolution_exposure"
  | "illiquid_exposure"
  | "correlated_exposure"
  | "portfolio_fit_penalty"
  | "behavior_conflict"
  | "other_portfolio_risk";

export type RiskCalibrationRecommendation =
  | "keep_strict"
  | "review_loosen"
  | "review_tighten"
  | "insufficient_data"
  | "monitor";

export interface RiskSubtypeStats {
  subtype: PortfolioRiskSubtype;
  blockedCount: number;
  evaluatedBlocked: number;
  goodBlockCount: number;
  badBlockCount: number;
  allowedCount: number;
  evaluatedAllowed: number;
  goodAllowCount: number;
  badAllowCount: number;
  averageMarkout24hBlocked: number | null;
  averageMarkout24hAllowed: number | null;
  rawSamples: string[];
}

export interface RiskCalibrationRecommendationRow {
  subtype: PortfolioRiskSubtype;
  recommendation: RiskCalibrationRecommendation;
  summary: string;
  blockedCount: number;
  evaluatedBlocked: number;
  goodBlockCount: number;
  badBlockCount: number;
  allowedCount: number;
  evaluatedAllowed: number;
  badAllowCount: number;
  minEvaluatedForRecommendation: number;
}

export interface PortfolioRiskCalibrationReport {
  currentThresholds: Record<string, number>;
  perSubtype: Record<PortfolioRiskSubtype, RiskSubtypeStats | undefined>;
  recommendations: RiskCalibrationRecommendationRow[];
  totalCandidates: number;
  riskRelevantCandidates: number;
  filters: { funderAddress?: string; minEvaluated?: number; subtype?: string; source?: string };
}
