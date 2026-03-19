import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";

export const dynamic = "force-dynamic";

/**
 * GET /api/analytics/data
 * Returns overview, positions, behavior flags, recent fills, and recent orders for the analytics page.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const limit = Math.min(Number(searchParams.get("limit")) || 20, 100);

  const funder = await getFunderForRecompute();
  if (!funder) {
    return NextResponse.json(
      { error: "No funder address. Connect wallet and save connection." },
      { status: 400 }
    );
  }

  const [snapshot, positions, flags, recentFills, recentOrders] = await Promise.all([
    prisma.portfolioSnapshot.findFirst({
      where: { funderAddress: funder },
      orderBy: { createdAt: "desc" },
    }),
    prisma.derivedPosition.findMany({
      where: { funderAddress: funder },
    }),
    prisma.behaviorFlag.findMany({
      where: { funderAddress: funder },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
    prisma.userFill.findMany({
      where: { funderAddress: funder },
      orderBy: { syncedAt: "desc" },
      take: limit,
    }),
    prisma.userOrder.findMany({
      where: { funderAddress: funder },
      orderBy: { syncedAt: "desc" },
      take: limit,
    }),
  ]);

  const positionsSorted = [...positions].sort(
    (a, b) => parseFloat(b.marketValue) - parseFloat(a.marketValue)
  );

  return NextResponse.json({
    funderAddress: funder,
    snapshot: snapshot
      ? {
          totalOpenExposure: snapshot.totalOpenExposure,
          totalReservedExposure: snapshot.totalReservedExposure,
          realizedPnl: snapshot.realizedPnl,
          unrealizedPnl: snapshot.unrealizedPnl,
          openPositionsCount: snapshot.openPositionsCount,
          openOrdersCount: snapshot.openOrdersCount,
          topThemeConcentrationPct: snapshot.topThemeConcentrationPct,
          topMarketConcentrationPct: snapshot.topMarketConcentrationPct ?? null,
          yesExposure: snapshot.yesExposure,
          noExposure: snapshot.noExposure,
          createdAt: snapshot.createdAt.toISOString(),
        }
      : null,
    positions: positionsSorted.map((p) => ({
      id: `${p.funderAddress}-${p.assetId}`,
      marketTitle: p.marketTitle,
      outcome: p.outcome,
      marketValue: p.marketValue,
      category: p.category,
      theme: p.theme,
    })),
    flags: flags.map((f) => ({
      id: f.id,
      type: f.type,
      severity: f.severity,
      marketTitle: f.marketTitle,
      description: f.description,
      createdAt: f.createdAt.toISOString(),
    })),
    recentFills: recentFills.map((f) => ({
      id: `${f.funderAddress}-${f.tradeId}`,
      tradeId: f.tradeId,
      market: f.market,
      assetId: f.assetId,
      side: f.side,
      size: f.size,
      price: f.price,
      matchTime: f.matchTime,
      outcome: f.outcome,
      syncedAt: f.syncedAt?.toISOString() ?? "",
    })),
    recentOrders: recentOrders.map((o) => ({
      id: `${o.funderAddress}-${o.orderId}`,
      orderId: o.orderId,
      market: o.market,
      assetId: o.assetId,
      side: o.side,
      originalSize: o.originalSize,
      sizeMatched: o.sizeMatched,
      price: o.price,
      status: o.status,
      outcome: o.outcome,
      syncedAt: o.syncedAt?.toISOString() ?? "",
    })),
  });
}
