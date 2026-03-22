/**
 * Types for shadow ML advisory scoring.
 * Scoring does not change execution; output is advisory only.
 */

import type { ShadowFeatureInput } from "@/lib/ml/shadow-train/features";

/** Context for scoring a current candidate (same shape as feature input; no outcome). */
export interface ShadowScoreInput extends Omit<ShadowFeatureInput, "outcomeBlockedVsAllowedVsSubmitted"> {
  /** Optional: for display only; not used in model (we don't know outcome at score time). */
  outcomeBlockedVsAllowedVsSubmitted?: "blocked" | "allowed" | "submitted" | null;
}

export interface ShadowScoreResult {
  /**
   * Raw logistic probability from the shadow model (sigmoid(z)); unchanged semantics for audit / DB PaperTrade.score.
   */
  shadowMlScore: number;
  /**
   * Pre-sigmoid linear term z (logit scale before clipping inside sigmoid). Null if unavailable.
   */
  shadowMlLogit: number | null;
  /**
   * Paper-only temperature-scaled probability: sigmoid(z / T). Equals shadowMlScore when T=1 or calibration off.
   */
  shadowMlScoreCalibrated: number;
  /** Band for operator display: "low" | "medium" | "high" (from raw shadowMlScore). */
  shadowMlScoreBand: "low" | "medium" | "high";
  /** Model run id used for this score. */
  modelId: string;
  /** Feature set name (e.g. shadow_v1). */
  modelFeatureSet: string;
  /** Target label this model was trained on. */
  modelTargetLabel: string;
  /** If true, this score is from shadow_candidate_ml (not recommendation_ml). */
  isShadowModel: true;
  /** Warnings when features are missing or incomplete (e.g. for operator review). */
  featureCompletenessWarnings: string[];
}
