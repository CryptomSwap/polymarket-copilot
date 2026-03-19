# Decision-Stage Boundary Calibration

## Purpose

The decision-stage calibration workflow uses **shadow candidate outcomes** and **staged decision snapshots** to produce **reviewable recommendations** for adjusting the staged decision engine’s boundaries (eligibility, edge, market-quality, portfolio-fit, sizing). It does **not** auto-apply changes. Operators use the analysis to decide whether to loosen, tighten, or keep current stage boundaries based on evidence.

**Why stage tuning comes after control-layer calibration:** Execution-quality, portfolio-risk, and freshness/runtime-policy thresholds are safety and control layers. The staged decision engine is more fragile and more prone to overfitting; calibrating it after those layers are in place keeps a clear order: safety first, then decision boundaries.

## Current Staged Decision Boundaries

Boundaries are defined in `lib/decision-config` and exposed via `getDecisionStageThresholds()`. They mirror the constants in `lib/decision/stages/*` and `evaluate-staged.ts`:

| Config key | Default | Meaning |
|------------|--------|--------|
| `eligibilityLowConvictionThreshold` | 0.6 | Chase + conviction below this → eligibility block. |
| `edgeHighConvictionThreshold` | 0.65 | Conviction >= this → high edge. |
| `edgeMediumConvictionThreshold` | 0.45 | Conviction >= this → medium edge. |
| `edgeLowConvictionThreshold` | 0.25 | Conviction below this (and > 0) → low edge. |
| `marketQualityWarnLiquidityThreshold` | 0.25 | Liquidity below → warn. |
| `marketQualityBlockLiquidityThreshold` | 0.15 | Liquidity below → block. |
| `marketQualityCrowdingWarnThreshold` | 0.15 | News saturation / crowding warn. |
| `marketQualityCrowdingBlockThreshold` | 0.15 | Overcrowded theme → block. |
| `portfolioFitPenaltyWarnThreshold` | 0.15 | Penalty above → caution. |
| `portfolioFitPenaltyBlockThreshold` | 0.3 | Penalty/state → block. |
| `portfolioFitTopConcBlockPct` | 50 | Top theme concentration >= this → block. |
| `sizingMinMultiplier` | 0.2 | Floor for size multiplier. |
| `sizingReviewMultiplier` | 0.8 | Review-pending size reduction. |
| `sizingStrongConvictionMultiplier` | 0.1 | High-conviction size boost cap. |
| `concentrationBlockPct` | 50 | Theme concentration >= this → block in evaluate-staged. |

Runtime behavior is unchanged until stage code is wired to use `getDecisionStageThresholds()`.

## Evidence Used for Calibration

- **Shadow candidates** where blocking reasons or snapshots indicate decision-stage influence:
  - **Blocked** by recommendation/decision (e.g. `recommendation:*`, theme concentration exceeds limit, or execution-policy recommendation block).
  - **Allowed or reduced-size** with `decisionSnapshotJson` (reasoningBreakdown, policyState, sizeMultiplier).
- **Decision snapshots** (`decisionSnapshotJson`): when present, parsed for blockers, edgeReasons, marketQualityReasons, portfolioFitReasons, sizingReasons, policyState, sizeMultiplier, blendedScore, finalSuggestedSize.
- **Post-trade evaluation** (markouts, outcome classification): good_block / bad_block / good_allow / bad_allow; for reduced-size cohort, good/bad reduced outcomes.

Calibration groups by **decision-stage subtype** and aggregates blocked, reduced, and allowed counts and outcomes.

## Subtype Meanings

