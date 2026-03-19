/**
 * Runtime-policy / freshness threshold calibration: reviewable recommendations only.
 * No auto-apply; descriptive and conservative.
 */

export type RuntimePolicySubtype =
  | "stale_market_data"
  | "stale_user_feed"
  | "stale_portfolio_truth"
  | "stale_reconciliation"
  | "stale_decision_snapshot"
  | "runtime_phase_block"
  | "runtime_safety_blocked"
  | "runtime_safety_kill_switch"
  | "exchange_truth_unavailable"
  | "replay_backlog"
  | "runtime_error"
  | "other_freshness_policy";

export type RuntimePolicyCalibrationRecommendation =
  | "keep_strict"
  | "review_loosen"
  | "review_tighten"
  | "insufficient_data"
  | "monitor";

export interface RuntimePolicySubtypeStats {
  subtype: RuntimePolicySubtype;
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

export interface RuntimePolicyCalibrationRecommendationRow {
  subtype: RuntimePolicySubtype;
  recommendation: RuntimePolicyCalibrationRecommendation;
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

export interface RuntimePolicyCalibrationReport {
  currentThresholds: Record<string, number | boolean>;
  perSubtype: Record<RuntimePolicySubtype, RuntimePolicySubtypeStats | undefined>;
  recommendations: RuntimePolicyCalibrationRecommendationRow[];
  totalCandidates: number;
  runtimePolicyRelevantCandidates: number;
  filters: { funderAddress?: string; minEvaluated?: number; subtype?: string; source?: string };
}
