/**
 * Decision recompute: rebuild setup performance profiles, then blend + policy for each recommendation.
 * Advisory only; hard blocks remain authoritative.
 */

import { prisma } from "@/lib/db";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";
import { buildSetupPerformanceProfiles, getSetupAdjustment } from "./setup-performance";
import { getNewsInfluenceByMarket } from "@/lib/news/recommendation-influence";
import { computeBlendedScore } from "./blend";
import { applyPolicy } from "./policy";

function parseNum(s: string | null | undefined): number {
  if (s == null || s === "") return 0;
  const n = parseFloat(String(s).trim());
  return Number.isFinite(n) ? n : 0;
}

export interface DecisionRecomputeResult {
  funderAddress: string;
  profilesCreated: number;
  profilesUpdated: number;
  snapshotsUpserted: number;
  errors: string[];
}

/**
 * Rebuild setup performance profiles, then compute decision snapshots for all current recommendations.
 */
export async function recomputeDecisions(funderAddress?: string): Promise<DecisionRecomputeResult> {
  const errors: string[] = [];
  const resolved = funderAddress?.toLowerCase() ?? (await getFunderForRecompute());
  if (!resolved) {
    return {
      funderAddress: "",
      profilesCreated: 0,
      profilesUpdated: 0,
      snapshotsUpserted: 0,
      errors: ["No funder address. Connect wallet and save connection."],
    };
  }

  const { created: profilesCreated, updated: profilesUpdated } = await buildSetupPerformanceProfiles(resolved);

  const snapshot = await prisma.portfolioSnapshot.findFirst({
    where: { funderAddress: resolved },
    orderBy: { createdAt: "desc" },
  });
  const totalExposure = snapshot ? parseNum(snapshot.totalOpenExposure) : 0;
  const topConcentrationPct = snapshot ? parseNum(snapshot.topConcentrationPct) : 0;
  const themeExposureMap = new Map<string, number>();
  const positions = await prisma.derivedPosition.findMany({
    where: { funderAddress: resolved },
  });
  for (const p of positions) {
    const theme = p.theme ?? "Other";
    themeExposureMap.set(theme, (themeExposureMap.get(theme) ?? 0) + parseNum(p.marketValue));
  }

  const recommendations = await prisma.recommendation.findMany({
    where: { marketSignal: { funderAddress: resolved } },
    include: {
      marketSignal: true,
      review: true,
    },
  });

  const marketIds = Array.from(new Set(recommendations.map((r) => r.marketSignal.marketId)));
  const newsByMarket = await getNewsInfluenceByMarket(marketIds);

  let snapshotsUpserted = 0;
  for (const rec of recommendations) {
    try {
      const theme = rec.marketSignal.theme ?? "Other";
      const themeExposure = themeExposureMap.get(theme) ?? 0;
      const themeExposurePct = totalExposure > 0 ? (themeExposure / totalExposure) * 100 : 0;

      const setupAdjustment = await getSetupAdjustment({
        signalType: rec.marketSignal.signalType,
        category: rec.marketSignal.category,
        theme: rec.marketSignal.theme,
        reviewStatus: rec.review?.status ?? "NEW",
      });

      const news = newsByMarket[rec.marketSignal.marketId] ?? {
        catalystBoost: 0,
        saturationPenalty: 0,
        linkedNewsCount: 0,
        linkedNewsCount24h: 0,
      };

      const { blendedScore, reasoning } = computeBlendedScore({
        heuristicPriorityScore: rec.priorityScore,
        mlScore: rec.mlScore,
        newsCatalystBoost: news.catalystBoost,
        newsSaturationPenalty: news.saturationPenalty,
        themeExposurePct,
        topConcentrationPct,
        behaviorPenalty: parseNum(rec.marketSignal.behaviorPenalty),
        portfolioPenalty: parseNum(rec.marketSignal.portfolioPenalty),
        setupAdjustment,
        reviewStatus: rec.review?.status ?? "NEW",
        blockedReason: rec.blockedReason,
        action: rec.action,
      });

      const asset = await prisma.syncedAsset.findFirst({
        where: {
          syncedMarketId: rec.marketSignal.marketId,
          outcome: rec.marketSignal.outcome,
        },
      });
      const hasPosition = asset
        ? await prisma.derivedPosition
            .findUnique({
              where: {
                funderAddress_assetId: { funderAddress: resolved, assetId: asset.tokenId },
              },
            })
            .then((p) => !!p)
        : false;

      const policyResult = applyPolicy({
        action: rec.action,
        blockedReason: rec.blockedReason,
        blendedScore,
        reasoning,
        themeExposurePct,
        topConcentrationPct,
        hasExistingPosition: hasPosition,
        suggestedSizeFromRec: parseNum(rec.suggestedSize),
        reviewStatus: rec.review?.status ?? "NEW",
        signalType: rec.marketSignal.signalType,
      });

      const reasoningJson = JSON.stringify({
        ...reasoning,
        policyState: policyResult.policyState,
        sizeMultiplier: policyResult.sizeMultiplier,
        blockReason: policyResult.blockReason,
      });

      await prisma.decisionPolicySnapshot.upsert({
        where: {
          recommendationId_funderAddress: { recommendationId: rec.id, funderAddress: resolved },
        },
        create: {
          recommendationId: rec.id,
          funderAddress: resolved,
          policyState: policyResult.policyState,
          blendedScore: String(blendedScore),
          sizeMultiplier: String(policyResult.sizeMultiplier),
          finalSuggestedSize: String(policyResult.finalSuggestedSize),
          reasoningJson,
        },
        update: {
          policyState: policyResult.policyState,
          blendedScore: String(blendedScore),
          sizeMultiplier: String(policyResult.sizeMultiplier),
          finalSuggestedSize: String(policyResult.finalSuggestedSize),
          reasoningJson,
        },
      });
      snapshotsUpserted++;
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  return {
    funderAddress: resolved,
    profilesCreated,
    profilesUpdated,
    snapshotsUpserted,
    errors,
  };
}
