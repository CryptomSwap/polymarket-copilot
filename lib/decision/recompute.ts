/**
 * Decision recompute: rebuild setup performance profiles, then evaluate each recommendation via the
 * staged decision engine (evaluate-staged.ts). Advisory only; hard blocks remain authoritative.
 * The execution ledger and DecisionPolicySnapshot are the durable record; no legacy blend/policy modules are used.
 */

import { prisma } from "@/lib/db";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";
import { buildSetupPerformanceProfiles, getSetupAdjustment } from "./setup-performance";
import { getNewsInfluenceByMarket } from "@/lib/news/recommendation-influence";
import {
  buildPortfolioRiskInputFromDerived,
  calculatePortfolioRisk,
  setPortfolioRiskSnapshot,
} from "@/lib/portfolio-risk";
import { evaluateDecisionStaged } from "./evaluate-staged";
import type { StagedDecisionInput } from "./stages/types";

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
 * Resolve funder for decision recompute and paper-trading tick.
 * Order: (1) override (2) funder that has the most decision snapshots (so tick finds snapshots created by ensure-decision-snapshots) (3) wallet/creds (4) any funder that has recommendations.
 */
export async function getFunderForDecisionRecompute(funderOverride?: string): Promise<string | null> {
  if (funderOverride?.trim()) return funderOverride.trim().toLowerCase();
  const fromSnapshots = await prisma.decisionPolicySnapshot
    .groupBy({
      by: ["funderAddress"],
      _count: { id: true },
    })
    .then((groups) => {
      if (groups.length === 0) return null;
      const top = groups.sort((a, b) => b._count.id - a._count.id)[0];
      return top?.funderAddress?.trim().toLowerCase() ?? null;
    });
  if (fromSnapshots) return fromSnapshots;
  const fromRecompute = await getFunderForRecompute();
  if (fromRecompute) return fromRecompute;
  const rec = await prisma.recommendation.findFirst({
    include: { marketSignal: { select: { funderAddress: true } } },
  });
  return rec?.marketSignal?.funderAddress?.trim().toLowerCase() ?? null;
}

/**
 * Rebuild setup performance profiles, then compute decision snapshots for all current recommendations.
 * Uses getFunderForDecisionRecompute when funderAddress not provided, so snapshots can be generated for paper trading from recommendation-owned funder.
 */
