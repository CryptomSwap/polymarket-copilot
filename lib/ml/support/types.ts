/**
 * Support and uncertainty types for ML scoring.
 * Used for low-support flags, segment counts, feature completeness.
 */

/** Coarse segment key for support lookup (e.g. category, price_band). */
export type SupportSegmentKey = string;

/** One segment's support summary. */
export interface SegmentSupportSummary {
  segmentKey: SupportSegmentKey;
  /** Training example count in this segment. */
  trainingCount: number;
  /** Optional positive count. */
  positiveCount?: number;
}

/** Input to compute support metrics at score time. */
export interface ScoringSupportInput {
  /** Coarse segment keys for this candidate (e.g. category, priceBand). */
  segmentKeys?: Record<string, string>;
  /** Number of features missing or defaulted (for completeness). */
  missingFeatureCount?: number;
  /** Total feature count. */
  totalFeatureCount?: number;
}
