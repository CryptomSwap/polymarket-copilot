/**
 * Recompute position exit decisions using merged official-open rows when available.
 * Builds context (concentration, recommendation policy, behavior, setup, news) and upserts PositionDecisionSnapshot.
 * Uses official quantity/size and merged marketValue so suggestedExitSize never exceeds displayed open quantity.
 * No autonomous exits; advisory only.
 */

import { prisma } from "@/lib/db";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";
import { fetchOfficialPositions } from "@/lib/polymarket/official-positions";
import { buildOpenPositionsFromOfficial } from "@/lib/portfolio/open-positions-from-official";
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
  /** True when decisions were built from merged official-open rows. */
  usedOfficialOpenSet?: boolean;
}

/**
 * Recompute position decisions for the given funder (or current funder).
 * When official positions are available, uses merged open rows (official quantity + derived enrichment)
 * so suggestedExitSize and concentration are based on the same truth model as the portfolio API.
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

  const [positions, officialResult] = await Promise.all([
    prisma.derivedPosition.findMany({
      where: { funderAddress: resolved },
      include: { syncedMarket: { select: { status: true } } },
    }),
    fetchOfficialPositions(resolved),
  ]);

  const useOfficialOpenSet = officialResult.positions.length > 0;
  const merged = useOfficialOpenSet
    ? buildOpenPositionsFromOfficial(officialResult.positions, positions, resolved, true)
    : null;

  const rowsToProcess = merged ? merged.rows : positions;
  if (rowsToProcess.length === 0) {
    return { funderAddress: resolved, snapshotsUpserted: 0, errors: [], usedOfficialOpenSet: useOfficialOpenSet };
  }

  type MergedRow = (typeof merged) extends { rows: infer R } ? R[number] : never;
  const isMergedRow = (r: MergedRow | (typeof positions)[0]): r is MergedRow => useOfficialOpenSet && merged !== null;

  let totalExposure: number;
  const themeExposureMap = new Map<string, number>();

  if (merged) {
    totalExposure = merged.rows.reduce((s, r) => s + parseNum(r.marketValue), 0);
    for (const r of merged.rows) {
      const theme = r.theme ?? "Other";
      themeExposureMap.set(theme, (themeExposureMap.get(theme) ?? 0) + parseNum(r.marketValue));
    }
  } else {
    const snapshot = await prisma.portfolioSnapshot.findFirst({
      where: { funderAddress: resolved },
      orderBy: { createdAt: "desc" },
    });
    totalExposure = snapshot ? parseNum(snapshot.totalOpenExposure) : 0;
    for (const p of positions) {
      const theme = p.theme ?? "Other";
      themeExposureMap.set(theme, (themeExposureMap.get(theme) ?? 0) + parseNum(p.marketValue));
    }
  }

  const conditionIds = merged ? [...new Set(merged.rows.map((r) => r.marketId).filter(Boolean))] : [] as string[];
  const derivedMarketIds = merged ? [...new Set(merged.rows.map((r) => r.derived?.marketId).filter(Boolean))] as string[] : [];
  const marketIds = merged ? [] : Array.from(new Set(positions.map((p) => p.marketId)));

  // Load `markets` before any query that references it. A previous bug used `markets.map(...)`
  // inside the same `Promise.all` that assigned `markets`, causing TDZ:
  // "Cannot access 'markets' before initialization" (position_decision_recompute).
  const markets = merged
    ? await prisma.syncedMarket.findMany({
        where: {
          OR: [
            ...(conditionIds.length ? [{ conditionId: { in: conditionIds } }] : []),
            ...(derivedMarketIds.length ? [{ id: { in: derivedMarketIds } }] : []),
            ...(conditionIds.length === 0 && derivedMarketIds.length === 0 ? [{ id: { in: [] } }] : []),
          ],
        },
      })
    : await prisma.syncedMarket.findMany({ where: { id: { in: marketIds } } });

  const marketIdsForNews = markets.map((m) => m.id);
  const [behaviorFlags, newsLinksByMarket, decisionsByRecId] = await Promise.all([
    prisma.behaviorFlag.findMany({ where: { funderAddress: resolved } }),
    prisma.marketNewsLink.groupBy({
      by: ["marketId"],
      where: marketIdsForNews.length > 0 ? { marketId: { in: marketIdsForNews } } : { marketId: { in: [] } },
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

  const marketById = new Map(markets.map((m) => [m.id, m]));
  const marketByConditionId = new Map(
    markets
      .filter((m) => m.conditionId != null)
      .map((m) => [m.conditionId as string, m] as const)
  );

  let snapshotsUpserted = 0;
  for (let i = 0; i < rowsToProcess.length; i++) {
    const row = rowsToProcess[i];
    try {
      const assetId = row.assetId;
      const theme = (row as { theme?: string | null }).theme ?? "Other";
      const themeExposure = themeExposureMap.get(theme) ?? 0;
      const concentrationPct = totalExposure > 0 ? (themeExposure / totalExposure) * 100 : 0;

      const syncedMarketId = merged
        ? (marketById.get((row as MergedRow).derived?.marketId ?? "") ?? marketByConditionId.get((row as MergedRow).marketId)?.id)
        : (row as (typeof positions)[0]).marketId;
      const market = syncedMarketId ? marketById.get(syncedMarketId) : undefined;

      let daysToResolution: number | null = null;
      if (market?.endDate) {
        const end = new Date(market.endDate).getTime();
        const now = Date.now();
        daysToResolution = Math.max(0, (end - now) / (24 * 60 * 60 * 1000));
      }

      const outcome = (row as { outcome: string }).outcome;
      const recommendationPolicyState = syncedMarketId ? policyByMarketOutcome.get(`${syncedMarketId}:${outcome}`) ?? null : null;
      const marketTitle = (row as { marketTitle?: string }).marketTitle;
      const hasBehaviorFlag = behaviorFlags.some(
        (f) =>
          f.marketTitle?.toLowerCase().includes((marketTitle ?? "").toLowerCase()) ||
          f.description?.toLowerCase().includes((theme ?? "").toLowerCase())
      );
      const linkedNewsCount = syncedMarketId ? newsCountByMarket.get(syncedMarketId) ?? 0 : 0;

      const category = (row as { category?: string | null }).category;
      const themeVal = (row as { theme?: string | null }).theme;
      const setupAdjustment = await getSetupAdjustment({
        signalType: null,
        category: category ?? null,
        theme: themeVal ?? null,
        reviewStatus: null,
      });
      const setupActedWinRate = setupAdjustment?.actedWinRate ?? null;

      const sizeStr = (row as { size: string }).size;
      const avgEntryStr = isMergedRow(row) ? (row as MergedRow).avgEntry ?? "" : (row as (typeof positions)[0]).avgEntry;
      const unrealizedStr = isMergedRow(row) ? (row as MergedRow).unrealizedPnl ?? "" : (row as (typeof positions)[0]).unrealizedPnl;
      const costBasis = Math.abs(parseNum(sizeStr) * parseNum(avgEntryStr));
      const unrealizedPnlFraction = costBasis > 0 ? parseNum(unrealizedStr) / costBasis : 0;

      const ctx: PositionContext = {
        funderAddress: (row as { funderAddress: string }).funderAddress,
        assetId,
        marketId: syncedMarketId ?? (row as { marketId: string }).marketId,
        size: sizeStr,
        avgEntry: avgEntryStr,
        lastPrice: (row as { lastPrice: string }).lastPrice,
        unrealizedPnl: unrealizedStr,
        marketValue: (row as { marketValue: string }).marketValue,
        category: category ?? null,
        theme: themeVal ?? null,
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
          funderAddress_assetId: { funderAddress: resolved, assetId },
        },
        create: {
          funderAddress: resolved,
          assetId,
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
    usedOfficialOpenSet: useOfficialOpenSet,
  };
}
