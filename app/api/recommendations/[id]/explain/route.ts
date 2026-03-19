import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";
import { buildRecommendationExplanation } from "@/lib/recommendations/explainability";

export const dynamic = "force-dynamic";

/**
 * GET /api/recommendations/[id]/explain
 * Returns a normalized explanation for why the recommendation exists.
 * Read-only; uses only persisted recommendation / signal / evaluation / review data.
 * 404 if recommendation not found or not owned by funder.
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

  const rec = await prisma.recommendation.findUnique({
    where: { id },
    include: {
      marketSignal: true,
      review: true,
      evaluations: { orderBy: { evaluatedAt: "desc" }, take: 20 },
    },
  });

  if (!rec || rec.marketSignal.funderAddress !== funder) {
    return NextResponse.json({ error: "Recommendation not found" }, { status: 404 });
  }

  const asset = await prisma.syncedAsset.findFirst({
    where: {
      syncedMarketId: rec.marketSignal.marketId,
      outcome: rec.marketSignal.outcome,
    },
  });

  const explanation = buildRecommendationExplanation({
    recommendation: {
      id: rec.id,
      action: rec.action,
      primaryActionType: rec.primaryActionType ?? null,
      suggestedEntryMin: rec.suggestedEntryMin,
      suggestedEntryMax: rec.suggestedEntryMax,
      suggestedSize: rec.suggestedSize,
      blockedReason: rec.blockedReason,
      priorityScore: rec.priorityScore,
      rationale: rec.rationale ?? null,
      portfolioImpact: rec.portfolioImpact ?? null,
      riskNote: rec.riskNote ?? null,
      timingNote: rec.timingNote ?? null,
      qualityBlocker: rec.qualityBlocker ?? null,
      createdAt: rec.createdAt.toISOString(),
      updatedAt: rec.updatedAt.toISOString(),
    },
    signal: {
      marketPrice: rec.marketSignal.marketPrice,
      fairPrice: rec.marketSignal.fairPrice,
      edge: rec.marketSignal.edge,
      confidence: rec.marketSignal.confidence,
      momentumScore: rec.marketSignal.momentumScore ?? null,
      liquidityScore: rec.marketSignal.liquidityScore ?? null,
      crowdingScore: rec.marketSignal.crowdingScore ?? null,
      portfolioPenalty: rec.marketSignal.portfolioPenalty ?? null,
      behaviorPenalty: rec.marketSignal.behaviorPenalty ?? null,
      category: rec.marketSignal.category ?? null,
      theme: rec.marketSignal.theme ?? null,
      thesis: rec.marketSignal.thesis ?? null,
    },
    marketRef: {
      marketId: rec.marketSignal.marketId,
      marketTitle: rec.marketSignal.marketTitle ?? null,
      outcome: rec.marketSignal.outcome ?? null,
      assetId: asset?.tokenId ?? null,
    },
    assetId: asset?.tokenId ?? null,
    evaluationRefs: rec.evaluations.map((e) => ({
      id: e.id,
      evaluatedAt: e.evaluatedAt.toISOString(),
      marketPriceAtEval: e.marketPriceAtEval,
      priceChange1h: e.priceChange1h ?? null,
      priceChange6h: e.priceChange6h ?? null,
      priceChange24h: e.priceChange24h ?? null,
      wasPositive: e.wasPositive ?? null,
    })),
    reviewRef: rec.review
      ? {
          status: rec.review.status,
          reviewerNote: rec.review.reviewerNote ?? null,
          createdAt: rec.review.createdAt.toISOString(),
          updatedAt: rec.review.updatedAt.toISOString(),
        }
      : null,
  });

  return NextResponse.json(explanation);
}
