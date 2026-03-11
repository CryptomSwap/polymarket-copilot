/**
 * Tracked asset set for the market WebSocket: held positions, open orders,
 * and recommendation/bot candidate markets. Used to subscribe to market
 * price/orderbook updates and to refresh subscriptions when holdings or
 * watchlists change.
 */

import { prisma } from "@/lib/db";

const MAX_TRACKED_ASSETS = 300;

/**
 * Returns the set of asset IDs (Polymarket token IDs) the platform cares about:
 * - Held positions (DerivedPosition.assetId)
 * - Open orders (UserOrder.assetId)
 * - Markets that have recommendations (MarketSignal.marketId -> SyncedAsset.tokenId)
 * Capped at MAX_TRACKED_ASSETS to avoid overload.
 */
export async function getTrackedAssetIds(opts?: {
  funderAddress?: string | null;
  limit?: number;
}): Promise<string[]> {
  const limit = opts?.limit ?? MAX_TRACKED_ASSETS;
  const funder = opts?.funderAddress?.toLowerCase();

  const assetIdSet = new Set<string>();

  // 1. Held positions
  const positionWhere = funder ? { funderAddress: funder } : {};
  const positions = await prisma.derivedPosition.findMany({
    where: positionWhere,
    select: { assetId: true },
    take: 500,
  });
  for (const p of positions) assetIdSet.add(p.assetId);

  // 2. Open orders (any funder if no funder filter; otherwise that funder)
  const orderWhere = funder ? { funderAddress: funder } : {};
  const orders = await prisma.userOrder.findMany({
    where: orderWhere,
    select: { assetId: true },
    take: 500,
  });
  for (const o of orders) assetIdSet.add(o.assetId);

  // 3. Recommendation / bot candidate markets: get marketIds from MarketSignal, then asset tokenIds
  const marketSignals = await prisma.marketSignal.findMany({
    where: funder ? { funderAddress: funder } : {},
    select: { marketId: true },
    distinct: ["marketId"],
    take: 200,
  });
  const marketIds = [...new Set(marketSignals.map((m) => m.marketId))];
  if (marketIds.length > 0) {
    const assets = await prisma.syncedAsset.findMany({
      where: { syncedMarketId: { in: marketIds } },
      select: { tokenId: true },
    });
    for (const a of assets) assetIdSet.add(a.tokenId);
  }

  const out = Array.from(assetIdSet);
  return out.length > limit ? out.slice(0, limit) : out;
}
