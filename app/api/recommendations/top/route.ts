import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";

export const dynamic = "force-dynamic";

/**
 * GET /api/recommendations/top
 * Returns top N recommendations by priority score (default 10). Excludes NO_TRADE for "top" view.
 */
export async function GET(request: Request) {
  const funder = await getFunderForRecompute();
  if (!funder) {
    return NextResponse.json(
      { error: "No funder address. Connect wallet and save connection." },
      { status: 400 }
    );
  }

  const { searchParams } = new URL(request.url);
  const limit = Math.min(Number(searchParams.get("limit")) || 10, 50);

  const list = await prisma.recommendation.findMany({
    where: {
      marketSignal: { funderAddress: funder },
      action: { not: "NO_TRADE" },
    },
    take: limit * 2,
    include: { marketSignal: true, review: true },
  });
  list.sort((a, b) => parseFloat(b.priorityScore) - parseFloat(a.priorityScore));
  const top = list.slice(0, limit);

  return NextResponse.json({
    funderAddress: funder,
    recommendations: top.map((r) => ({
      id: r.id,
      action: r.action,
      primaryActionType: r.primaryActionType ?? null,
      rationale: r.rationale ?? null,
      portfolioImpact: r.portfolioImpact ?? null,
      riskNote: r.riskNote ?? null,
      timingNote: r.timingNote ?? null,
      qualityBlocker: r.qualityBlocker ?? null,
      reviewStatus: r.review?.status ?? "NEW",
      suggestedEntryMin: r.suggestedEntryMin,
      suggestedEntryMax: r.suggestedEntryMax,
      suggestedSize: r.suggestedSize,
      blockedReason: r.blockedReason,
      priorityScore: r.priorityScore,
      signal: {
        id: r.marketSignal.id,
        marketTitle: r.marketSignal.marketTitle,
        outcome: r.marketSignal.outcome,
        side: r.marketSignal.side,
        marketPrice: r.marketSignal.marketPrice,
        fairPrice: r.marketSignal.fairPrice,
        edge: r.marketSignal.edge,
        confidence: r.marketSignal.confidence,
        signalType: r.marketSignal.signalType,
        thesis: r.marketSignal.thesis,
        invalidation: r.marketSignal.invalidation,
        category: r.marketSignal.category,
        theme: r.marketSignal.theme,
        momentumComponent: r.marketSignal.momentumComponent,
        liquidityComponent: r.marketSignal.liquidityComponent,
        crowdingComponent: r.marketSignal.crowdingComponent,
        portfolioComponent: r.marketSignal.portfolioComponent,
        behaviorComponent: r.marketSignal.behaviorComponent,
        longshotComponent: r.marketSignal.longshotComponent,
        timeComponent: r.marketSignal.timeComponent,
      },
    })),
  });
}
