/**
 * Backtest v1: mean-reversion strategy simulator. Deterministic, explainable.
 * No connection to live execution.
 */

export type {
  BacktestConfig,
  BacktestResult,
  BacktestMetrics,
  BacktestFeatures,
  SimulatedTrade,
  BlockedEntryReason,
  RegimeLabel,
} from "./types";
export { DEFAULT_BACKTEST_CONFIG } from "./types";
export { loadSnapshots, loadMarketMeta } from "./data";
export type { PriceSnapshotRow, MarketMeta } from "./data";
export { computeFeaturesAt } from "./features";
export { canEnter, shouldExit } from "./strategy";
export type { StrategyConfig, ExitReason } from "./strategy";
export { runBacktest } from "./run";
export { runBacktestFromDb } from "./run-db";
