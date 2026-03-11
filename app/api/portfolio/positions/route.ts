import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";
import {
  buildCanonicalPositionView,
} from "@/lib/portfolio/canonical-position-view";
import { toPositionViewFromCanonical } from "@/lib/portfolio/position-display";
import { enrichPositionsBatch } from "@/lib/portfolio/enrich-positions";

export const dynamic = "force-dynamic";

/**
 * GET /api/portfolio/positions
 * Returns derived positions for the connected funder with position decision snapshot and market enrichment.
 * Query: ?canonical=true returns positions as canonical view objects (market, token, economics, timing, quality).
 *
 * Position contract (explicit, no overloaded fields):
 * - syncedMarketId: canonical internal SyncedMarket.id, null if unresolved
 * - rawMarketRef: raw upstream market reference (CLOB/condition id from fills), null if unknown
 * - assetId, marketSlug, marketTitle, category, theme: metadata (slug/category/theme null when unresolved)
 * - resolutionSource: "marketId" | "conditionId" | "assetId" | "unresolved"
 * - quality: { matchedBy, hasFullMarketMetadata, warnings } (legacy mode); full quality in canonical
 * - marketId: backward-compat alias only (syncedMarketId ?? rawMarketRef); prefer syncedMarketId/rawMarketRef
 *
 * Diagnostics (stable):
 * - totalPositions, resolvedPositions, unresolvedPositions
 * - matchedByMarketId, matchedByConditionId, matchedByAssetId
 * - total/resolved/unresolved/resolvedBy* kept for backward compatibility
 */
