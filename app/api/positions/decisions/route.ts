import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";

export const dynamic = "force-dynamic";

/**
 * GET /api/positions/decisions
 * List position decision snapshots for the current funder with position details.
 */
export async function GET() {
  const funder = await getFunderForRecompute();
  if (!funder) {
    return NextResponse.json(
      { error: "No funder address. Connect wallet and save connection." },
      { status: 400 }
    );
  }

  const snapshots = await prisma.positionDecisionSnapshot.findMany({
    where: { funderAddress: funder },
    include: {
      position: true,
    },
    orderBy: { updatedAt: "desc" },
  });

  return NextResponse.json({
    decisions: snapshots.map((s) => ({
      id: s.id,
      funderAddress: s.funderAddress,
      assetId: s.assetId,
      marketId: s.position.marketId,
      marketTitle: s.position.marketTitle,
      outcome: s.position.outcome,
      decisionState: s.decisionState,
      confidence: s.confidence,
      suggestedExitSize: s.suggestedExitSize,
      reasoningJson: s.reasoningJson,
      positionSize: s.position.size,
      unrealizedPnl: s.position.unrealizedPnl,
      lastPrice: s.position.lastPrice,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
    })),
  });
}
