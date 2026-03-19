/**
 * Execution-quality threshold calibration: reviewable recommendations only.
 * No auto-apply; descriptive and conservative.
 */

export type ExecutionQualitySubtype =
  | "stale_quote"
  | "spread_too_wide"
  | "insufficient_depth"
  | "slippage_too_high"
  | "not_tradable"
  | "low_liquidity_score"
  | "price_too_far_from_market"
  | "other";

export type EqCalibrationRecommendation =
  | "keep_strict"
  | "review_loosen"
  | "review_tighten"
  | "insufficient_data"
  | "monitor";

export interface EqSubtypeStats {
  subtype: ExecutionQualitySubtype;
  /** Blocked candidates that had this subtype as a reason (hard block). */
  blockedCount: number;
  evaluatedBlocked: number;
  goodBlockCount: number;
  badBlockCount: number;
  /** Allowed candidates that had this subtype only as warning (inferred from snapshot). */
  allowedWithWarningCount: number;
  evaluatedAllowedWithWarning: number;
  goodAllowCount: number;
  badAllowCount: number;
  averageMarkout24hBlocked: number | null;
  averageMarkout24hAllowedWithWarning: number | null;
  rawSamples: string[];
}

export interface EqCalibrationRecommendationRow {
  subtype: ExecutionQualitySubtype;
  recommendation: EqCalibrationRecommendation;
  summary: string;
  blockedCount: number;
  evaluatedBlocked: number;
  goodBlockCount: number;
  badBlockCount: number;
  allowedWithWarningCount: number;
  evaluatedAllowedWithWarning: number;
  badAllowCount: number;
  minEvaluatedForRecommendation: number;
}

export interface ExecutionQualityCalibrationReport {
  /** Current thresholds (from config). */
  currentThresholds: Record<string, number>;
  /** Per execution-quality subtype. */
  perSubtype: Record<ExecutionQualitySubtype, EqSubtypeStats | undefined>;
  /** Recommended reviews (do not auto-apply). */
  recommendations: EqCalibrationRecommendationRow[];
  /** Total shadow candidates considered. */
  totalCandidates: number;
  /** Candidates that had any execution_quality involvement (block or warning). */
  eqRelevantCandidates: number;
  /** Filters applied. */
  filters: { funderAddress?: string; minEvaluated?: number; subtype?: string; source?: string };
}
