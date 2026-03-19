/**
 * Resolution diagnostics: trace why specific positions (by assetId) failed to resolve
 * to SyncedMarket. Used to find broken joins (missing SyncedAsset, missing SyncedMarket,
 * tokenId/conditionId format mismatch).
 */

import { prisma } from "@/lib/db";
import { normalizeConditionId } from "@/lib/polymarket/portfolio";

export interface PositionResolutionTrace {
  assetId: string;
  /** Raw market ref from fills (often conditionId). */
  marketIdFromFills: string | null;
  /** Sample UserFill row(s) for this assetId. */
  sampleFills: { market: string; assetId: string }[];
  /** SyncedAsset row(s) with tokenId = assetId (exact). */
  syncedAssetByTokenId: { tokenId: string; syncedMarketId: string; marketId?: string }[];
  /** SyncedAsset row(s) with tokenId = normalized (trimmed) assetId. */
  syncedAssetByTokenIdNormalized: { tokenId: string; syncedMarketId: string }[];
  /** SyncedMarket by conditionId = marketIdFromFills. */
  syncedMarketByConditionId: { id: string; conditionId: string | null; slug: string | null }[];
  /** SyncedMarket by conditionId = trimmed marketIdFromFills. */
  syncedMarketByConditionIdNormalized: { id: string; conditionId: string | null; slug: string | null }[];
  /** Derived position row if present. */
  derivedPosition: { marketId: string; syncedMarketId: string | null } | null;
  /** Why resolution failed (concise). */
  failureReason: string;
}

function normalizeId(s: string | null | undefined): string {
  if (s == null) return "";
  return String(s).trim();
}

/**
 * Trace resolution chain for given assetIds and optional funder.
 * If funder is provided, uses UserFill + DerivedPosition for that funder; otherwise only DB lookups by assetId/marketId.
 */
export async function traceResolutionForAssetIds(
  assetIds: string[],
  funderAddress?: string | null
): Promise<PositionResolutionTrace[]> {
  const results: PositionResolutionTrace[] = [];
  const seenNormalized = new Set<string>();
  for (const assetId of assetIds) {
    const norm = normalizeId(assetId);
    if (!norm || seenNormalized.has(norm)) continue;
    seenNormalized.add(norm);

    let marketIdFromFills: string | null = null;
    let sampleFills: { market: string; assetId: string }[] = [];
    let derivedPosition: { marketId: string; syncedMarketId: string | null } | null = null;

    if (funderAddress) {
      const fillsByNorm = await prisma.userFill.findMany({
        where: { funderAddress: funderAddress.toLowerCase(), assetId: norm },
        select: { market: true, assetId: true },
        take: 5,
      });
      const fillsByRaw =
        norm !== assetId
          ? await prisma.userFill.findMany({
              where: { funderAddress: funderAddress.toLowerCase(), assetId },
              select: { market: true, assetId: true },
              take: 5,
            })
          : [];
      const fills = fillsByNorm.length > 0 ? fillsByNorm : fillsByRaw;
      sampleFills = fills.map((f) => ({ market: f.market, assetId: f.assetId }));
      if (fills.length > 0) marketIdFromFills = fills[0].market;

      const posByNorm = await prisma.derivedPosition.findUnique({
        where: { funderAddress_assetId: { funderAddress: funderAddress.toLowerCase(), assetId: norm } },
        select: { marketId: true, syncedMarketId: true },
      }).catch(() => null);
      const posByRaw = norm !== assetId
        ? await prisma.derivedPosition.findUnique({
            where: { funderAddress_assetId: { funderAddress: funderAddress.toLowerCase(), assetId } },
            select: { marketId: true, syncedMarketId: true },
          }).catch(() => null)
        : null;
      const pos = posByNorm ?? posByRaw ?? null;
      if (pos) derivedPosition = { marketId: pos.marketId, syncedMarketId: pos.syncedMarketId };
    }

    const condNorm = marketIdFromFills ? normalizeConditionId(marketIdFromFills) : "";
    const condVariants = [
      ...new Set(
        [marketIdFromFills, normalizeId(marketIdFromFills), condNorm].filter(Boolean)
      ),
    ];
    const [syncedAssetExact, syncedAssetNorm, syncedMarketByCond] = await Promise.all([
      prisma.syncedAsset.findMany({
        where: { tokenId: norm },
        select: { tokenId: true, syncedMarketId: true },
        take: 5,
      }),
      norm !== assetId
        ? prisma.syncedAsset.findMany({
            where: { tokenId: assetId },
            select: { tokenId: true, syncedMarketId: true },
            take: 5,
          })
        : [],
      condVariants.length > 0
        ? prisma.syncedMarket.findMany({
            where: { conditionId: { in: condVariants } },
            select: { id: true, conditionId: true, slug: true },
            take: 5,
          })
        : [],
    ]);

    const syncedAssetByTokenId = syncedAssetExact.map((a) => ({ tokenId: a.tokenId, syncedMarketId: a.syncedMarketId }));
    const syncedAssetByTokenIdNormalized = syncedAssetNorm.map((a) => ({ tokenId: a.tokenId, syncedMarketId: a.syncedMarketId }));
    const syncedMarketByConditionId = syncedMarketByCond.map((m) => ({
      id: m.id,
      conditionId: m.conditionId,
      slug: m.slug,
    }));
    const syncedMarketByConditionIdNormalized: { id: string; conditionId: string | null; slug: string | null }[] = [];

    let failureReason: string;
    if (syncedAssetByTokenId.length > 0 || syncedAssetByTokenIdNormalized.length > 0) {
      failureReason = "SyncedAsset found; check SyncedMarket link or resolver order.";
    } else if (syncedMarketByConditionId.length > 0) {
      failureReason = "SyncedMarket found by conditionId but SyncedAsset by tokenId missing (tokenId format or missing assets for this market).";
    } else if (!marketIdFromFills) {
      failureReason = "No UserFill for this assetId (or funder not provided).";
    } else {
      failureReason = "No SyncedAsset for tokenId and no SyncedMarket for conditionId; market likely not synced or ID format mismatch.";
    }

    results.push({
      assetId: assetId || norm,
      marketIdFromFills,
      sampleFills,
      syncedAssetByTokenId,
      syncedAssetByTokenIdNormalized,
      syncedMarketByConditionId,
      syncedMarketByConditionIdNormalized,
      derivedPosition,
      failureReason,
    });
  }

  return results;
}