| Subtype | Meaning | Source |
|--------|--------|--------|
| `eligibility_block` | Blocked by eligibility (blockers, review required, sync, chase). | blockers, blockReason, recommendation:* |
| `low_conviction_edge` | Low conviction score (0 < score < 0.25). | blendedScore |
| `medium_conviction_edge` | Medium conviction (0.45–0.65). | blendedScore |
| `high_conviction_edge` | High conviction (>= 0.65). | blendedScore |
| `poor_market_quality` | Market quality block (liquidity too low, crowded). | marketQualityReasons |
| `borderline_market_quality` | Market quality warn (moderate liquidity, saturation). | marketQualityReasons |
| `poor_portfolio_fit` | Portfolio fit block (high concentration, behavior, overconcentrated). | portfolioFitReasons, blockReason |
| `portfolio_fit_penalty` | Portfolio fit caution/penalty. | portfolioFitReasons |
| `size_reduced` | Size multiplier < 1 and > 0. | sizeMultiplier |
| `size_zero` | Size zero (block or no-trade/watch). | sizeMultiplier, sizingReasons |
| `exit_trim_logic` | Exit or trim action. | sizingReasons, policyState |
| `other_decision_stage` | Other decision-related. | fallback |

## How Recommendations Are Derived

Recommendations are **descriptive only**; they suggest review, not automatic changes.

| Recommendation | Meaning | Typical trigger |
|----------------|--------|------------------|
| **review_loosen** | Consider loosening the boundary for this subtype. | High bad_block rate (e.g. ≥50%) among evaluated blocked with sufficient sample (e.g. ≥5). |
| **keep_strict** | Block appears beneficial; keep boundary as is. | High good_block rate (e.g. ≥60%) among evaluated blocked. |
| **review_tighten** | Consider tightening so more cases block or size is reduced. | High bad_allow rate in allowed cohort, or high bad-outcome rate in reduced-size cohort (e.g. ≥50%). |
| **insufficient_data** | Not enough evaluated candidates to suggest a change. | Evaluated blocked, reduced, and allowed all below minimum (e.g. 5). |
| **monitor** | No strong signal; keep monitoring. | Mixed or neutral outcome rates. |

**Reduced-size cohort:** If candidates that had `sizeMultiplier < 1` and were allowed (not blocked) frequently become bad outcomes, the summary suggests review_tighten. If they often look like missed opportunities, consider review_loosen (manual interpretation).

## Why Changes Are Not Auto-Applied

- **Fragility:** Decision-stage boundaries affect which trades are considered and at what size; automatic tuning can overfit or degrade edge.
- **Order of operations:** Control-layer calibration (execution quality, portfolio risk, freshness) should be reviewed first; stage tuning is next.
- **Auditability:** All changes should be explicit and traceable (config change, deploy).
- **Overfitting:** Small or biased samples can drive bad boundary changes; human review is required.

Threshold updates are done by editing `lib/decision-config/defaults.ts` and deploying, or by calling `setDecisionStageThresholds()` only when an operator has approved (in-memory; process restart reverts to defaults unless persisted elsewhere).

## Anti-Overfitting Guidance

- Prefer **larger samples** before acting on review_loosen or review_tighten.
- **Tune control layers first:** Execution-quality, portfolio-risk, and runtime-policy calibration should be reviewed before relaxing or tightening decision-stage boundaries.
- Use **multiple horizons** (1h / 6h / 24h) in shadow evaluation; calibration uses 24h markout for classification.
- Avoid tuning on a **single market or short time window**; use filters to inspect segments but base decisions on broader evidence.
- **Do not collapse staged logic** back into a single blended score; keep eligibility → edge → market quality → portfolio fit → sizing structure.
- Re-run calibration after any boundary change to see how the next batch of shadow outcomes behaves.

## API

- **GET /api/ops/decision-calibration**  
  Returns: `currentThresholds`, `perSubtype`, `recommendations`, `totalCandidates`, `decisionRelevantCandidates`, `filters`.  
  Optional query: `funderAddress`, `minEvaluated`, `subtype`, `source`.

## Related Docs

- [Shadow Mode Telemetry](./SHADOW_MODE_TELEMETRY.md) — what is recorded and where.
- [Post-Trade Evaluation](./POST_TRADE_EVALUATION.md) — markouts and outcome classification.
- [Execution Quality Calibration](./EXECUTION_QUALITY_CALIBRATION.md) — control-layer calibration.
- [Portfolio Risk Calibration](./PORTFOLIO_RISK_CALIBRATION.md) — control-layer calibration.
- [Runtime Policy Calibration](./RUNTIME_POLICY_CALIBRATION.md) — control-layer calibration.
