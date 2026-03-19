import { prisma } from "@/lib/db";

export interface BotAnalyticsFilters {
  from?: Date;
  to?: Date;
  modelRunId?: string;
  botType?: string;
}

export interface BotSegmentCounts {
  byEntryPriceBand: Record<string, number>;
  byPaperPolicyMode: Record<string, number>;
  byPaperRelaxationReason: Record<string, number>;
  byTheme: Record<string, number>;
  byCategory: Record<string, number>;
  byTargetLabel: Record<string, number>;
  byBotVersion: Record<string, number>;
  byProfileSnapshot: Record<string, number>;
  byChallengerAvailable: Record<string, number>;
  byChampionModelRunId: Record<string, number>;
  byChallengerModelRunId: Record<string, number>;
  byChallengerScoreDeltaBucket: Record<string, number>;
}

export interface BotAnalyticsSummary extends BotSegmentCounts {
  botType: string;
  totalTrades: number;
  openTrades: number;
  closedTrades: number;
  winCount: number;
  lossCount: number;
  winRate: number | null;
  averagePnlPct: number | null;
  medianPnlPct: number | null;
  cumulativePnlPct: number | null;
  averageScore: number | null;
  averageThresholdGap: number | null;
}

export async function getPerBotAnalytics(
  filters: BotAnalyticsFilters = {}
): Promise<BotAnalyticsSummary[]> {
  const { from, to, modelRunId, botType } = filters;

  const whereBase: { modelRunId?: string; botType?: string; entryTime?: { gte?: Date; lte?: Date } } = {};
  if (modelRunId) whereBase.modelRunId = modelRunId;
  if (botType) whereBase.botType = botType;
  if (from || to) {
    whereBase.entryTime = {};
    if (from) whereBase.entryTime.gte = from;
    if (to) whereBase.entryTime.lte = to;
  }

  const trades = await prisma.paperTrade.findMany({
    where: whereBase,
    orderBy: { createdAt: "asc" },
  });

  const byBot: Record<string, BotAnalyticsSummary> = {};

  function getOrInit(bot: string): BotAnalyticsSummary {
    if (!byBot[bot]) {
      byBot[bot] = {
        botType: bot,
        totalTrades: 0,
        openTrades: 0,
        closedTrades: 0,
        winCount: 0,
        lossCount: 0,
        winRate: null,
        averagePnlPct: null,
        medianPnlPct: null,
        cumulativePnlPct: null,
        averageScore: null,
        averageThresholdGap: null,
        byEntryPriceBand: {},
        byPaperPolicyMode: {},
        byPaperRelaxationReason: {},
        byTheme: {},
        byCategory: {},
        byTargetLabel: {},
      byBotVersion: {},
      byProfileSnapshot: {},
      byChallengerAvailable: {},
      byChampionModelRunId: {},
      byChallengerModelRunId: {},
      byChallengerScoreDeltaBucket: {},
      };
    }
    return byBot[bot];
  }

  function bump(map: Record<string, number>, key: string | null): void {
    const k = key ?? "unknown";
    map[k] = (map[k] ?? 0) + 1;
  }

  function bucketDelta(delta: number | null | undefined): string {
    if (delta == null || !Number.isFinite(delta)) return "unknown";
    if (delta < -0.05) return "<-0.05";
    if (delta < 0) return "-0.05-0";
    if (delta === 0) return "0";
    if (delta <= 0.05) return "0-0.05";
    return ">0.05";
  }

  for (const t of trades) {
    const botKey = t.botType ?? "default";
    const s = getOrInit(botKey);
    s.totalTrades += 1;
    if (t.status === "open") s.openTrades += 1;
    if (t.status === "closed") s.closedTrades += 1;

    bump(s.byEntryPriceBand, t.entryPriceBand ?? null);
    bump(s.byPaperPolicyMode, t.paperPolicyMode ?? null);
    bump(s.byPaperRelaxationReason, t.paperRelaxationReason ?? null);
    bump(s.byTheme, t.theme ?? null);
    bump(s.byCategory, t.category ?? null);
    bump(s.byTargetLabel, t.targetLabel ?? null);
    bump(s.byBotVersion, t.botVersion ?? null);
    bump(s.byProfileSnapshot, t.profileSnapshotJson ?? null);
    bump(s.byChampionModelRunId, t.championModelRunId ?? t.modelRunId ?? null);
    bump(s.byChallengerModelRunId, t.challengerModelRunId ?? null);
    const availKey =
      t.challengerAvailable == null ? "unknown" : t.challengerAvailable ? "true" : "false";
    bump(s.byChallengerAvailable, availKey);
    bump(s.byChallengerScoreDeltaBucket, bucketDelta(t.challengerScoreDelta as number | null));
  }

  for (const bot of Object.keys(byBot)) {
    const s = byBot[bot];
    const closed = trades.filter((t) => (t.botType ?? "default") === bot && t.status === "closed");
    const pnlVals = closed
      .map((t) => {
        const n = parseFloat(t.pnlPct ?? "");
        return Number.isFinite(n) ? n : null;
      })
      .filter((n): n is number => n !== null);

    const scores = trades
      .filter((t) => (t.botType ?? "default") === bot)
      .map((t) => (Number.isFinite(t.score) ? (t.score as number) : NaN))
      .filter((n) => Number.isFinite(n));

    if (pnlVals.length > 0) {
      const wins = pnlVals.filter((p) => p > 0).length;
      const losses = pnlVals.filter((p) => p < 0).length;
      const cumulative = pnlVals.reduce((a, b) => a + b, 0);
      const avg = cumulative / pnlVals.length;
      const sorted = [...pnlVals].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      const median =
        sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];

      s.winCount = wins;
      s.lossCount = losses;
      s.winRate = pnlVals.length > 0 ? wins / pnlVals.length : null;
      s.averagePnlPct = avg;
      s.cumulativePnlPct = cumulative;
      s.medianPnlPct = median;
    }

    if (scores.length > 0) {
      const sum = scores.reduce((a, b) => a + b, 0);
      s.averageScore = sum / scores.length;

      const gaps: number[] = [];
      for (const t of trades) {
        if ((t.botType ?? "default") !== bot) continue;
        if (!Number.isFinite(t.score) || !Number.isFinite(t.threshold)) continue;
        gaps.push((t.score as number) - (t.threshold as number));
      }
      if (gaps.length > 0) {
        s.averageThresholdGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      }
    }
  }

  return Object.values(byBot).sort((a, b) => a.botType.localeCompare(b.botType));
}

