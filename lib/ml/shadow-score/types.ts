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
  /** Probability from shadow-trained model (e.g. P(good decision)). */
  shadowMlScore: number;
  /** Band for operator display: "low" | "medium" | "high". */
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
