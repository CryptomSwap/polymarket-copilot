/**
 * ML score bundle: multi-role outputs (ranking, probability, uncertainty).
 * Additive; legacy shadow result remains valid via rankingScore / probabilityScore.
 */

import type { MlScoreRole } from "./roles";
import type { MlTargetKey } from "./targets";

/** Support metrics for uncertainty/support role. */
export interface SupportMetrics {
  /** Coarse segment key (e.g. category, price_band). */
  segmentKey?: string;
  /** Training support count in this segment (if available). */
  trainingSupportCount?: number;
  /** Whether candidate is in a low-support region. */
  lowSupport?: boolean;
  /** Missing feature fraction 0–1. */
  missingFeatureFraction?: number;
  /** Human-readable warnings. */
  warnings?: string[];
}

/**
 * Bundle of ML scores and metadata for a single candidate.
 * Preserves legacy: rankingScore and probabilityScore can mirror the same value.
 */
export interface MlScoreBundle {
  /** Ranking role: relative score for ordering (e.g. same as raw model output). */
  rankingScore?: number;
  /** Probability role: raw model probability (e.g. P(good decision)). */
  probabilityScore?: number;
  /** Calibrated probability if calibration is applied (null if not). */
  calibratedProbability?: number | null;
  /** Uncertainty/support flags (e.g. low_support, missing_features). */
  uncertaintyFlags?: string[];
  /** Support metrics for diagnostics. */
  supportMetrics?: SupportMetrics;
  /** Model run / variant id. */
  modelVariantId?: string;
  /** Target label this score is for. */
  targetLabel?: string;
  /** Feature set name. */
  featureSet?: string;
  /** Which roles this bundle provides. */
  roles?: MlScoreRole[];
}

/**
 * Build a legacy-compatible bundle from a single shadow score (e.g. from scoreShadowCandidate).
 * Use this to add MlScoreBundle alongside existing ShadowScoreResult without changing behavior.
 */
export function fromLegacyShadowScore(
  shadowMlScore: number,
  modelId: string,
  modelTargetLabel: string,
  modelFeatureSet: string,
  featureWarnings: string[] = []
): MlScoreBundle {
  const uncertaintyFlags = featureWarnings.length > 0 ? featureWarnings : undefined;
  return {
    rankingScore: shadowMlScore,
    probabilityScore: shadowMlScore,
    calibratedProbability: null,
    uncertaintyFlags,
    supportMetrics: uncertaintyFlags?.length
      ? { warnings: featureWarnings, missingFeatureFraction: featureWarnings.length > 0 ? 0.5 : undefined }
      : undefined,
    modelVariantId: modelId,
    targetLabel: modelTargetLabel,
    featureSet: modelFeatureSet,
    roles: ["ranking", "probability", "uncertainty_support"],
  };
}
