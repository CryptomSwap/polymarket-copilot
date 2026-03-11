/**
 * Backtest v1 types: config, trades, metrics. Deterministic, explainable.
 * No connection to live execution.
 */

export interface BacktestConfig {
  /** Start of replay window (ISO or Date). */
  startDate: string;
  /** End of replay window. */
  endDate: string;
  /** Optional: only these market IDs; else all with enough data. */
  marketIds?: string[];
  /** Target profit to exit (e.g. 0.10 = 10%). */
  targetProfitPct?: number;
  /** Max hold hours before forced exit. */
  maxHoldHours?: number;
  /** Min liquidity quality 0–1 (reuse policy). */
  minLiquidity?: number;
  /** Hours to resolution below which we block entry / force exit. */
  nearResolutionHours?: number;
  /** Rolling window for features (hours). */
  rollingWindowHours?: number;
  /** Near lower band: distanceFromRangeLow < this to enter. */
  entryNearLowThreshold?: number;
  /** Near upper band: distanceFromRangeHigh < this to exit. */
  exitNearHighThreshold?: number;
}

export const DEFAULT_BACKTEST_CONFIG: Required<
  Pick<
    BacktestConfig,
    | "targetProfitPct"
    | "maxHoldHours"
    | "minLiquidity"
    | "nearResolutionHours"
    | "rollingWindowHours"
    | "entryNearLowThreshold"
    | "exitNearHighThreshold"
  >
> = {
  targetProfitPct: 0.10,
  maxHoldHours: 168,
  minLiquidity: 0.15,
  nearResolutionHours: 72,
  rollingWindowHours: 24,
  entryNearLowThreshold: 0.35,
  exitNearHighThreshold: 0.35,
};

export type RegimeLabel =
  | "RANGE_MEAN_REVERTING"
  | "TRENDING_UP"
  | "TRENDING_DOWN"
  | "NEWS_SHOCK"
  | "ILLIQUID_NOISY"
  | "NEAR_RESOLUTION_UNSAFE";

export interface BacktestFeatures {
  price: number;
  rollingLow: number | null;
  rollingHigh: number | null;
  volatilityScore: number;
  trendScore: number;
  distanceFromRangeLow: number | null;
  distanceFromRangeHigh: number | null;
  spreadLiquidityQuality: number;
  hoursToResolution: number | null;
  regime: RegimeLabel;
  at: Date;
}

export interface SimulatedTrade {
  marketId: string;
  assetId: string;
  entryAt: Date;
  exitAt: Date;
  entryPrice: number;
  exitPrice: number;
  pnlPct: number;
  exitReason: "near_high" | "target_profit" | "regime_change" | "near_resolution" | "max_hold";
}

export interface BlockedEntryReason {
  reason: string;
  count: number;
}

export interface BacktestMetrics {
  totalTrades: number;
  winCount: number;
  lossCount: number;
  winRate: number | null;
  averageWinPct: number | null;
  averageLossPct: number | null;
  expectancyPct: number | null;
  drawdownProxyPct: number | null;
  averageHoldHours: number | null;
  blockedByReason: BlockedEntryReason[];
}

export interface BacktestResult {
  config: BacktestConfig & {
    targetProfitPct: number;
    maxHoldHours: number;
    minLiquidity: number;
    nearResolutionHours: number;
    rollingWindowHours: number;
    entryNearLowThreshold: number;
    exitNearHighThreshold: number;
  };
  trades: SimulatedTrade[];
  metrics: BacktestMetrics;
  runAt: string;
}