export interface BotOverlapPair {
  botA: string;
  botB: string;
  sameMarketCount: number;
  sameAssetSideCount: number;
}

export async function getBotOverlapReport(filters: BotAnalyticsFilters = {}): Promise<BotOverlapPair[]> {
  const { from, to, modelRunId } = filters;

  const where: { modelRunId?: string; entryTime?: { gte?: Date; lte?: Date } } = {};
  if (modelRunId) where.modelRunId = modelRunId;
  if (from || to) {
    where.entryTime = {};
    if (from) where.entryTime.gte = from;
    if (to) where.entryTime.lte = to;
  }

  const trades = await prisma.paperTrade.findMany({
    where,
    orderBy: { createdAt: "asc" },
  });

  const byMarket: Record<string, Set<string>> = {};
  const byAssetSide: Record<string, Set<string>> = {};

  for (const t of trades) {
    const bot = t.botType ?? "default";
    const marketKey = t.marketId;
    const assetSideKey = `${t.assetId}|${t.side}`;

    if (marketKey) {
      if (!byMarket[marketKey]) byMarket[marketKey] = new Set<string>();
      byMarket[marketKey].add(bot);
    }

    if (t.assetId && t.side) {
      if (!byAssetSide[assetSideKey]) byAssetSide[assetSideKey] = new Set<string>();
      byAssetSide[assetSideKey].add(bot);
    }
  }

  const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const pairs: Record<string, BotOverlapPair> = {};

  function bumpPair(set: Set<string>, field: "sameMarketCount" | "sameAssetSideCount") {
    const bots = Array.from(set);
    for (let i = 0; i < bots.length; i++) {
      for (let j = i + 1; j < bots.length; j++) {
        const a = bots[i];
        const b = bots[j];
        const key = pairKey(a, b);
        if (!pairs[key]) {
          pairs[key] = { botA: a, botB: b, sameMarketCount: 0, sameAssetSideCount: 0 };
        }
        pairs[key][field] += 1;
      }
    }
  }

  for (const set of Object.values(byMarket)) {
    if (set.size > 1) bumpPair(set, "sameMarketCount");
  }
  for (const set of Object.values(byAssetSide)) {
    if (set.size > 1) bumpPair(set, "sameAssetSideCount");
  }

  return Object.values(pairs).sort((a, b) => {
    const ta = a.sameMarketCount + a.sameAssetSideCount;
    const tb = b.sameMarketCount + b.sameAssetSideCount;
    return tb - ta;
  });
}

