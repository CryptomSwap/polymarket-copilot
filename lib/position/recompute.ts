/**
 * Recompute position exit decisions for all derived positions.
 * Builds context (concentration, recommendation policy, behavior, setup, news) and upserts PositionDecisionSnapshot.
 * No autonomous exits; advisory only.
 */

import { prisma } from "@/lib/db";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";
import { computePositionDecision, type PositionContext } from "./decision";
import { getSetupAdjustment } from "@/lib/decision/setup-performance";

function parseNum(s: string | null | undefined): number {
  if (s == null || s === "") return 0;
  const n = parseFloat(String(s).trim());
  return Number.isFinite(n) ? n : 0;
}

export interface PositionRecomputeResult {
  funderAddress: string;
  snapshotsUpserted: number;
  errors: string[];
}

/**
 * Recompute position decisions for the given funder (or current funder).
 */
export async function recomputePositionDecisions(funderAddress?: string): Promise<PositionRecomputeResult> {
  const errors: string[] = [];
  const resolved = funderAddress?.toLowerCase() ?? (await getFunderForRecompute());
  if (!resolved) {
    return {
      funderAddress: "",
      snapshotsUpserted: 0,
      errors: ["No funder address. Connect wallet and save connection."],
    };
  }

  const positions = await prisma.derivedPosition.findMany({
    where: { funderAddress: resolved },
  });
  if (positions.length === 0) {
    return { funderAddress: resolved, snapshotsUpserted: 0, errors: [] };
  }

  const snapshot = await prisma.portfolioSnapshot.findFirst({
    where: { funderAddress: resolved },
    orderBy: { createdAt: "desc" },
  });
  const totalExposure = snapshot ? parseNum(snapshot.totalOpenExposure) : 0;
  const themeExposureMap = new Map<string, number>();
  for (const p of positions) {
    const theme = p.theme ?? "Other";
    themeExposureMap.set(theme, (themeExposureMap.get(theme) ?? 0) + parseNum(p.marketValue));
  }

  const marketIds = Array.from(new Set(positions.map((p) => p.marketId)));
  const [behaviorFlags, newsLinksByMarket, decisionsByRecId] = await Promise.all([
    prisma.behaviorFlag.findMany({ where: { funderAddress: resolved } }),
    prisma.marketNewsLink.groupBy({
      by: ["marketId"],
      where: { marketId: { in: marketIds } },
      _count: { id: true },
    }),
    prisma.decisionPolicySnapshot.findMany({
      where: { funderAddress: resolved },
      include: { recommendation: { include: { marketSignal: true } } },
    }),
  ]);

  const newsCountByMarket = new Map<string, number>();
  for (const g of newsLinksByMarket) {
    newsCountByMarket.set(g.marketId, g._count.id);
  }
  const policyByMarketOutcome = new Map<string, string>();
  for (const d of decisionsByRecId) {
    const mid = d.recommendation?.marketSignal?.marketId;
    const outcome = d.recommendation?.marketSignal?.outcome;
    if (mid && outcome) policyByMarketOutcome.set(`${mid}:${outcome}`, d.policyState);
  }

  const markets = await prisma.syncedMarket.findMany({
    where: { id: { in: marketIds } },
  });
  const marketById = new Map(markets.map((m) => [m.id, m]));

  let snapshotsUpserted = 0;
  for (const pos of positions) {
    try {
      const theme = pos.theme ?? "Other";
      const themeExposure = themeExposureMap.get(theme) ?? 0;
      const concentrationPct = totalExposure > 0 ? (themeExposure / totalExposure) * 100 : 0;

      const market = marketById.get(pos.marketId);
      let daysToResolution: number | null = null;
      if (market?.endDate) {
        const end = new Date(market.endDate).getTime();
        const now = Date.now();
        daysToResolution = Math.max(0, (end - now) / (24 * 60 * 60 * 1000));
      }

      const recommendationPolicyState = policyByMarketOutcome.get(`${pos.marketId}:${pos.outcome}`) ?? null;
      const hasBehaviorFlag = behaviorFlags.some(
        (f) => f.marketTitle?.toLowerCase().includes(pos.marketTitle?.toLowerCase() ?? "") || f.description?.toLowerCase().includes(pos.theme?.toLowerCase() ?? "")
      );
      const linkedNewsCount = newsCountByMarket.get(pos.marketId) ?? 0;

      const setupAdjustment = await getSetupAdjustment({
        signalType: null,
        category: pos.category,
        theme: pos.theme,
        reviewStatus: null,
      });
      const setupActedWinRate = setupAdjustment?.actedWinRate ?? null;

      const costBasis = Math.abs(parseNum(pos.size) * parseNum(pos.avgEntry));
      const unrealizedPnlFraction = costBasis > 0 ? parseNum(pos.unrealizedPnl) / costBasis : 0;

      const ctx: PositionContext = {
        funderAddress: pos.funderAddress,
        assetId: pos.assetId,
        marketId: pos.marketId,
        size: pos.size,
        avgEntry: pos.avgEntry,
        lastPrice: pos.lastPrice,
        unrealizedPnl: pos.unrealizedPnl,
        marketValue: pos.marketValue,
        category: pos.category,
        theme: pos.theme,
        concentrationPct,
        daysToResolution,
        recommendationPolicyState,
        hasBehaviorFlag,
        setupActedWinRate,
        linkedNewsCount,
        unrealizedPnlFraction,
      };

      const result = computePositionDecision(ctx);

      await prisma.positionDecisionSnapshot.upsert({
        where: {
          funderAddress_assetId: { funderAddress: resolved, assetId: pos.assetId },
        },
        create: {
          funderAddress: resolved,
          assetId: pos.assetId,
          decisionState: result.decisionState,
          confidence: String(result.confidence),
          suggestedExitSize: result.suggestedExitSize,
          reasoningJson: JSON.stringify(result.reasoning),
        },
        update: {
          decisionState: result.decisionState,
          confidence: String(result.confidence),
          suggestedExitSize: result.suggestedExitSize,
          reasoningJson: JSON.stringify(result.reasoning),
        },
      });
      snapshotsUpserted++;
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  return {
    funderAddress: resolved,
    snapshotsUpserted,
    errors,
  };
}
