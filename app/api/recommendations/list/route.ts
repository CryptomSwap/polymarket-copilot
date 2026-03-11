import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";

export const dynamic = "force-dynamic";

/**
 * GET /api/recommendations/list
 * Returns all recommendations with their signals for the connected funder.
 * Query: action, category, theme, primaryActionType (v2: add|review_existing|trim|hedge|avoid|monitor|sync_first), sort=priorityScore|edge|confidence
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
  const action = searchParams.get("action") ?? undefined;
  const category = searchParams.get("category") ?? undefined;
  const theme = searchParams.get("theme") ?? undefined;
  const primaryActionType = searchParams.get("primaryActionType") ?? undefined;
  const sort = searchParams.get("sort") ?? "priorityScore";
  const includeNews = searchParams.get("includeNews") === "1";

  const where = {
    marketSignal: {
      funderAddress: funder,
      ...(category && { category }),
      ...(theme && { theme }),
    },
    ...(action && { action }),
    ...(primaryActionType && { primaryActionType }),
  };

  const list = await prisma.recommendation.findMany({
    where,
    include: { marketSignal: true, review: true },
  });

  list.sort((a, b) => {
    if (sort === "edge") return parseFloat(b.marketSignal.edge) - parseFloat(a.marketSignal.edge);
    if (sort === "confidence") return parseFloat(b.marketSignal.confidence) - parseFloat(a.marketSignal.confidence);
    return parseFloat(b.priorityScore) - parseFloat(a.priorityScore);
  });

  const mlRunIds = Array.from(new Set(list.map((r) => r.mlModelRunId).filter(Boolean) as string[]));
  const mlRuns = mlRunIds.length > 0
    ? await prisma.mlModelRun.findMany({ where: { id: { in: mlRunIds } }, select: { id: true, status: true } })
    : [];
  const mlRunById = Object.fromEntries(mlRuns.map((r) => [r.id, r]));

  const recIds = list.map((r) => r.id);
  const decisionSnapshots = recIds.length > 0
    ? await prisma.decisionPolicySnapshot.findMany({
        where: { recommendationId: { in: recIds }, funderAddress: funder },
      })
    : [];
  const decisionByRecId = Object.fromEntries(decisionSnapshots.map((d) => [d.recommendationId, d]));

  let newsByMarket: Record<string, { linkedNewsCount: number; linkedNewsCount24h: number; saturation: number }> = {};
  if (includeNews && list.length > 0) {
    const marketIds = Array.from(new Set(list.map((r) => r.marketSignal.marketId)));
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [totalByMarket, count24hByMarket] = await Promise.all([
      prisma.marketNewsLink.groupBy({
        by: ["marketId"],
        where: { marketId: { in: marketIds } },
        _count: true,
      }),
      prisma.marketNewsLink.groupBy({
        by: ["marketId"],
        where: { marketId: { in: marketIds }, newsItem: { publishedAt: { gte: since24h } } },
        _count: true,
      }),
    ]);
    const count24h: Record<string, number> = {};
    count24hByMarket.forEach((r) => { count24h[r.marketId] = r._count; });
    totalByMarket.forEach((r) => {
      const c24 = count24h[r.marketId] ?? 0;
      newsByMarket[r.marketId] = {
        linkedNewsCount: r._count,
        linkedNewsCount24h: c24,
        saturation: c24 <= 2 ? 0 : c24 <= 5 ? 0.3 : c24 <= 10 ? 0.6 : Math.min(1, 0.7 + (c24 - 10) / 50),
      };
    });
  }

  return NextResponse.json({
    funderAddress: funder,
    recommendations: list.map((r) => ({
      id: r.id,
      action: r.action,
      primaryActionType: r.primaryActionType ?? null,
      rationale: r.rationale ?? null,
      portfolioImpact: r.portfolioImpact ?? null,
      riskNote: r.riskNote ?? null,
      timingNote: r.timingNote ?? null,
      qualityBlocker: r.qualityBlocker ?? null,
      reviewStatus: r.review?.status ?? "NEW",
      reviewerNote: r.review?.reviewerNote ?? null,
      suggestedEntryMin: r.suggestedEntryMin,
      suggestedEntryMax: r.suggestedEntryMax,
      suggestedSize: r.suggestedSize,
      blockedReason: r.blockedReason,
      priorityScore: r.priorityScore,
      mlScore: r.mlScore ?? null,
      mlModelRunId: r.mlModelRunId ?? null,
      mlModelRunStatus: r.mlModelRunId ? mlRunById[r.mlModelRunId]?.status ?? null : null,
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
        eventImpactBoost: r.marketSignal.eventImpactBoost,
        narrativeMomentumBoost: r.marketSignal.narrativeMomentumBoost,
        catalystConfidence: r.marketSignal.catalystConfidence,
        marketId: r.marketSignal.marketId,
      },
      ...(includeNews && {
        linkedNewsCount: newsByMarket[r.marketSignal.marketId]?.linkedNewsCount ?? 0,
        linkedNewsCount24h: newsByMarket[r.marketSignal.marketId]?.linkedNewsCount24h ?? 0,
        saturation: newsByMarket[r.marketSignal.marketId]?.saturation ?? 0,
      }),
      decision: decisionByRecId[r.id]
        ? {
            policyState: decisionByRecId[r.id].policyState,
            blendedScore: decisionByRecId[r.id].blendedScore,
            sizeMultiplier: decisionByRecId[r.id].sizeMultiplier,
            finalSuggestedSize: decisionByRecId[r.id].finalSuggestedSize,
            reasoningJson: decisionByRecId[r.id].reasoningJson,
          }
        : null,
    })),
  });
}
