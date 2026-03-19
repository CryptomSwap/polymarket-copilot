/**
 * Paper-only exploration policy types.
 * Additive; default remains legacy threshold-only. Do not affect live execution.
 */

/** Exploration policy mode. */
export type ExplorationPolicyMode = "legacy_threshold_only" | "blended_allocator_v1";

/** Allocation bucket for explainable selection. */
export type ExplorationAllocationBucket =
  | "exploit_high_score"
  | "explore_uncertain"
  | "explore_under_sampled_segment"
  | "explore_specific_block_reason";

export interface ExplorationAllocationConfig {
  mode: ExplorationPolicyMode;
  /** Quotas or weights per bucket (e.g. exploit 70%, explore_uncertain 20%, explore_under_sampled 10%). */
  quotas?: Partial<Record<ExplorationAllocationBucket, number>>;
  /** Max fraction of slots for exploration (0–1). */
  maxExplorationFraction?: number;
}

/** Provenance: why was this candidate selected for paper trade? */
export interface CandidateSelectionProvenance {
  bucket: ExplorationAllocationBucket;
  reason: string;
  score?: number;
  threshold?: number;
}
