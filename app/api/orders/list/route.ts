import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";

export const dynamic = "force-dynamic";

/**
 * GET /api/orders/list
 * Returns recent order intents, executed orders, and open orders (UserOrder) for the funder.
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
  const limit = Math.min(Number(searchParams.get("limit")) || 50, 100);

  const [intents, executed, openOrders] = await Promise.all([
    prisma.orderIntent.findMany({
      where: { funderAddress: funder },
      orderBy: { createdAt: "desc" },
      take: limit,
      include: { executedOrders: true },
    }),
    prisma.executedOrder.findMany({
      where: { funderAddress: funder },
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
    prisma.userOrder.findMany({
      where: { funderAddress: funder },
      orderBy: { syncedAt: "desc" },
      take: limit,
    }),
  ]);

  const intentIds = intents.map((i) => i.id);
  const polymarketOrderIds = executed.map((e) => e.polymarketOrderId);
  const [outcomes, reconciliationSnapshots] = await Promise.all([
    intentIds.length > 0
      ? prisma.recommendationExecutionOutcome.findMany({
          where: { orderIntentId: { in: intentIds } },
          select: { orderIntentId: true, matchedSuggestedSide: true, matchedSuggestedSize: true, matchedSuggestedPrice: true },
        })
      : [],
    polymarketOrderIds.length > 0
      ? prisma.orderReconciliationSnapshot.findMany({
          where: { funderAddress: funder, polymarketOrderId: { in: polymarketOrderIds } },
        })
      : [],
  ]);
  const outcomesByIntent = new Map<string, { matchedSuggestedSide: boolean | null; matchedSuggestedSize: boolean | null; matchedSuggestedPrice: boolean | null }>();
  for (const o of outcomes) {
    if (o.orderIntentId) outcomesByIntent.set(o.orderIntentId, { matchedSuggestedSide: o.matchedSuggestedSide, matchedSuggestedSize: o.matchedSuggestedSize, matchedSuggestedPrice: o.matchedSuggestedPrice });
  }
  const reconciliationByPmOrderId = new Map<string, (typeof reconciliationSnapshots)[0]>();
  for (const r of reconciliationSnapshots) {
    reconciliationByPmOrderId.set(r.polymarketOrderId, r);
  }

  return NextResponse.json({
    funderAddress: funder,
    orderIntents: intents.map((i) => {
      const outcome = outcomesByIntent.get(i.id);
      const matchedRecommendation = outcome
        ? (outcome.matchedSuggestedSide && outcome.matchedSuggestedSize && outcome.matchedSuggestedPrice)
        : i.recommendationId
          ? null
          : undefined;
      return {
        id: i.id,
        recommendationId: i.recommendationId,
        linkedRecommendation: !!i.recommendationId,
        matchedSuggestedSide: outcome?.matchedSuggestedSide ?? null,
        matchedSuggestedSize: outcome?.matchedSuggestedSize ?? null,
        matchedSuggestedPrice: outcome?.matchedSuggestedPrice ?? null,
        orderMatchedRecommendation: matchedRecommendation ?? undefined,
        marketId: i.marketId,
        assetId: i.assetId,
        outcome: i.outcome,
        side: i.side,
        orderType: i.orderType,
        limitPrice: i.limitPrice,
        size: i.size,
        status: i.status,
        riskPreviewJson: i.riskPreviewJson,
        createdAt: i.createdAt.toISOString(),
        updatedAt: i.updatedAt.toISOString(),
        executedOrders: i.executedOrders.map((e) => ({
          id: e.id,
          polymarketOrderId: e.polymarketOrderId,
          status: e.status,
          createdAt: e.createdAt.toISOString(),
        })),
      };
    }),
    executedOrders: executed.map((e) => {
      const recon = reconciliationByPmOrderId.get(e.polymarketOrderId);
      return {
        id: e.id,
        orderIntentId: e.orderIntentId,
        polymarketOrderId: e.polymarketOrderId,
        marketId: e.marketId,
        assetId: e.assetId,
        side: e.side,
        price: e.price,
        size: e.size,
        status: e.status,
        createdAt: e.createdAt.toISOString(),
        reconciliation: recon
          ? {
              localStatus: recon.localStatus,
              remoteStatus: recon.remoteStatus,
              filledSize: recon.filledSize,
              remainingSize: recon.remainingSize,
              avgFillPrice: recon.avgFillPrice,
              mismatch: recon.mismatch,
            }
          : null,
      };
    }),
    openOrders: openOrders.map((o) => ({
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
