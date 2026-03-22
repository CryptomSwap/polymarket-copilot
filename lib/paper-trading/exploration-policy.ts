/**
 * Paper-only exploration allocator: combine high-score exploitation with uncertain/under-sampled exploration.
 * Default: legacy_threshold_only (current behavior). Enable blended_allocator_v1 via config only.
 */

import type {
  ExplorationPolicyMode,
  ExplorationAllocationBucket,
  ExplorationAllocationConfig,
  CandidateSelectionProvenance,
} from "./exploration-types";

export type { ExplorationPolicyMode, ExplorationAllocationBucket, ExplorationAllocationConfig, CandidateSelectionProvenance } from "./exploration-types";

const DEFAULT_MODE: ExplorationPolicyMode = "legacy_threshold_only";

/** True when blended paper exploration allocator is enabled via env (paper-only). */
export function isPaperExplorationAllocatorEnabledViaEnv(): boolean {
  const v1 =
    typeof process !== "undefined" ? process.env.ENABLE_PAPER_EXPLORATION_ALLOCATOR_V1?.trim().toLowerCase() : "";
  const paper =
    typeof process !== "undefined" ? process.env.PAPER_EXPLORATION_ENABLED?.trim().toLowerCase() : "";
  return v1 === "1" || v1 === "true" || paper === "1" || paper === "true";
}

/**
 * Resolve effective exploration mode (e.g. from env or config). Default preserves legacy.
 */
export function getExplorationPolicyMode(override?: ExplorationPolicyMode): ExplorationPolicyMode {
  if (override) return override;
  if (isPaperExplorationAllocatorEnabledViaEnv()) return "blended_allocator_v1";
  return DEFAULT_MODE;
}

/**
 * For a candidate, suggest allocation bucket and provenance when mode is blended_allocator_v1.
 * When mode is legacy_threshold_only, returns null (caller uses score >= threshold only).
 */
export function suggestExplorationBucket(
  config: { mode: ExplorationPolicyMode; quotas?: Partial<Record<ExplorationAllocationBucket, number>> },
  candidate: {
    score: number;
    threshold: number;
    uncertaintyFlags?: string[];
    segmentSupportCount?: number;
    blockReason?: string;
  }
): CandidateSelectionProvenance | null {
  if (config.mode !== "blended_allocator_v1") return null;

  const { score, threshold, uncertaintyFlags = [], segmentSupportCount = 0, blockReason } = candidate;
  const minSupport = 10;

  if (score >= threshold && (uncertaintyFlags.length === 0 || (segmentSupportCount >= minSupport))) {
    return {
      bucket: "exploit_high_score",
      reason: "Above threshold, sufficient support",
      score,
      threshold,
    };
  }
  if (score >= threshold * 0.8 && uncertaintyFlags.includes("low_support_segment")) {
    return {
      bucket: "explore_uncertain",
      reason: "Near threshold, low support segment",
      score,
      threshold,
    };
  }
  if (segmentSupportCount > 0 && segmentSupportCount < minSupport && score >= threshold * 0.7) {
    return {
      bucket: "explore_under_sampled_segment",
      reason: "Under-sampled segment, score above 70% threshold",
      score,
      threshold,
    };
  }
  if (blockReason && score >= threshold * 0.6) {
    return {
      bucket: "explore_specific_block_reason",
      reason: `Block reason cohort: ${blockReason}`,
      score,
      threshold,
    };
  }
  return null;
}
