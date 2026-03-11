import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";

export const dynamic = "force-dynamic";

/**
 * GET /api/positions/exit-summary
 * Exit decision distribution, recent exit intents, and summary for Analytics.
 */
export async function GET() {
  const funder = await getFunderForRecompute();
  if (!funder) {
    return NextResponse.json(
      { error: "No funder address. Connect wallet and save connection." },
      { status: 400 }
    );
  }

  const [decisions, exitIntents] = await Promise.all([
    prisma.positionDecisionSnapshot.findMany({
      where: { funderAddress: funder },
    }),
    prisma.exitIntent.findMany({
      where: { funderAddress: funder },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
  ]);

  const distribution: Record<string, number> = {};
  for (const d of decisions) {
    distribution[d.decisionState] = (distribution[d.decisionState] ?? 0) + 1;
  }

  const byExitType: Record<string, number> = {};
  for (const e of exitIntents) {
    byExitType[e.exitType] = (byExitType[e.exitType] ?? 0) + 1;
  }

  const takeProfitCount = exitIntents.filter((e) => e.exitType === "TAKE_PROFIT").length;
  const thesisBrokenCount = exitIntents.filter((e) => e.exitType === "THESIS_BROKEN").length;

  return NextResponse.json({
    decisionDistribution: distribution,
    exitTimingSummary: byExitType,
    takeProfitCount,
    thesisBrokenCount,
    totalExits: exitIntents.length,
    recentExitIntents: exitIntents.slice(0, 20).map((e) => ({
      id: e.id,
      assetId: e.assetId,
      marketId: e.marketId,
      exitType: e.exitType,
      size: e.size,
      limitPrice: e.limitPrice,
      status: e.status,
      createdAt: e.createdAt.toISOString(),
    })),
    avgPostExitMove: null,
  });
}
