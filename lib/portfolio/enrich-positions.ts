/**
 * Batch enrichment of derived positions to SyncedMarket metadata.
 * Shared by positions API and portfolio intelligence. Returns enrichment for canonical view.
 */

import { prisma } from "@/lib/db";
import { deriveTheme, type MarketCategory } from "@/lib/polymarket/classify";
import { normalizeConditionId } from "@/lib/polymarket/portfolio";
import type { PositionEnrichmentInput } from "@/lib/portfolio/canonical-position-view";

const MARKET_SELECT = {
  id: true,
  title: true,
  slug: true,
  category: true,
  endDate: true,
  conditionId: true,
  status: true,
} as const;

export interface EnrichPositionsBatchInput {
  marketId: string;
  assetId: string;
  marketTitle: string | null;
  category: string | null;
  theme: string | null;
}

export interface EnrichPositionsBatchResult {
  enriched: PositionEnrichmentInput[];
  diagnostics: {
    matchedByMarketId: number;
    matchedByConditionId: number;
    matchedByAssetId: number;
    unresolved: number;
  };
}

/**
 * Batch-resolve positions to SyncedMarket for enrichment. Returns market metadata keyed by position.
 */
export async function enrichPositionsBatch(
  positions: EnrichPositionsBatchInput[]
): Promise<EnrichPositionsBatchResult> {
  const marketIds = Array.from(new Set(positions.map((p) => p.marketId.trim()).filter(Boolean)));
  const assetIds = Array.from(new Set(positions.map((p) => p.assetId.trim()).filter(Boolean)));
  const diagnostics = { matchedByMarketId: 0, matchedByConditionId: 0, matchedByAssetId: 0, unresolved: 0 };

  const byId =
    marketIds.length > 0
      ? await prisma.syncedMarket.findMany({
          where: { id: { in: marketIds } },
          select: MARKET_SELECT,
        })
      : [];
  const marketById = new Map(byId.map((m) => [m.id, m]));

  const needByCondition = marketIds.filter((id) => !marketById.has(id));
  const conditionIdVariants = new Set<string>();
  for (const id of needByCondition) {
    conditionIdVariants.add(id);
    const n = normalizeConditionId(id);
    if (n) conditionIdVariants.add(n);
  }
  const byCondition =
    conditionIdVariants.size > 0
      ? await prisma.syncedMarket.findMany({
          where: { conditionId: { in: Array.from(conditionIdVariants) } },
          select: { ...MARKET_SELECT, conditionId: true },
        })
      : [];
  const marketByConditionId = new Map<string, (typeof byCondition)[0]>();
  for (const m of byCondition) {
    if (m.conditionId) {
      marketByConditionId.set(m.conditionId, m);
      marketByConditionId.set(normalizeConditionId(m.conditionId), m);
    }
  }

  const normalizeId = (s: string) => String(s ?? "").trim();
  const assetIdsNorm = assetIds.map(normalizeId).filter(Boolean);
  const assets =
    assetIdsNorm.length > 0
      ? await prisma.syncedAsset.findMany({
          where: { tokenId: { in: assetIdsNorm } },
          include: { syncedMarket: { select: MARKET_SELECT } },
        })
      : [];
  const marketByAssetId = new Map(assets.map((a) => [normalizeId(a.tokenId), a.syncedMarket]));

  const result: PositionEnrichmentInput[] = [];

  for (const p of positions) {
    const byIdM = marketById.get(p.marketId);
    if (byIdM) {
      diagnostics.matchedByMarketId++;
      const theme = deriveTheme(byIdM.title, (byIdM.category as MarketCategory) ?? "other");
      result.push({
        marketId: byIdM.id,
        marketTitle: byIdM.title,
        marketSlug: byIdM.slug,
        category: byIdM.category ?? null,
        theme,
        endDate: byIdM.endDate?.toISOString() ?? null,
        matchedBy: "marketId",
        conditionId: byIdM.conditionId ?? null,
        status: byIdM.status ?? null,
      });
      continue;
    }
    const byCondM = marketByConditionId.get(p.marketId) ?? marketByConditionId.get(normalizeConditionId(p.marketId));
    if (byCondM) {
      diagnostics.matchedByConditionId++;
      const theme = deriveTheme(byCondM.title, (byCondM.category as MarketCategory) ?? "other");
      result.push({
        marketId: byCondM.id,
        marketTitle: byCondM.title,
        marketSlug: byCondM.slug,
        category: byCondM.category ?? null,
        theme,
        endDate: byCondM.endDate?.toISOString() ?? null,
        matchedBy: "conditionId",
        conditionId: byCondM.conditionId ?? null,
        status: byCondM.status ?? null,
      });
      continue;
    }
    const byAssetM = marketByAssetId.get(normalizeId(p.assetId));
    if (byAssetM) {
      diagnostics.matchedByAssetId++;
      const theme = deriveTheme(byAssetM.title, (byAssetM.category as MarketCategory) ?? "other");
      result.push({
        marketId: byAssetM.id,
        marketTitle: byAssetM.title,
        marketSlug: byAssetM.slug,
        category: byAssetM.category ?? null,
        theme,
        endDate: byAssetM.endDate?.toISOString() ?? null,
        matchedBy: "assetId",
        conditionId: byAssetM.conditionId ?? null,
        status: byAssetM.status ?? null,
      });
      continue;
    }
    diagnostics.unresolved++;
    result.push({
      marketId: p.marketId,
      marketTitle: p.marketTitle ?? "Unknown market",
      marketSlug: null,
      category: p.category ?? "other",
      theme: p.theme ?? "Unknown market",
      endDate: null,
      matchedBy: null,
    });
  }

  return { enriched: result, diagnostics };
}
