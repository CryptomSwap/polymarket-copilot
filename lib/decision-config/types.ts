/**
 * Staged decision engine boundary types.
 * Centralized for calibration and audit; stage logic may still use local constants until wired.
 */

export interface DecisionStageThresholds {
  /** Eligibility: conviction below this treated as low (edge stage). */
  eligibilityLowConvictionThreshold: number;
  /** Edge: conviction >= this is high. */
  edgeHighConvictionThreshold: number;
  /** Edge: conviction >= this is medium. */
  edgeMediumConvictionThreshold: number;
  /** Edge: conviction below this (and > 0) is low. */
  edgeLowConvictionThreshold: number;
  /** Market quality: liquidity score below this → warn. */
  marketQualityWarnLiquidityThreshold: number;
  /** Market quality: liquidity score below this → block. */
  marketQualityBlockLiquidityThreshold: number;
  /** Market quality: news saturation >= this → block/warn. */
  marketQualityCrowdingWarnThreshold: number;
  /** Market quality: overcroded theme / saturation block. */
  marketQualityCrowdingBlockThreshold: number;
  /** Portfolio fit: penalty >= this → caution. */
  portfolioFitPenaltyWarnThreshold: number;
  /** Portfolio fit: penalty/state → block. */
  portfolioFitPenaltyBlockThreshold: number;
  /** Portfolio fit: top theme concentration >= this → block. */
  portfolioFitTopConcBlockPct: number;
  /** Sizing: minimum size multiplier (floor). */
  sizingMinMultiplier: number;
  /** Sizing: multiplier below this triggers "review" size. */
  sizingReviewMultiplier: number;
  /** Sizing: high conviction adds up to this. */
  sizingStrongConvictionMultiplier: number;
  /** Staged: concentration >= this (theme %) blocks in evaluate-staged. */
  concentrationBlockPct: number;
}
