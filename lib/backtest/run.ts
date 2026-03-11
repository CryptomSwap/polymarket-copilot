/**
 * Backtest run: replay snapshots, apply mean-reversion strategy, collect trades and metrics.
 * Deterministic, no live execution.
 */

import type { PriceSnapshotRow } from "./data";
import type { MarketMeta } from "./data";
import { computeFeaturesAt } from "./features";
import { canEnter, shouldExit, type ExitReason, type StrategyConfig } from "./strategy";
import type {
  BacktestConfig,
  BacktestResult,
  BacktestMetrics,
  SimulatedTrade,
  BlockedEntryReason,
} from "./types";
import { DEFAULT_BACKTEST_CONFIG } from "./types";

function mergeConfig(c: BacktestConfig): StrategyConfig & {
  rollingWindowHours: number;
  entryNearLowThreshold: number;
  exitNearHighThreshold: number;
} {
  const d = DEFAULT_BACKTEST_CONFIG;
  return {
    targetProfitPct: c.targetProfitPct ?? d.targetProfitPct,
    maxHoldHours: c.maxHoldHours ?? d.maxHoldHours,
    minLiquidity: c.minLiquidity ?? d.minLiquidity,
    nearResolutionHours: c.nearResolutionHours ?? d.nearResolutionHours,
    rollingWindowHours: c.rollingWindowHours ?? d.rollingWindowHours,
    entryNearLowThreshold: c.entryNearLowThreshold ?? d.entryNearLowThreshold,
    exitNearHighThreshold: c.exitNearHighThreshold ?? d.exitNearHighThreshold,
  };
}

function aggregateMetrics(
  trades: SimulatedTrade[],
  blockedByReason: Map<string, number>
): BacktestMetrics {
  const totalTrades = trades.length;
  const wins = trades.filter((t) => t.pnlPct > 0);
  const losses = trades.filter((t) => t.pnlPct <= 0);
  const winCount = wins.length;
  const lossCount = losses.length;
  const winRate = totalTrades > 0 ? winCount / totalTrades : null;
  const averageWinPct =
    wins.length > 0 ? wins.reduce((s, t) => s + t.pnlPct, 0) / wins.length : null;
  const averageLossPct =
    losses.length > 0 ? losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length : null;
  const expectancyPct =
    totalTrades > 0 ? trades.reduce((s, t) => s + t.pnlPct, 0) / totalTrades : null;

  let cum = 0;
  let peak = 0;
  let drawdown = 0;
  for (const t of trades) {
    cum += t.pnlPct;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > drawdown) drawdown = dd;
  }
  const drawdownProxyPct = drawdown;

  const holdHours =
    trades.length > 0
      ? trades.map((t) => (t.exitAt.getTime() - t.entryAt.getTime()) / (60 * 60 * 1000))
      : [];
  const averageHoldHours =
    holdHours.length > 0 ? holdHours.reduce((a, b) => a + b, 0) / holdHours.length : null;

  const blockedByReasonList: BlockedEntryReason[] = Array.from(blockedByReason.entries()).map(
    ([reason, count]) => ({ reason, count })
  );

  return {
    totalTrades,
    winCount,
    lossCount,
    winRate,
    averageWinPct,
    averageLossPct,
    expectancyPct,
    drawdownProxyPct,
    averageHoldHours,
    blockedByReason: blockedByReasonList,
  };
}

/**
 * Run backtest: group snapshots by (marketId, assetId), replay each series, apply entry/exit, collect trades.
 */
export function runBacktest(
  snapshots: PriceSnapshotRow[],
  marketMeta: Map<string, MarketMeta>,
  config: BacktestConfig
): BacktestResult {
  const cfg = mergeConfig(config);
  const rollingWindowMs = (cfg.rollingWindowHours || 24) * 60 * 60 * 1000;

  const trades: SimulatedTrade[] = [];
  const blockedByReason = new Map<string, number>();

  const key = (m: string, a: string) => `${m}:${a}`;
  const groups = new Map<string, PriceSnapshotRow[]>();
  for (const s of snapshots) {
    const k = key(s.marketId, s.assetId);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(s);
  }

  const positions = new Map<string, { entryPrice: number; entryAt: Date }>();

  for (const [, series] of groups) {
    const marketId = series[0].marketId;
    const assetId = series[0].assetId;
    const meta = marketMeta.get(marketId);
    const endDate = meta?.endDate ?? null;
    const liquidityFallback = meta?.liquidityNum ?? 0;

    for (let i = 0; i < series.length; i++) {
      const now = series[i].capturedAt.getTime();
      const windowStart = now - rollingWindowMs;
      const inWindow = series.filter(
        (s) => s.capturedAt.getTime() >= windowStart && s.capturedAt.getTime() <= now
      );
      const f = computeFeaturesAt(
        inWindow,
        now,
        rollingWindowMs,
        endDate,
        liquidityFallback
      );
      if (!f) continue;

      const posKey = key(marketId, assetId);
      const position = positions.get(posKey);

      if (position) {
        const exitCheck = shouldExit(cfg, f, position.entryPrice, position.entryAt);
        if (exitCheck.exit && exitCheck.reason) {
          trades.push({
            marketId,
            assetId,
            entryAt: position.entryAt,
            exitAt: f.at,
            entryPrice: position.entryPrice,
            exitPrice: f.price,
            pnlPct: (f.price - position.entryPrice) / position.entryPrice,
            exitReason: exitCheck.reason,
          });
          positions.delete(posKey);
        }
      } else {
        const entryCheck = canEnter(cfg, f);
        if (!entryCheck.ok && entryCheck.reason) {
          blockedByReason.set(entryCheck.reason, (blockedByReason.get(entryCheck.reason) ?? 0) + 1);
        } else if (entryCheck.ok) {
          positions.set(posKey, { entryPrice: f.price, entryAt: f.at });
        }
      }
    }
  }

  const metrics = aggregateMetrics(trades, blockedByReason);

  const fullConfig = {
    ...config,
    startDate: config.startDate,
    endDate: config.endDate,
    targetProfitPct: cfg.targetProfitPct,
    maxHoldHours: cfg.maxHoldHours,
    minLiquidity: cfg.minLiquidity,
    nearResolutionHours: cfg.nearResolutionHours,
    rollingWindowHours: cfg.rollingWindowHours,
    entryNearLowThreshold: cfg.entryNearLowThreshold,
    exitNearHighThreshold: cfg.exitNearHighThreshold,
  };

  return {
    config: fullConfig,
    trades,
    metrics,
    runAt: new Date().toISOString(),
  };
}
