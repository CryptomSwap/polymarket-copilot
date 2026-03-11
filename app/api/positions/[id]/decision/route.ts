import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";

export const dynamic = "force-dynamic";

/**
 * GET /api/positions/[id]/decision
 * Get decision snapshot for a position. Id is position key "funderAddress-assetId" or assetId for current funder.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const funder = await getFunderForRecompute();
  if (!funder) {
    return NextResponse.json(
      { error: "No funder address. Connect wallet and save connection." },
      { status: 400 }
    );
  }

  const { id } = await params;
  const assetId = id.includes("-") ? id.substring(id.indexOf("-") + 1) : id;

  const snapshot = await prisma.positionDecisionSnapshot.findUnique({
    where: {
      funderAddress_assetId: { funderAddress: funder, assetId },
    },
    include: { position: true },
  });

  if (!snapshot) {
    return NextResponse.json(
      { error: "Position decision not found. Run recompute-decisions." },
      { status: 404 }
    );
  }

  let reasoning: string[] = [];
  if (snapshot.reasoningJson) {
    try {
      reasoning = JSON.parse(snapshot.reasoningJson) as string[];
    } catch { /* ignore */ }
  }

  return NextResponse.json({
    id: snapshot.id,
    funderAddress: snapshot.funderAddress,
    assetId: snapshot.assetId,
    marketId: snapshot.position.marketId,
    marketTitle: snapshot.position.marketTitle,
    outcome: snapshot.position.outcome,
    decisionState: snapshot.decisionState,
    confidence: snapshot.confidence,
    suggestedExitSize: snapshot.suggestedExitSize,
    reasoning,
    position: {
      size: snapshot.position.size,
      avgEntry: snapshot.position.avgEntry,
      lastPrice: snapshot.position.lastPrice,
      unrealizedPnl: snapshot.position.unrealizedPnl,
      marketValue: snapshot.position.marketValue,
      theme: snapshot.position.theme,
      category: snapshot.position.category,
    },
    createdAt: snapshot.createdAt.toISOString(),
    updatedAt: snapshot.updatedAt.toISOString(),
  });
}
