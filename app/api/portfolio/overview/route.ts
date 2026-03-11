import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";

export const dynamic = "force-dynamic";

function parseNum(s: string): number {
  const n = parseFloat(String(s).trim());
  return Number.isFinite(n) ? n : 0;
}

/**
 * GET /api/portfolio/overview
 * Returns latest portfolio snapshot for the connected funder.
 * Snapshot totals: totalCurrentValue = mark-to-market (Polymarket "Value"); totalCostBasis = Traded; totalMaxPayout = To win.
 */
export async function GET() {
  const funder = await getFunderForRecompute();
  if (!funder) {
    return NextResponse.json(
      { error: "No funder address. Connect wallet and save connection." },
      { status: 400 }
    );
  }
  const [snapshot, positions] = await Promise.all([
    prisma.portfolioSnapshot.findFirst({
      where: { funderAddress: funder },
      orderBy: { createdAt: "desc" },
    }),
    prisma.derivedPosition.findMany({ where: { funderAddress: funder } }),
  ]);
  if (!snapshot) {
    return NextResponse.json({
      funderAddress: funder,
      snapshot: null,
      message: "Run portfolio recompute to generate overview.",
    });
  }
  const totalCostBasis = positions.reduce((s, p) => s + parseNum(p.costBasis), 0);
  const totalMaxPayout = positions.reduce((s, p) => s + parseNum(p.size) * 1, 0);
  return NextResponse.json({
    funderAddress: funder,
    snapshot: {
      id: snapshot.id,
      totalOpenExposure: snapshot.totalOpenExposure,
      totalCurrentValue: snapshot.totalOpenExposure,
      totalCostBasis: String(totalCostBasis),
      totalMaxPayout: String(totalMaxPayout),
      totalReservedExposure: snapshot.totalReservedExposure,
      realizedPnl: snapshot.realizedPnl,
      unrealizedPnl: snapshot.unrealizedPnl,
      openPositionsCount: snapshot.openPositionsCount,
      openOrdersCount: snapshot.openOrdersCount,
      topConcentrationPct: snapshot.topConcentrationPct,
      yesExposure: snapshot.yesExposure,
      noExposure: snapshot.noExposure,
      createdAt: snapshot.createdAt.toISOString(),
    },
  });
}
