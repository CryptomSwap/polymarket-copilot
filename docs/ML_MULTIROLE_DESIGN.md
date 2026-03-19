# ML Multi-Role Design

Additive design to separate ML into distinct roles without rewriting the existing system.

## Roles

1. **Ranking** — Relative prioritization among candidates.
2. **Probability** — Interpretable P(good outcome) for a label horizon.
3. **Uncertainty / support** — Confidence/support flags, low-density warnings, feature completeness.

## Types and modules

- `lib/ml/types/roles.ts` — `MlScoreRole`, descriptions.
- `lib/ml/types/targets.ts` — `MlTargetKey`, `getTargetHorizonHours`.
- `lib/ml/types/scoring.ts` — `MlScoreBundle`, `SupportMetrics`, `fromLegacyShadowScore`.
- `lib/ml/support/` — Segment support map, scoring-time support metrics, low-support flags.
- `lib/ml/calibration/` — Re-export of calibration helpers.
- `lib/ml/eval/` — Re-export of evaluation helpers.

## Backwards compatibility

Current `ShadowScoreResult` (shadowMlScore, shadowMlScoreBand, etc.) is unchanged. `fromLegacyShadowScore()` builds an `MlScoreBundle` from the same values so new code can consume a bundle while legacy code still uses the raw score.

## Gating

- `ENABLE_ML_MULTIROLE_OUTPUTS` — Emit `MlScoreBundle` alongside legacy result (default: false).
- `ENABLE_ML_SUPPORT_FLAGS` — Attach support/uncertainty flags to bundle (default: false).
