/**
 * Portfolio analytics: aggregate derived positions into snapshot, compute exposure and PnL.
 * Read-only. Persists PortfolioSnapshot.
 * TODO: Recommendation engine will plug in here for suggested rebalancing / risk actions.
 */

import { prisma } from "@/lib/db";
import type { DerivedPositionRow } from "./portfolio";

function parseNum(s: string): number {
  const n = parseFloat(String(s).trim());
  return Number.isFinite(n) ? n : 0;
}

function toStr(n: number): string {
  return String(Number.isFinite(n) ? n : 0);
}

export interface SnapshotInput {
  funderAddress: string;
  positions: DerivedPositionRow[];
  openOrdersCount: number;
}

/**
 * Compute portfolio snapshot from derived positions and order count.
 * All exposure/aggregates use current value (mark-to-market), not max payout.
 */
export function computeSnapshot(input: SnapshotInput): {
  totalOpenExposure: string;
  totalCurrentValue: string;
  totalCostBasis: string;
  totalMaxPayout: string;
  totalReservedExposure: string;
  realizedPnl: string;
  unrealizedPnl: string;
  openPositionsCount: number;
  openOrdersCount: number;
  topConcentrationPct: string;
  yesExposure: string;
  noExposure: string;
} {
  const { positions, openOrdersCount } = input;
  let totalCurrentValue = 0;
  let totalCostBasis = 0;
  let totalMaxPayout = 0;
  let totalReserved = 0;
  let unrealizedPnl = 0;
  let realizedPnl = 0;
  let yesExposure = 0;
  let noExposure = 0;
  const byTheme = new Map<string, number>();

  for (const p of positions) {
    const currentValue = parseNum(p.marketValue);
    const costBasis = parseNum(p.costBasis);
    const maxPayout = parseNum(p.maxPayout);
    const res = parseNum(p.reservedOrderValue);
    totalCurrentValue += currentValue;
    totalCostBasis += costBasis;
    totalMaxPayout += maxPayout;
    totalReserved += res;
    unrealizedPnl += parseNum(p.unrealizedPnl);
    realizedPnl += parseNum(p.realizedPnl);
    const theme = p.theme ?? "Other";
    byTheme.set(theme, (byTheme.get(theme) ?? 0) + currentValue);
    if (p.outcome.toUpperCase() === "YES") yesExposure += currentValue;
    else if (p.outcome.toUpperCase() === "NO") noExposure += currentValue;
  }

  let topPct = 0;
  if (totalCurrentValue > 0 && byTheme.size > 0) {
    const maxTheme = Math.max(...Array.from(byTheme.values()));
    topPct = (maxTheme / totalCurrentValue) * 100;
  }

  return {
    totalOpenExposure: toStr(totalCurrentValue),
    totalCurrentValue: toStr(totalCurrentValue),
    totalCostBasis: toStr(totalCostBasis),
    totalMaxPayout: toStr(totalMaxPayout),
    totalReservedExposure: toStr(totalReserved),
    realizedPnl: toStr(realizedPnl),
    unrealizedPnl: toStr(unrealizedPnl),
    openPositionsCount: positions.length,
    openOrdersCount,
    topConcentrationPct: toStr(topPct),
    yesExposure: toStr(yesExposure),
    noExposure: toStr(noExposure),
  };
}

/**
 * Persist snapshot to DB.
 */
export async function persistSnapshot(
  funderAddress: string,
  data: ReturnType<typeof computeSnapshot>
): Promise<void> {
  await prisma.portfolioSnapshot.create({
    data: {
      funderAddress,
      totalOpenExposure: data.totalOpenExposure,
      totalReservedExposure: data.totalReservedExposure,
      realizedPnl: data.realizedPnl,
      unrealizedPnl: data.unrealizedPnl,
      openPositionsCount: data.openPositionsCount,
      openOrdersCount: data.openOrdersCount,
      topConcentrationPct: data.topConcentrationPct,
      yesExposure: data.yesExposure,
      noExposure: data.noExposure,
    },
  });
}
