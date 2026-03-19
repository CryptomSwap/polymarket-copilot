/**
 * Offline shadow model backtest: score historical examples, simulate trades, report PnL.
 * No live trading or execution integration.
 */

export { runBacktest } from "./run";
export type { BacktestRow } from "./run";
export type { BacktestOptions, BacktestResult, BacktestTrade } from "./types";
