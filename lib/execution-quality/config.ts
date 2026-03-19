/**
 * Execution-quality threshold configuration.
 * Centralized for calibration and audit; defaults match previous hardcoded values.
 * Do not auto-mutate; changes are applied only via explicit config updates.
 */

export interface ExecutionQualityThresholds {
  /** Quote older than this (ms) → block. */
  staleQuoteBlockMs: number;
  /** Quote older than this (ms) → warn. */
  staleQuoteWarnMs: number;
  /** Spread >= this (bps) → block. */
  spreadBlockBps: number;
  /** Spread >= this (bps) → warn. */
  spreadWarnBps: number;
  /** Same-side depth / intendedSize below this → block. */
  minDepthBlockRatio: number;
  /** Same-side depth / intendedSize below this → warn. */
  minDepthWarnRatio: number;
  /** Intended price more than this fraction from best → block (e.g. 0.05 = 5%). */
  maxPriceDeviationPct: number;
  /** Estimated slippage >= this (bps) → block. */
  slippageBlockBps: number;
  /** Estimated slippage >= this (bps) → warn. */
  slippageWarnBps: number;
  /** Liquidity score below this → block. */
  minLiquidityScoreBlock: number;
  /** Liquidity score below this → warn. */
  minLiquidityScoreWarn: number;
}

export const defaultExecutionQualityThresholds: ExecutionQualityThresholds = {
  staleQuoteBlockMs: 60_000,
  staleQuoteWarnMs: 30_000,
  spreadBlockBps: 1500,
  spreadWarnBps: 400,
  minDepthBlockRatio: 0.3,
  minDepthWarnRatio: 0.6,
  maxPriceDeviationPct: 0.05,
  slippageBlockBps: 500,
  slippageWarnBps: 200,
  minLiquidityScoreBlock: 0.15,
  minLiquidityScoreWarn: 0.25,
};

/** Current thresholds in use (defaults; can be overridden by caller in future). */
let currentThresholds: ExecutionQualityThresholds = defaultExecutionQualityThresholds;

export function getExecutionQualityThresholds(): ExecutionQualityThresholds {
  return currentThresholds;
}

/**
 * Set thresholds (e.g. from env or calibration review). Call only when operator has approved changes.
 * Does not persist; process restart reverts to default unless set again.
 */
export function setExecutionQualityThresholds(thresholds: Partial<ExecutionQualityThresholds>): void {
  currentThresholds = { ...currentThresholds, ...thresholds };
}
