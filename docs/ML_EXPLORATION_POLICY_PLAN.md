# ML Exploration Policy (Paper-Only)

Paper-only exploration allocator to combine high-score exploitation with uncertain and under-sampled exploration.

## Modes

- **legacy_threshold_only** (default): Current behavior — open paper trade when score >= threshold (and risk/dedupe pass).
- **blended_allocator_v1**: Configurable mix of exploit_high_score, explore_uncertain, explore_under_sampled_segment, explore_specific_block_reason.

## Gating

Set `ENABLE_PAPER_EXPLORATION_ALLOCATOR_V1=1` to enable blended mode. Default is off; no change to live execution.

## Modules

- `lib/paper-trading/exploration-types.ts` — `ExplorationPolicyMode`, `ExplorationAllocationBucket`, `CandidateSelectionProvenance`.
- `lib/paper-trading/exploration-policy.ts` — `getExplorationPolicyMode`, `suggestExplorationBucket`.

## Allocation buckets

- **exploit_high_score** — Above threshold, sufficient support.
- **explore_uncertain** — Near threshold, low support or uncertainty flags.
- **explore_under_sampled_segment** — Segment with few training examples; score above 70% threshold.
- **explore_specific_block_reason** — Block-reason cohort we want to learn about.

Quotas/weights can be configured when blended mode is enabled.
