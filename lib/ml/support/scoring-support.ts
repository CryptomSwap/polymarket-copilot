/**
 * Scoring-time support metrics: feature completeness, segment support.
 * Lightweight; no heavy NN or external data.
 */

import type { SupportMetrics } from "@/lib/ml/types/scoring";
import type { ScoringSupportInput } from "./types";
import { isLowSupportSegment } from "./segment-support";
import type { SegmentSupportSummary } from "./types";

/**
 * Build support metrics for a candidate at score time.
 * Uses optional segmentSupportMap from training metadata; if not provided, only completeness is computed.
 */
export function computeScoringSupportMetrics(
  input: ScoringSupportInput,
  segmentSupportMap?: Map<string, SegmentSupportSummary>,
  minSupport: number = 5
): SupportMetrics {
  const warnings: string[] = [];
  let missingFeatureFraction: number | undefined;
  if (
    input.totalFeatureCount != null &&
    input.totalFeatureCount > 0 &&
    input.missingFeatureCount != null &&
    input.missingFeatureCount > 0
  ) {
    missingFeatureFraction = input.missingFeatureCount / input.totalFeatureCount;
    if (missingFeatureFraction >= 0.2) warnings.push("missing_feature_fraction_high");
  }

  let lowSupport = false;
  let segmentKey: string | undefined;
  if (segmentSupportMap && input.segmentKeys) {
    const key = Object.entries(input.segmentKeys)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([k, v]) => `${k}=${v ?? "unknown"}`)
      .join("|");
    segmentKey = key;
    if (isLowSupportSegment(key, segmentSupportMap, minSupport)) {
      lowSupport = true;
      warnings.push("low_support_segment");
    }
  }

  return {
    segmentKey,
    trainingSupportCount: segmentKey ? segmentSupportMap?.get(segmentKey)?.trainingCount : undefined,
    lowSupport: lowSupport || undefined,
    missingFeatureFraction,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}
