import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";
import { logShown } from "@/lib/analytics/lifecycle";
import { getPortfolioIntelligence } from "@/lib/portfolio/intelligence";

export const dynamic = "force-dynamic";

/**
 * GET /api/recommendations/[id]
 * Returns full recommendation with signal, market, review, evaluations, and related exposure.
 */
export async function GET(
  request: Request,
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
      lifecycleEvents: { orderBy: { createdAt: "desc" }, take: 50 },
      executionOutcomes: true,
      decisionSnapshots: { where: { funderAddress: funder }, take: 1 },
    },
  });

  if (!rec || rec.marketSignal.funderAddress !== funder) {
    return NextResponse.json({ error: "Recommendation not found" }, { status: 404 });
  }

  const asset = await prisma.syncedAsset.findFirst({
    where: { syncedMarketId: rec.marketSignal.marketId, outcome: rec.marketSignal.outcome },
  });
  const position = asset
    ? await prisma.derivedPosition.findUnique({
        where: { funderAddress_assetId: { funderAddress: funder, assetId: asset.tokenId } },
      })
    : null;

  const market = await prisma.syncedMarket.findUnique({
    where: { id: rec.marketSignal.marketId },
    include: { assets: true },
  });

  const [latestPreflight, reconciliationForRec, journalEntries, intelligence] = await Promise.all([
    prisma.tradePreflightCheck.findFirst({
      where: { recommendationId: id },
      orderBy: { createdAt: "desc" },
    }),
    (async () => {
      const intents = await prisma.orderIntent.findMany({
        where: { recommendationId: id },
        include: { executedOrders: true },
      });
      const pmOrderIds = intents.flatMap((i) => i.executedOrders.map((e) => e.polymarketOrderId));
      if (pmOrderIds.length === 0) return [];
      return prisma.orderReconciliationSnapshot.findMany({
        where: { funderAddress: funder, polymarketOrderId: { in: pmOrderIds } },
      });
    })(),
    prisma.postTradeJournalEntry.findMany({
      where: { recommendationId: id },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
    getPortfolioIntelligence({ funderAddress: funder }).catch(() => null),
  ]);

  const categoryKey = rec.marketSignal.category ?? "other";
  const themeKey = rec.marketSignal.theme ?? "Other";
  const categoryBucket = intelligence?.buckets.byCategory.find((b) => b.key === categoryKey);
  const themeBucket = intelligence?.buckets.byTheme.find((b) => b.key === themeKey);
  let timeToResolutionDays: number | null = null;
  if (market?.endDate) {
    const days = (market.endDate.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    timeToResolutionDays = Math.max(0, Math.round(days));
  }
  const recommendationDiagnostics = {
    isHeld: !!position,
    categoryExposurePct: categoryBucket?.pct ?? 0,
    themeExposurePct: themeBucket?.pct ?? 0,
    timeToResolutionDays,
    nearResolutionCount: intelligence?.summary.nearResolutionPositions ?? 0,
    staleCount: intelligence?.summary.stalePositions ?? 0,
    unresolvedCount: intelligence?.summary.unresolvedPositions ?? 0,
  };

  void logShown(rec.id, funder);

  return NextResponse.json({
    recommendation: {
      id: rec.id,
      action: rec.action,
      suggestedEntryMin: rec.suggestedEntryMin,
      suggestedEntryMax: rec.suggestedEntryMax,
      suggestedSize: rec.suggestedSize,
      blockedReason: rec.blockedReason,
      priorityScore: rec.priorityScore,
      primaryActionType: rec.primaryActionType ?? null,
      rationale: rec.rationale ?? null,
      portfolioImpact: rec.portfolioImpact ?? null,
      riskNote: rec.riskNote ?? null,
      timingNote: rec.timingNote ?? null,
      qualityBlocker: rec.qualityBlocker ?? null,
      createdAt: rec.createdAt.toISOString(),
      updatedAt: rec.updatedAt.toISOString(),
    },
    review: rec.review
      ? {
          status: rec.review.status,
          reviewerNote: rec.review.reviewerNote,
          createdAt: rec.review.createdAt.toISOString(),
          updatedAt: rec.review.updatedAt.toISOString(),
        }
      : { status: "NEW", reviewerNote: null, createdAt: null, updatedAt: null },
    assetId: asset?.tokenId ?? null,
    signal: {
      id: rec.marketSignal.id,
      marketId: rec.marketSignal.marketId,
      marketTitle: rec.marketSignal.marketTitle,
      outcome: rec.marketSignal.outcome,
      side: rec.marketSignal.side,
      marketPrice: rec.marketSignal.marketPrice,
      fairPrice: rec.marketSignal.fairPrice,
      edge: rec.marketSignal.edge,
      confidence: rec.marketSignal.confidence,
      signalType: rec.marketSignal.signalType,
      thesis: rec.marketSignal.thesis,
      invalidation: rec.marketSignal.invalidation,
      momentumComponent: rec.marketSignal.momentumComponent,
      liquidityComponent: rec.marketSignal.liquidityComponent,
      crowdingComponent: rec.marketSignal.crowdingComponent,
      portfolioComponent: rec.marketSignal.portfolioComponent,
      behaviorComponent: rec.marketSignal.behaviorComponent,
      longshotComponent: rec.marketSignal.longshotComponent,
      timeComponent: rec.marketSignal.timeComponent,
      category: rec.marketSignal.category,
      theme: rec.marketSignal.theme,
    },
    market: market
      ? {
          id: market.id,
          slug: market.slug,
          title: market.title,
          status: market.status,
          category: market.category,
        }
      : null,
    recommendationDiagnostics,
    evaluations: rec.evaluations.map((e) => ({
      id: e.id,
      evaluatedAt: e.evaluatedAt.toISOString(),
      marketPriceAtEval: e.marketPriceAtEval,
      priceChange1h: e.priceChange1h,
      priceChange6h: e.priceChange6h,
      priceChange24h: e.priceChange24h,
      wasPositive: e.wasPositive,
      metadata: e.metadata,
    })),
    relatedPosition: position
      ? {
          assetId: position.assetId,
          size: position.size,
          avgEntry: position.avgEntry,
          marketValue: position.marketValue,
          unrealizedPnl: position.unrealizedPnl,
        }
      : null,
    lifecycleEvents: rec.lifecycleEvents.map((e) => ({
      id: e.id,
      eventType: e.eventType,
      metadata: e.metadata,
      createdAt: e.createdAt.toISOString(),
    })),
    decision: rec.decisionSnapshots[0]
      ? {
          policyState: rec.decisionSnapshots[0].policyState,
          blendedScore: rec.decisionSnapshots[0].blendedScore,
          sizeMultiplier: rec.decisionSnapshots[0].sizeMultiplier,
          finalSuggestedSize: rec.decisionSnapshots[0].finalSuggestedSize,
          reasoningJson: rec.decisionSnapshots[0].reasoningJson,
          createdAt: rec.decisionSnapshots[0].createdAt.toISOString(),
          updatedAt: rec.decisionSnapshots[0].updatedAt.toISOString(),
        }
      : null,
    executionOutcomes: rec.executionOutcomes.map((o) => ({
      id: o.id,
      orderIntentId: o.orderIntentId,
      executedOrderId: o.executedOrderId,
      actedOn: o.actedOn,
      overridden: o.overridden,
      matchedSuggestedSide: o.matchedSuggestedSide,
      matchedSuggestedSize: o.matchedSuggestedSize,
      matchedSuggestedPrice: o.matchedSuggestedPrice,
      suggestedSize: o.suggestedSize,
      actualSize: o.actualSize,
      suggestedPrice: o.suggestedPrice,
      actualPrice: o.actualPrice,
      slippage: o.slippage,
      fillStatus: o.fillStatus,
      forwardReturn1h: o.forwardReturn1h,
      forwardReturn6h: o.forwardReturn6h,
      forwardReturn24h: o.forwardReturn24h,
      pnlIfActed: o.pnlIfActed,
      pnlIfIgnored: o.pnlIfIgnored,
      createdAt: o.createdAt.toISOString(),
    })),
    latestPreflight: latestPreflight
      ? {
          id: latestPreflight.id,
          passed: latestPreflight.passed,
          marketActiveOk: latestPreflight.marketActiveOk,
          tickSizeOk: latestPreflight.tickSizeOk,
          warningsJson: latestPreflight.warningsJson,
          createdAt: latestPreflight.createdAt.toISOString(),
        }
      : null,
    reconciliationSnapshots: reconciliationForRec.map((s) => ({
      polymarketOrderId: s.polymarketOrderId,
      localStatus: s.localStatus,
      remoteStatus: s.remoteStatus,
      filledSize: s.filledSize,
      remainingSize: s.remainingSize,
      avgFillPrice: s.avgFillPrice,
      mismatch: s.mismatch,
      updatedAt: s.updatedAt.toISOString(),
    })),
    postTradeJournalEntries: journalEntries.map((e) => ({
      id: e.id,
      note: e.note,
      tag: e.tag,
      executedOrderId: e.executedOrderId,
      createdAt: e.createdAt.toISOString(),
    })),
  });
}
