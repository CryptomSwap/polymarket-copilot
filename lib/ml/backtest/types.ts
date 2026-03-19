/**
 * Types for offline shadow model backtest.
 * Simulates taking trades when score >= threshold; uses intendedPrice / markout12h for outcome.
 * Uses a starting bankroll and fixed fraction of bankroll per trade for realistic PnL and drawdown.
 */

export interface BacktestOptions {
  /** Slippage in decimal (e.g. 0.001 = 10 bps total entry+exit). */
  slippageDecimal?: number;
  /** Fixed cost per trade in decimal (e.g. 0.0005 = 5 bps). */
  fixedCostPerTrade?: number;
  /** Starting bankroll in dollars (e.g. 10000). */
  startingBankroll?: number;
  /** Fraction of current bankroll risked per trade (e.g. 0.02 = 2%). */
  sizeFractionPerTrade?: number;
}

export interface BacktestTrade {
  /** Row index / id for reference. */
  rowIndex: number;
  /** Model score (probability). */
  score: number;
  /** Gross return from markout12h (decimal). */
  grossReturn: number;
  /** Net return after slippage and fixed cost (decimal). */
  netReturn: number;
  /** intendedPrice at decision time. */
  intendedPrice: number;
  /** side (BUY | SELL). */
  side: string;
  /** Bankroll after this trade (dollars). */
  bankrollAfter: number;
  /** PnL in dollars for this trade. */
  pnlDollars: number;
}

export interface BacktestResult {
  /** Threshold used. */
  threshold: number;
  /** Number of simulated trades. */
  numTrades: number;
  /** Wins (net return > 0). */
  wins: number;
  /** Win rate in [0, 1]. */
  winRate: number;
  /** Average net return per trade (decimal). */
  avgReturnPerTrade: number;
  /** Starting bankroll (dollars). */
  startingBankroll: number;
  /** Ending bankroll (dollars). */
  endingBankroll: number;
  /** Total return as fraction of starting bankroll (decimal). */
  totalReturn: number;
  /** Max drawdown (decimal, 0..1): max peak-to-trough decline in bankroll. */
  maxDrawdown: number;
  /** Per-trade results in chronological order. */
  trades: BacktestTrade[];
}
