/**
 * Recommendations recompute: optionally capture snapshots, then rebuild MarketSignal and Recommendation.
 * v2: uses portfolio intelligence for context; persists primaryActionType and explanation fields.
 * Read-only; no trade execution.
 */

import { prisma } from "@/lib/db";
import { captureMarketSnapshots } from "./market-snapshots";
import { generateSignals } from "./signals";
import { signalToRecommendationV2, type RecommendationContextV2 } from "./recommendations";
import { getFunderForRecompute } from "./recompute";
import { getNewsInfluenceByMarket } from "@/lib/news/recommendation-influence";
import { getPortfolioIntelligence } from "@/lib/portfolio/intelligence";

export interface RecommendationsRecomputeResult {
  funderAddress: string;
  snapshotsCaptured?: number;
  signalsWritten: number;
  recommendationsWritten: number;
  errors: string[];
}

/**
 * Full recompute. If captureSnapshotsFirst, captures market snapshots then regenerates signals/recommendations.
 */
export async function recomputeRecommendations(
  funderAddress?: string,
  opts?: { captureSnapshotsFirst?: boolean }
): Promise<RecommendationsRecomputeResult> {
  const errors: string[] = [];
  const resolved = funderAddress?.toLowerCase() ?? (await getFunderForRecompute());
  if (!resolved) {
    return {
      funderAddress: "",
      signalsWritten: 0,
      recommendationsWritten: 0,
      errors: ["No funder address. Connect wallet and save connection."],
    };
  }

  let snapshotsCaptured: number | undefined;
  if (opts?.captureSnapshotsFirst) {
    const snap = await captureMarketSnapshots();
    snapshotsCaptured = snap.captured;
    errors.push(...snap.errors);
  }

  let signalRows;
  try {
    signalRows = await generateSignals(resolved);
  } catch (e) {
    return {
      funderAddress: resolved,
      snapshotsCaptured,
      signalsWritten: 0,
      recommendationsWritten: 0,
      errors: [e instanceof Error ? e.message : "generateSignals failed"],
    };
  }

  const snapshot = await prisma.portfolioSnapshot.findFirst({
    where: { funderAddress: resolved },
    orderBy: { createdAt: "desc" },
  });
  const totalExposure = snapshot ? parseFloat(snapshot.totalOpenExposure || "0") : 0;
  const topThemeConcentrationPct = snapshot ? parseFloat(snapshot.topThemeConcentrationPct || "0") : 0;

  const themeExposureMap = new Map<string, number>();
  const positions = await prisma.derivedPosition.findMany({
    where: { funderAddress: resolved },
  });
  const heldMarketIds = new Set<string>();
  for (const p of positions) {
    const theme = p.theme ?? "Other";
    themeExposureMap.set(
      theme,
      (themeExposureMap.get(theme) ?? 0) + parseFloat(p.marketValue || "0")
    );
    if (p.syncedMarketId) heldMarketIds.add(p.syncedMarketId);
  }

  let intelligence: Awaited<ReturnType<typeof getPortfolioIntelligence>> | null = null;
  try {
    intelligence = await getPortfolioIntelligence({ funderAddress: resolved });
  } catch (e) {
    errors.push(e instanceof Error ? e.message : "getPortfolioIntelligence failed");
  }

  const categoryExposurePct: Record<string, number> = {};
  const themeExposurePct: Record<string, number> = {};
  if (intelligence) {
    for (const b of intelligence.buckets.byCategory) {
      categoryExposurePct[b.key] = b.pct;
    }
    for (const b of intelligence.buckets.byTheme) {
      themeExposurePct[b.key] = b.pct;
    }
  }

  const marketIds = Array.from(new Set(signalRows.map((r) => r.marketId)));
  const [newsInfluenceByMarket, marketsWithEndDate] = await Promise.all([
    getNewsInfluenceByMarket(marketIds),
    prisma.syncedMarket.findMany({
      where: { id: { in: marketIds } },
      select: { id: true, endDate: true },
    }),
  ]);
  const timeToResolutionDaysByMarket = new Map<string, number>();
  const now = Date.now();
  for (const m of marketsWithEndDate) {
    if (m.endDate) {
      const days = (m.endDate.getTime() - now) / (24 * 60 * 60 * 1000);
      timeToResolutionDaysByMarket.set(m.id, Math.max(0, Math.round(days)));
    }
  }

  await prisma.recommendation.deleteMany({
    where: { marketSignal: { funderAddress: resolved } },
  });
  await prisma.marketSignal.deleteMany({
    where: { funderAddress: resolved },
  });

  let signalsWritten = 0;
  let recommendationsWritten = 0;

  for (const row of signalRows) {
    try {
      const signal = await prisma.marketSignal.create({
        data: {
          funderAddress: resolved,
          slug: row.slug,
          conditionId: row.conditionId,
          marketId: row.marketId,
          marketTitle: row.marketTitle,
          outcome: row.outcome,
          side: row.side,
          marketPrice: row.marketPrice,
          fairPrice: row.fairPrice,
          edge: row.edge,
          confidence: row.confidence,
          momentumScore: row.momentumScore,
          liquidityScore: row.liquidityScore,
          crowdingScore: row.crowdingScore,
          portfolioPenalty: row.portfolioPenalty,
          behaviorPenalty: row.behaviorPenalty,
          momentumComponent: row.momentumComponent,
          liquidityComponent: row.liquidityComponent,
          crowdingComponent: row.crowdingComponent,
          portfolioComponent: row.portfolioComponent,
          behaviorComponent: row.behaviorComponent,
          longshotComponent: row.longshotComponent,
          timeComponent: row.timeComponent,
          eventImpactBoost: row.eventImpactBoost,
          narrativeMomentumBoost: row.narrativeMomentumBoost,
          catalystConfidence: row.catalystConfidence,
          category: row.category,
          theme: row.theme,
          signalType: row.signalType,
          thesis: row.thesis,
          invalidation: row.invalidation,
        },
      });
      signalsWritten++;

      const asset = await prisma.syncedAsset.findFirst({
        where: { syncedMarketId: row.marketId, outcome: row.outcome },
      });
      const assetId = asset?.tokenId ?? null;
      let hasPositionInAsset = false;
      let positionMarketValue = 0;
      if (assetId) {
        const pos = await prisma.derivedPosition.findUnique({
          where: { funderAddress_assetId: { funderAddress: resolved, assetId } },
        });
        if (pos) {
          hasPositionInAsset = true;
          positionMarketValue = parseFloat(pos.marketValue || "0");
        }
      }
      const themeExposure = themeExposureMap.get(row.theme) ?? 0;
      const themeExposurePct = totalExposure > 0 ? (themeExposure / totalExposure) * 100 : 0;

      const newsInfluence = newsInfluenceByMarket[row.marketId];
      const contextV2: RecommendationContextV2 = {
        hasPositionInAsset,
        positionMarketValue,
        themeExposurePct,
        topThemeConcentrationPct,
        newsCatalystBoost: newsInfluence?.catalystBoost,
        newsSaturationPenalty: newsInfluence?.saturationPenalty,
        heldMarketIds,
        categoryExposurePct,
        themeExposurePctByTheme: themeExposurePct,
        nearResolutionCount: intelligence?.summary.nearResolutionPositions ?? 0,
        staleCount: intelligence?.summary.stalePositions ?? 0,
        unresolvedCount: intelligence?.summary.unresolvedPositions ?? 0,
        timeToResolutionDays: timeToResolutionDaysByMarket.get(row.marketId) ?? null,
      };

      const rec = signalToRecommendationV2(row, contextV2);
      rec.marketSignalId = signal.id;

      await prisma.recommendation.create({
        data: {
          marketSignalId: signal.id,
          action: rec.action,
          suggestedEntryMin: rec.suggestedEntryMin,
          suggestedEntryMax: rec.suggestedEntryMax,
          suggestedSize: rec.suggestedSize,
          blockedReason: rec.blockedReason,
          priorityScore: rec.priorityScore,
          primaryActionType: rec.primaryActionType,
          rationale: rec.rationale,
          portfolioImpact: rec.portfolioImpact,
          riskNote: rec.riskNote,
          timingNote: rec.timingNote,
          qualityBlocker: rec.qualityBlocker,
        },
      });
      recommendationsWritten++;
    } catch (e) {
      errors.push(e instanceof Error ? e.message : "Signal/Recommendation create failed");
    }
  }

  return {
    funderAddress: resolved,
    snapshotsCaptured,
    signalsWritten,
    recommendationsWritten,
    errors,
  };
}
