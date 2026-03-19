/**
 * Offline backtest: load shadow model + MlShadowTrainingExample, score, simulate trades at threshold.
 * Uses intendedPrice / markout12h for outcome; applies slippage and transaction cost.
 * No live trading or execution integration.
 */

import type { LogisticRegressionModel } from "@/lib/ml/baseline";
import { predictBatchLogistic } from "@/lib/ml/baseline";
import { toShadowFeatureVector } from "@/lib/ml/shadow-train/features";
import type { BacktestOptions, BacktestResult, BacktestTrade } from "./types";

/** MlShadowTrainingExample row shape used by backtest (subset we need). */
export interface BacktestRow {
  intendedPrice: string;
  intendedSize: string;
  side: string;
  markout12h: string | null;
  labelGoodDecision12h: boolean | null;
  policyState?: string | null;
  sizeMultiplier?: string | null;
  finalSuggestedSize?: string | null;
  eligibilityBlockersCount?: number;
  reducedSizeIndicator?: boolean;
  blockedIndicator?: boolean;
  executionAllow?: boolean | null;
  executionWarningCount?: number;
  qualityState?: string | null;
  spreadBps?: string | null;
  estimatedSlippage?: string | null;
  tradable?: boolean | null;
  grossExposure?: string | null;
  totalOpenExposure?: string | null;
  maxSingleMarketConcentrationPct?: string | null;
  maxSingleThemeConcentrationPct?: string | null;
  portfolioRiskFlagsCount?: number;
  runtimeWarningCount?: number;
  runtimeBlockingCount?: number;
  recommendationPresent?: boolean;
  outcomeBlockedVsAllowedVsSubmitted?: string | null;
  momentum1hBps?: string | null;
  momentum6hBps?: string | null;
  volatility1hBps?: string | null;
  volatility6hBps?: string | null;
  distanceFromMid?: string | null;
  timeToCloseHours?: string | null;
  liquidityTrend?: string | null;
}

function parseNum(s: string | null | undefined): number | null {
  if (s == null || s === "") return null;
  const n = parseFloat(String(s).trim());
  return Number.isFinite(n) ? n : null;
}

function rowToInput(r: BacktestRow) {
  const ex = r as {
    momentum1hBps?: string | null;
    momentum6hBps?: string | null;
    volatility1hBps?: string | null;
    volatility6hBps?: string | null;
    distanceFromMid?: string | null;
    timeToCloseHours?: string | null;
    liquidityTrend?: string | null;
  };
  return {
    policyState: r.policyState,
    sizeMultiplier: r.sizeMultiplier,
    finalSuggestedSize: r.finalSuggestedSize,
    eligibilityBlockersCount: r.eligibilityBlockersCount,
    reducedSizeIndicator: r.reducedSizeIndicator,
    blockedIndicator: r.blockedIndicator,
    executionAllow: r.executionAllow,
    executionWarningCount: r.executionWarningCount,
    qualityState: r.qualityState,
    spreadBps: r.spreadBps,
    estimatedSlippage: r.estimatedSlippage,
    tradable: r.tradable,
    grossExposure: r.grossExposure,
    totalOpenExposure: r.totalOpenExposure,
    maxSingleMarketConcentrationPct: r.maxSingleMarketConcentrationPct,
    maxSingleThemeConcentrationPct: r.maxSingleThemeConcentrationPct,
    portfolioRiskFlagsCount: r.portfolioRiskFlagsCount,
    runtimeWarningCount: r.runtimeWarningCount,
    runtimeBlockingCount: r.runtimeBlockingCount,
    intendedPrice: r.intendedPrice,
    intendedSize: r.intendedSize,
    recommendationPresent: r.recommendationPresent,
    side: r.side,
    outcomeBlockedVsAllowedVsSubmitted: (r.outcomeBlockedVsAllowedVsSubmitted as "blocked" | "allowed" | "submitted") ?? null,
    momentum1hBps: ex.momentum1hBps,
    momentum6hBps: ex.momentum6hBps,
    volatility1hBps: ex.volatility1hBps,
    volatility6hBps: ex.volatility6hBps,
    distanceFromMid: ex.distanceFromMid,
    timeToCloseHours: ex.timeToCloseHours,
    liquidityTrend: ex.liquidityTrend,
  };
}

/**
 * Run backtest: score each row, take trades where score >= threshold.
 * Uses starting bankroll and fixed fraction of bankroll per trade; PnL from markout12h with slippage/cost.
 * Equity curve = bankroll after each trade; drawdown = (peak - bankroll) / peak so it cannot exceed 100%.
 */
export function runBacktest(
  model: LogisticRegressionModel,
  rows: BacktestRow[],
  threshold: number,
  options: BacktestOptions = {}
): BacktestResult {
  const slippage = options.slippageDecimal ?? 0.001;
  const fixedCost = options.fixedCostPerTrade ?? 0;
  const startingBankroll = options.startingBankroll ?? 10_000;
  const sizeFraction = options.sizeFractionPerTrade ?? 0.02;

  const valid = rows.filter((r) => {
    const m = parseNum(r.markout12h);
    return m != null && Number.isFinite(m);
  });
  if (valid.length === 0) {
    return {
      threshold,
      numTrades: 0,
      wins: 0,
      winRate: 0,
      avgReturnPerTrade: 0,
      startingBankroll,
      endingBankroll: startingBankroll,
      totalReturn: 0,
      maxDrawdown: 0,
      trades: [],
    };
  }

  const X = valid.map((r) => toShadowFeatureVector(rowToInput(r)));
  const probas = predictBatchLogistic(model, X);

  const trades: BacktestTrade[] = [];
  let bankroll = startingBankroll;
  let peak = startingBankroll;
  let maxDrawdown = 0;

  for (let i = 0; i < valid.length; i++) {
    const score = probas[i] ?? 0;
    if (score < threshold) continue;

    const row = valid[i];
    const grossReturn = parseNum(row.markout12h) ?? 0;
    const netReturn = grossReturn - slippage - fixedCost;
    const intendedPrice = parseNum(row.intendedPrice) ?? 0;

    const amountRisked = bankroll * sizeFraction;
    const pnlDollars = amountRisked * netReturn;
    bankroll += pnlDollars;
    if (bankroll <= 0) bankroll = 0;

    if (bankroll > peak) peak = bankroll;
    const drawdownPct = peak > 0 ? (peak - bankroll) / peak : 0;
    if (drawdownPct > maxDrawdown) maxDrawdown = drawdownPct;

    trades.push({
      rowIndex: i,
      score,
      grossReturn,
      netReturn,
      intendedPrice,
      side: row.side ?? "BUY",
      bankrollAfter: bankroll,
      pnlDollars,
    });
  }

  const numTrades = trades.length;
  const wins = trades.filter((t) => t.netReturn > 0).length;
  const winRate = numTrades > 0 ? wins / numTrades : 0;
  const totalReturn =
    startingBankroll > 0 ? (bankroll - startingBankroll) / startingBankroll : 0;
  const avgReturnPerTrade =
    numTrades > 0
      ? trades.reduce((s, t) => s + t.netReturn, 0) / numTrades
      : 0;

  return {
    threshold,
    numTrades,
    wins,
    winRate,
    avgReturnPerTrade,
    startingBankroll,
    endingBankroll: bankroll,
    totalReturn,
    maxDrawdown,
    trades,
  };
}