export async function recomputeDecisions(funderAddress?: string): Promise<DecisionRecomputeResult> {
  const errors: string[] = [];
  const resolved = funderAddress?.toLowerCase().trim() || (await getFunderForDecisionRecompute());
  if (!resolved) {
    return {
      funderAddress: "",
      profilesCreated: 0,
      profilesUpdated: 0,
      snapshotsUpserted: 0,
      errors: ["No funder address. Connect wallet and save connection, or ensure recommendations exist for a funder."],
    };
  }

  const { created: profilesCreated, updated: profilesUpdated } = await buildSetupPerformanceProfiles(resolved);

  const positions = await prisma.derivedPosition.findMany({
    where: { funderAddress: resolved },
    include: { syncedMarket: { select: { endDate: true } } },
  });

  const riskInput = buildPortfolioRiskInputFromDerived(resolved, positions, {
    nearResolutionHoursThreshold: 72,
    correlationHeuristics: "theme",
  });
  const portfolioRiskSnapshot = calculatePortfolioRisk(riskInput);
  const totalExposure = portfolioRiskSnapshot.totalOpenExposure;
  const topThemeConcentrationPct = portfolioRiskSnapshot.maxSingleThemeConcentrationPct;
  const themeExposureMap = new Map<string, number>();
  for (const row of portfolioRiskSnapshot.themeConcentrations) {
    themeExposureMap.set(row.theme, row.exposure);
  }

  setPortfolioRiskSnapshot(portfolioRiskSnapshot, resolved);

  const recommendations = await prisma.recommendation.findMany({
    where: { marketSignal: { funderAddress: resolved } },
    include: {
      marketSignal: true,
      review: true,
    },
  });

  const marketIds = Array.from(new Set(recommendations.map((r) => r.marketSignal.marketId)));
  const newsByMarket = await getNewsInfluenceByMarket(marketIds);

  const marketsWithEndDate =
    marketIds.length > 0
      ? await prisma.syncedMarket.findMany({
          where: { OR: [{ id: { in: marketIds } }, { conditionId: { in: marketIds } }] },
          select: { id: true, conditionId: true, endDate: true },
        })
      : [];
  const endDateByMarketId = new Map<string, Date>();
  for (const m of marketsWithEndDate) {
    if (m.endDate) {
      const d = m.endDate instanceof Date ? m.endDate : new Date(m.endDate);
      if (m.id) endDateByMarketId.set(m.id, d);
      if (m.conditionId) endDateByMarketId.set(m.conditionId, d);
    }
  }

  const assets = await prisma.syncedAsset.findMany({
    where: { syncedMarketId: { in: marketIds } },
    select: { syncedMarketId: true, outcome: true, tokenId: true },
  });
  const assetIdByMarketOutcome = new Map<string, string>();
  for (const a of assets) {
    assetIdByMarketOutcome.set(`${a.syncedMarketId}::${a.outcome}`, a.tokenId);
  }
  const heldAssetIds = new Set(positions.map((p) => p.assetId));
  const setupAdjustmentCache = new Map<string, Awaited<ReturnType<typeof getSetupAdjustment>>>();

  let snapshotsUpserted = 0;
  for (const rec of recommendations) {
    try {
      const theme = rec.marketSignal.theme ?? "Other";
      const themeExposure = themeExposureMap.get(theme) ?? 0;
      const themeExposurePct = totalExposure > 0 ? (themeExposure / totalExposure) * 100 : 0;

      const marketEndDate = rec.marketSignal.marketId
        ? endDateByMarketId.get(rec.marketSignal.marketId)
        : null;
      const timeToCloseHours =
        marketEndDate != null
          ? (marketEndDate.getTime() - Date.now()) / (3600 * 1000)
          : null;

      const setupKey = [
        rec.marketSignal.signalType ?? "",
        rec.marketSignal.category ?? "",
        rec.marketSignal.theme ?? "",
        rec.review?.status ?? "NEW",
      ].join("::");
      let setupAdjustment = setupAdjustmentCache.get(setupKey);
      if (!setupAdjustment) {
        setupAdjustment = await getSetupAdjustment({
          signalType: rec.marketSignal.signalType,
          category: rec.marketSignal.category,
          theme: rec.marketSignal.theme,
          reviewStatus: rec.review?.status ?? "NEW",
        });
        setupAdjustmentCache.set(setupKey, setupAdjustment);
      }

      const news = newsByMarket[rec.marketSignal.marketId] ?? {
        catalystBoost: 0,
        saturationPenalty: 0,
        linkedNewsCount: 0,
        linkedNewsCount24h: 0,
      };

      const assetId = assetIdByMarketOutcome.get(
        `${rec.marketSignal.marketId}::${rec.marketSignal.outcome}`
      );
      const hasPosition = assetId ? heldAssetIds.has(assetId) : false;

      const stagedInput: StagedDecisionInput = {
        action: rec.action,
        blockedReason: rec.blockedReason,
        qualityBlocker: rec.qualityBlocker ?? null,
        heuristicPriorityScore: parseNum(rec.priorityScore),
        mlScore: rec.mlScore != null ? parseNum(rec.mlScore) : null,
        newsCatalystBoost: news.catalystBoost,
        newsSaturationPenalty: news.saturationPenalty,
        themeExposurePct,
        topThemeConcentrationPct,
        behaviorPenalty: parseNum(rec.marketSignal.behaviorPenalty),
        portfolioPenalty: parseNum(rec.marketSignal.portfolioPenalty),
        setupActedWinRate: setupAdjustment.actedWinRate,
        setupOverrideWinRate: setupAdjustment.overrideWinRate,
        setupSampleCount: setupAdjustment.sampleCount,
        reviewStatus: rec.review?.status ?? "NEW",
        signalType: rec.marketSignal.signalType,
        suggestedSizeFromRec: parseNum(rec.suggestedSize),
        hasExistingPosition: hasPosition,
        liquidityScore: parseNum(rec.marketSignal.liquidityScore),
        signalTypeLabel: rec.marketSignal.signalType,
      };

      const stagedResult = evaluateDecisionStaged(stagedInput);

      const inputSummary = {
        marketState: { marketId: rec.marketSignal.marketId },
        liquidityScore: parseNum(rec.marketSignal.liquidityScore),
        momentumScore: parseNum(rec.marketSignal.momentumScore),
        themeExposurePct,
        topThemeConcentrationPct,
        portfolioState: "derived",
        timeToCloseHours,
      };

      const reasoningJson = JSON.stringify({
        blockers: stagedResult.reasoningBreakdown.blockers,
        supportive: stagedResult.reasoningBreakdown.supportive,
        edgeReasons: stagedResult.reasoningBreakdown.edgeReasons,
        marketQualityReasons: stagedResult.reasoningBreakdown.marketQualityReasons,
        portfolioFitReasons: stagedResult.reasoningBreakdown.portfolioFitReasons,
        sizingReasons: stagedResult.reasoningBreakdown.sizingReasons,
        explanation: stagedResult.explanation,
        policyState: stagedResult.policyState,
        sizeMultiplier: stagedResult.sizeMultiplier,
        blockReason: stagedResult.blockReason,
        blendedScore: stagedResult.blendedScore,
        inputSummary,
      });

      await prisma.decisionPolicySnapshot.upsert({
        where: {
          recommendationId_funderAddress: { recommendationId: rec.id, funderAddress: resolved },
        },
        create: {
          recommendationId: rec.id,
          funderAddress: resolved,
          policyState: stagedResult.policyState,
          blendedScore: String(stagedResult.blendedScore),
          sizeMultiplier: String(stagedResult.sizeMultiplier),
          finalSuggestedSize: String(stagedResult.finalSuggestedSize),
          reasoningJson,
        },
        update: {
          policyState: stagedResult.policyState,
          blendedScore: String(stagedResult.blendedScore),
          sizeMultiplier: String(stagedResult.sizeMultiplier),
          finalSuggestedSize: String(stagedResult.finalSuggestedSize),
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
