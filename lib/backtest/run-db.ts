/**
 * Run backtest from DB: load snapshots and market meta, then runBacktest.
 */

import { loadSnapshots, loadMarketMeta } from "./data";
import { runBacktest } from "./run";
import type { BacktestConfig, BacktestResult } from "./types";

/**
 * Load price snapshots and market metadata for the config date range and optional marketIds,
 * then run the mean-reversion backtest. Returns result with trades and metrics.
 */
export async function runBacktestFromDb(config: BacktestConfig): Promise<BacktestResult> {
  const startDate = new Date(config.startDate);
  const endDate = new Date(config.endDate);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    throw new Error("Invalid startDate or endDate");
  }
  if (startDate >= endDate) {
    throw new Error("startDate must be before endDate");
  }

  const snapshots = await loadSnapshots({
    startDate,
    endDate,
    marketIds: config.marketIds,
  });

  const marketIds = [...new Set(snapshots.map((s) => s.marketId))];
  const marketMeta = await loadMarketMeta(marketIds);

  return runBacktest(snapshots, marketMeta, config);
}
