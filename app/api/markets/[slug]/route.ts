import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";

export const dynamic = "force-dynamic";

/**
 * GET /api/markets/[slug]
 * Returns market detail: title, category/theme, outcomes and prices, snapshots, signals, recommendations, positions, fills, orders, flags, notes.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const funder = await getFunderForRecompute();
  if (!funder) {
    return NextResponse.json(
      { error: "No funder address. Connect wallet and save connection." },
      { status: 400 }
    );
  }

  const { slug } = await params;
  const slugDecoded = decodeURIComponent(slug);

  const market = await prisma.syncedMarket.findUnique({
    where: { slug: slugDecoded },
    include: { assets: true },
  });
  if (!market) {
    return NextResponse.json({ error: "Market not found" }, { status: 404 });
  }

  let rawJson: Record<string, unknown> | null = null;
  if (market.raw) {
    try {
      rawJson = JSON.parse(market.raw) as Record<string, unknown>;
    } catch {
      rawJson = null;
    }
  }
  const outcomePrices: string[] = [];
  if (rawJson) {
    const prices = rawJson.outcomePrices ?? rawJson.prices;
    if (Array.isArray(prices)) outcomePrices.push(...prices.map(String));
    else if (typeof prices === "string") {
      try {
        const arr = JSON.parse(prices) as unknown[];
        outcomePrices.push(...arr.map(String));
      } catch {
        // ignore
      }
    }
  }

  const assetIds = market.assets.map((a) => a.tokenId);
  const [snapshots, signals, positions, fills, orders, flags, notes] = await Promise.all([
    prisma.marketPriceSnapshot.findMany({
      where: { marketId: market.id, assetId: { in: assetIds } },
      orderBy: { capturedAt: "desc" },
      take: 50,
    }),
    prisma.marketSignal.findMany({
      where: { funderAddress: funder, marketId: market.id },
      include: { recommendation: { include: { review: true, decisionSnapshots: { where: { funderAddress: funder }, take: 1 } } } },
    }),
    prisma.derivedPosition.findMany({
      where: { funderAddress: funder, syncedMarketId: market.id },
    }),
    prisma.userFill.findMany({
      where: { funderAddress: funder, assetId: { in: assetIds } },
      orderBy: { syncedAt: "desc" },
      take: 20,
    }),
    prisma.userOrder.findMany({
      where: { funderAddress: funder, assetId: { in: assetIds } },
      orderBy: { syncedAt: "desc" },
      take: 20,
    }),
    prisma.behaviorFlag.findMany({
      where: { funderAddress: funder },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
    prisma.marketNote.findMany({
      where: { funderAddress: funder, marketId: market.id },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  const byAsset = new Map<string, { outcome: string; outcomeIndex: number }>();
  for (const a of market.assets) {
    byAsset.set(a.tokenId, { outcome: a.outcome, outcomeIndex: a.outcomeIndex ?? 0 });
  }
  const snapshotByAsset = new Map<string, typeof snapshots>();
  for (const s of snapshots) {
    if (!snapshotByAsset.has(s.assetId)) snapshotByAsset.set(s.assetId, []);
    snapshotByAsset.get(s.assetId)!.push(s);
  }

  return NextResponse.json({
    market: {
      id: market.id,
      slug: market.slug,
      title: market.title,
      status: market.status,
      category: market.category,
      endDate: market.endDate?.toISOString() ?? null,
      volumeNum: market.volumeNum,
      liquidityNum: market.liquidityNum,
    },
    outcomes: market.assets.map((a) => ({
      assetId: a.tokenId,
      outcome: a.outcome,
      outcomeIndex: a.outcomeIndex,
      price: outcomePrices[a.outcomeIndex ?? 0] ?? null,
    })),
    priceSnapshots: market.assets.map((a) => ({
      assetId: a.tokenId,
      outcome: a.outcome,
      snapshots: (snapshotByAsset.get(a.tokenId) ?? []).slice(0, 30).map((s) => ({
        price: s.price,
        capturedAt: s.capturedAt.toISOString(),
      })),
    })),
    signals: signals.map((s) => ({
      id: s.id,
      outcome: s.outcome,
      marketPrice: s.marketPrice,
      fairPrice: s.fairPrice,
      edge: s.edge,
      confidence: s.confidence,
      signalType: s.signalType,
      thesis: s.thesis,
      invalidation: s.invalidation,
      momentumComponent: s.momentumComponent,
      liquidityComponent: s.liquidityComponent,
      crowdingComponent: s.crowdingComponent,
      portfolioComponent: s.portfolioComponent,
      behaviorComponent: s.behaviorComponent,
      longshotComponent: s.longshotComponent,
      timeComponent: s.timeComponent,
      recommendation: s.recommendation
        ? {
            id: s.recommendation.id,
            action: s.recommendation.action,
            suggestedSize: s.recommendation.suggestedSize,
            blockedReason: s.recommendation.blockedReason,
            review: s.recommendation.review
              ? {
                  status: s.recommendation.review.status,
                  reviewerNote: s.recommendation.review.reviewerNote,
                  updatedAt: s.recommendation.review.updatedAt.toISOString(),
                }
              : { status: "NEW", reviewerNote: null, updatedAt: null },
            decision: s.recommendation.decisionSnapshots?.[0]
              ? {
                  policyState: s.recommendation.decisionSnapshots[0].policyState,
                  blendedScore: s.recommendation.decisionSnapshots[0].blendedScore,
                  sizeMultiplier: s.recommendation.decisionSnapshots[0].sizeMultiplier,
                  finalSuggestedSize: s.recommendation.decisionSnapshots[0].finalSuggestedSize,
                }
              : null,
          }
        : null,
    })),
    positions: positions.map((p) => ({
      assetId: p.assetId,
      marketTitle: p.marketTitle,
      outcome: p.outcome,
      size: p.size,
      avgEntry: p.avgEntry,
      marketValue: p.marketValue,
      unrealizedPnl: p.unrealizedPnl,
    })),
    recentFills: fills.map((f) => ({
      tradeId: f.tradeId,
      assetId: f.assetId,
      side: f.side,
      size: f.size,
      price: f.price,
      outcome: f.outcome,
      syncedAt: f.syncedAt?.toISOString() ?? "",
    })),
    recentOrders: orders.map((o) => ({
      orderId: o.orderId,
      assetId: o.assetId,
      side: o.side,
      originalSize: o.originalSize,
      price: o.price,
      status: o.status,
      outcome: o.outcome,
      syncedAt: o.syncedAt?.toISOString() ?? "",
    })),
    behaviorFlags: flags.map((f) => ({
      type: f.type,
      severity: f.severity,
      description: f.description,
      marketTitle: f.marketTitle,
    })),
    notes: notes.map((n) => ({
      id: n.id,
      note: n.note,
      tag: n.tag,
      createdAt: n.createdAt.toISOString(),
    })),
  });
}