export async function GET(request: Request) {
  const funder = await getFunderForRecompute();
  if (!funder) {
    return NextResponse.json(
      { error: "No funder address. Connect wallet and save connection." },
      { status: 400 }
    );
  }

  const url = request.url ? new URL(request.url) : null;
  const canonical = url?.searchParams.get("canonical") === "true";

  const positions = await prisma.derivedPosition.findMany({
    where: { funderAddress: funder },
    include: {
      decisionSnapshots: true,
      positionThesis: true,
    },
  });
  positions.sort((a, b) => parseFloat(b.marketValue) - parseFloat(a.marketValue));
  const decisionByAsset = new Map<string, (typeof positions)[0]["decisionSnapshots"][0]>();
  for (const p of positions) {
    const d = p.decisionSnapshots[0];
    if (d) decisionByAsset.set(p.assetId, d);
  }

  const { enriched, diagnostics } = await enrichPositionsBatch(
    positions.map((p) => ({
      marketId: p.marketId,
      assetId: p.assetId,
      marketTitle: p.marketTitle,
      category: p.category,
      theme: p.theme,
    }))
  );

    const resolvedCount = diagnostics.matchedByMarketId + diagnostics.matchedByConditionId + diagnostics.matchedByAssetId;
  const missingDecisionCount = positions.filter((p) => !decisionByAsset.has(p.assetId)).length;

  let resolvedNotionalPct: number | null = null;
  let unresolvedNotionalPct: number | null = null;
  let resolvedNotional = 0;
  let unresolvedNotional = 0;
  for (let i = 0; i < positions.length; i++) {
    const mv = parseFloat(positions[i].marketValue);
    if (Number.isFinite(mv)) {
      if (enriched[i].matchedBy != null) resolvedNotional += mv;
      else unresolvedNotional += mv;
    }
  }
  const totalNotional = resolvedNotional + unresolvedNotional;
  if (totalNotional > 0) {
    resolvedNotionalPct = (resolvedNotional / totalNotional) * 100;
    unresolvedNotionalPct = (unresolvedNotional / totalNotional) * 100;
  }

  if (canonical) {
    const resolvedMarketIds = Array.from(new Set(enriched.map((e) => e.marketId).filter(Boolean)));
    const newsCountByMarket = new Map<string, number>();
    if (resolvedMarketIds.length > 0) {
      const links = await prisma.marketNewsLink.groupBy({
        by: ["marketId"],
        where: { marketId: { in: resolvedMarketIds } },
        _count: { id: true },
      });
      links.forEach((r) => newsCountByMarket.set(r.marketId, r._count.id));
    }

    const canonicalPositions = positions.map((p, i) => {
      const meta = enriched[i];
      const decision = decisionByAsset.get(p.assetId) ?? p.decisionSnapshots[0];
      const view = buildCanonicalPositionView(
        {
          funderAddress: p.funderAddress,
          marketId: p.marketId,
          assetId: p.assetId,
          marketTitle: p.marketTitle,
          outcome: p.outcome,
          side: p.side,
          size: p.size,
          avgEntry: p.avgEntry,
          lastPrice: p.lastPrice,
          costBasis: p.costBasis,
          marketValue: p.marketValue,
          unrealizedPnl: p.unrealizedPnl,
          realizedPnl: p.realizedPnl,
          reservedOrderSize: p.reservedOrderSize,
          reservedOrderValue: p.reservedOrderValue,
          category: p.category,
          theme: p.theme,
          openedAt: p.openedAt,
        },
        meta,
        { firstFillAt: p.openedAt }
      );
      const marketIdForNews = view.market.id ?? p.marketId;
      const newsLinkCount = marketIdForNews ? newsCountByMarket.get(marketIdForNews) ?? 0 : 0;

      const thesis = p.positionThesis;
      const canonicalItem = {
        ...view,
        syncedMarketId: view.market.id,
        rawMarketRef: p.marketId,
        resolutionSource: view.quality.matchedBy ?? "unresolved",
      };
      const positionView = toPositionViewFromCanonical({
        ...canonicalItem,
        timing: {
          ...view.timing,
          hoursToResolution: view.timing.hoursToResolution,
          lastSyncedAt: view.timing.lastSyncedAt,
        },
        quality: view.quality,
      });
      return {
        ...canonicalItem,
        positionView,
        decision: decision
          ? {
              decisionState: decision.decisionState,
              confidence: decision.confidence,
              suggestedExitSize: decision.suggestedExitSize,
              reasoningJson: decision.reasoningJson,
            }
          : null,
        newsLinkCount,
        thesis: thesis
          ? {
              id: thesis.id,
              entryThesis: thesis.entryThesis,
              currentThesisStatus: thesis.currentThesisStatus,
              exitReason: thesis.exitReason,
              notes: thesis.notes,
              updatedAt: thesis.updatedAt.toISOString(),
            }
          : null,
      };
    });

    return NextResponse.json({
      funderAddress: funder,
      positions: canonicalPositions,
      diagnostics: {
        totalPositions: positions.length,
        resolvedPositions: resolvedCount,
        unresolvedPositions: diagnostics.unresolved,
        matchedByMarketId: diagnostics.matchedByMarketId,
        matchedByConditionId: diagnostics.matchedByConditionId,
        matchedByAssetId: diagnostics.matchedByAssetId,
        missingDecisionCount,
        resolvedNotionalPct,
        unresolvedNotionalPct,
        total: positions.length,
        resolved: resolvedCount,
        unresolved: diagnostics.unresolved,
        resolvedByMarketId: diagnostics.matchedByMarketId,
        resolvedByConditionId: diagnostics.matchedByConditionId,
        resolvedByAssetId: diagnostics.matchedByAssetId,
      },
    });
  }

  const positionList = positions.map((p, i) => {
    const decision = decisionByAsset.get(p.assetId) ?? p.decisionSnapshots[0];
    const meta = enriched[i];
    const syncedMarketId = meta?.matchedBy != null ? meta.marketId : null;
    const rawMarketRef = p.marketId?.trim() || null;
    const resolutionSource = meta?.matchedBy ?? "unresolved";
    const hasFullMarketMetadata = meta?.matchedBy != null;

    return {
      id: `${p.funderAddress}-${p.assetId}`,
      syncedMarketId,
      rawMarketRef,
      assetId: p.assetId,
      marketSlug: meta?.marketSlug ?? null,
      marketTitle: meta?.marketTitle ?? p.marketTitle ?? null,
      category: meta?.category ?? p.category ?? null,
      theme: meta?.theme ?? p.theme ?? null,
      resolutionSource,
      quality: {
        matchedBy: meta?.matchedBy ?? null,
        hasFullMarketMetadata,
        warnings: hasFullMarketMetadata ? [] : ["Market not resolved in catalog"],
      },
      outcome: p.outcome,
      side: p.side,
      size: p.size,
      avgEntry: p.avgEntry,
      lastPrice: p.lastPrice,
      costBasis: p.costBasis,
      marketValue: p.marketValue,
      unrealizedPnl: p.unrealizedPnl,
      realizedPnl: p.realizedPnl,
      reservedOrderSize: p.reservedOrderSize,
      reservedOrderValue: p.reservedOrderValue,
      endDate: meta?.endDate ?? null,
      openedAt: p.openedAt?.toISOString() ?? null,
      decision: decision
        ? {
            decisionState: decision.decisionState,
            confidence: decision.confidence,
            suggestedExitSize: decision.suggestedExitSize,
            reasoningJson: decision.reasoningJson,
          }
        : null,
      marketId: syncedMarketId ?? rawMarketRef ?? null,
    };
  });

  return NextResponse.json({
    funderAddress: funder,
    positions: positionList,
    diagnostics: {
      totalPositions: positions.length,
      resolvedPositions: resolvedCount,
      unresolvedPositions: diagnostics.unresolved,
      matchedByMarketId: diagnostics.matchedByMarketId,
      matchedByConditionId: diagnostics.matchedByConditionId,
      matchedByAssetId: diagnostics.matchedByAssetId,
      missingDecisionCount,
      resolvedNotionalPct,
      unresolvedNotionalPct,
      total: positions.length,
      resolved: resolvedCount,
      unresolved: diagnostics.unresolved,
      resolvedByMarketId: diagnostics.matchedByMarketId,
      resolvedByConditionId: diagnostics.matchedByConditionId,
      resolvedByAssetId: diagnostics.matchedByAssetId,
    },
  });
}
