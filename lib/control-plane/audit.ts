import { prisma } from "@/lib/db";
import { getBotOverlapReport } from "@/lib/paper-trading/analytics";
import { computeBootstrapActivationPreview, computeShadowPromotionPreview } from "@/lib/ops/self-improvement-loop";
import type { BotScorecard, MlScorecard, NullFieldReason } from "./contracts";

function asNum(value: string | null | undefined): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function corr(xs: number[], ys: number[]): number | null {
  if (xs.length !== ys.length || xs.length < 2) return null;
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  if (vx <= 0 || vy <= 0) return null;
  return cov / Math.sqrt(vx * vy);
}

function quartileBuckets(values: number[]): [number, number, number] {
  if (values.length === 0) return [0, 0, 0];
  const s = [...values].sort((a, b) => a - b);
  const idx = (p: number) => s[Math.min(s.length - 1, Math.max(0, Math.floor((s.length - 1) * p)))];
  return [idx(0.25), idx(0.5), idx(0.75)];
}

export async function buildBotScorecards(lookbackDays = 14): Promise<{ bots: BotScorecard[] }> {
  type BotTradeRow = {
    botType: string;
    status: string;
    entryPriceBand: string | null;
    markout12h: string | null;
    pnlPct: string | null;
    challengerScoreDelta: number | null;
    createdAt: Date;
  };
  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
  const [trades, overlap] = await Promise.all([
    prisma.paperTrade.findMany({
      where: { entryTime: { gte: since } },
      orderBy: { createdAt: "asc" },
      select: {
        botType: true,
        status: true,
        entryPriceBand: true,
        markout12h: true,
        pnlPct: true,
        challengerScoreDelta: true,
        createdAt: true,
      },
    }),
    getBotOverlapReport({ from: since }),
  ]);

  const now = Date.now();
  const overlapFlagBots = new Set<string>();
  for (const pair of overlap) {
    if (pair.sameAssetSideCount >= 5 || pair.sameMarketCount >= 10) {
      overlapFlagBots.add(pair.botA);
      overlapFlagBots.add(pair.botB);
    }
  }

  const byBot = new Map<string, BotTradeRow[]>();
  for (const t of trades as BotTradeRow[]) {
    const bot = t.botType ?? "default";
    if (!byBot.has(bot)) byBot.set(bot, []);
    byBot.get(bot)!.push(t);
  }

  const cards: BotScorecard[] = [];
  for (const [botId, rows] of Array.from(byBot.entries())) {
    const nullReasons: NullFieldReason[] = [];
    const markouts = rows.map((r) => asNum(r.markout12h)).filter((v): v is number => v != null);
    const pnls = rows.map((r) => asNum(r.pnlPct)).filter((v): v is number => v != null);
    const rankLiftVals = rows
      .map((r) => (typeof r.challengerScoreDelta === "number" ? r.challengerScoreDelta : null))
      .filter((v): v is number => v != null);
    const byBand: BotScorecard["byBand"] = {};
    const byBandRows = new Map<string, number[]>();
    const byBandPnl = new Map<string, number[]>();
    for (const r of rows) {
      const key = r.entryPriceBand ?? "unknown";
      if (!byBandRows.has(key)) byBandRows.set(key, []);
      if (!byBandPnl.has(key)) byBandPnl.set(key, []);
      const m = asNum(r.markout12h);
      const p = asNum(r.pnlPct);
      if (m != null) byBandRows.get(key)!.push(m);
      if (p != null) byBandPnl.get(key)!.push(p);
    }
    for (const [band, vals] of Array.from(byBandRows.entries())) {
      const p = byBandPnl.get(band) ?? [];
      byBand[band] = {
        sampleSize: rows.filter((r) => (r.entryPriceBand ?? "unknown") === band).length,
        avgMarkout: vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : null,
        hitRate: p.length > 0 ? p.filter((x) => x > 0).length / p.length : null,
      };
    }

    nullReasons.push({
      field: "bySpreadQuartile",
      reason: "PaperTrade does not persist per-trade spread value, so spread quartiles are not derivable from existing storage.",
    });

    const lastAt = rows.length ? Math.max(...rows.map((r) => r.createdAt.getTime())) : 0;
    const inactivityFlag = !lastAt || now - lastAt > 72 * 60 * 60 * 1000;
    const avgMarkout = markouts.length ? markouts.reduce((a, b) => a + b, 0) / markouts.length : null;
    const hitRate = pnls.length ? pnls.filter((x) => x > 0).length / pnls.length : null;
    const rankLift = rankLiftVals.length
      ? rankLiftVals.reduce((a, b) => a + b, 0) / rankLiftVals.length
      : null;
    if (rankLift == null) {
      nullReasons.push({
        field: "rankLift",
        reason: "No challenger/champion score deltas available in lookback window for this bot.",
      });
    }

    let primaryFailureMode: string | null = null;
    let recommendedAction: string | null = null;
    if ((avgMarkout ?? 0) < 0) {
      primaryFailureMode = "negative_markout";
      recommendedAction = "tighten threshold and reduce paper allocation for this bot";
    } else if ((hitRate ?? 1) < 0.45) {
      primaryFailureMode = "low_hit_rate";
      recommendedAction = "increase admission strictness and review candidate quality filters";
    } else if (inactivityFlag) {
      primaryFailureMode = "inactive";
      recommendedAction = "investigate candidate supply and scheduler health";
    }

    cards.push({
      botId,
      status: inactivityFlag ? "inactive" : primaryFailureMode ? "degraded" : "active",
      sampleSize: rows.length,
      avgMarkout,
      hitRate,
      byBand,
      bySpreadQuartile: null,
      rankLift,
      inactivityFlag,
      redundancyFlag: overlapFlagBots.has(botId),
      primaryFailureMode,
      recommendedAction,
      nullFieldReasons: nullReasons,
    });
  }

  return { bots: cards.sort((a, b) => a.botId.localeCompare(b.botId)) };
}

export async function buildMlScorecard(lookbackDays = 14): Promise<MlScorecard> {
  const nullFieldReasons: NullFieldReason[] = [];
  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);

  const [activeRun, latestRun, recCount, recScores, paperTrades] = await Promise.all([
    prisma.mlModelRun.findFirst({
      where: { status: "ACTIVE" },
      orderBy: { updatedAt: "desc" },
    }),
    prisma.mlModelRun.findFirst({ orderBy: { createdAt: "desc" } }),
    prisma.recommendation.count({ where: { createdAt: { gte: since } } }),
    prisma.recommendationMlScore.findMany({
      where: { scoredAt: { gte: since } },
      orderBy: { scoredAt: "asc" },
      select: { score: true, mlModelRunId: true },
    }),
    prisma.paperTrade.findMany({
      where: { entryTime: { gte: since } },
      select: { score: true, pnlPct: true, modelRunId: true },
    }),
  ]);

  const modelVersion = activeRun?.id ?? latestRun?.id ?? null;
  const influenceRate = recCount > 0 ? recScores.length / recCount : null;
  if (influenceRate == null) {
    nullFieldReasons.push({
      field: "influenceRate",
      reason: "No recommendations in lookback window, cannot compute scoring influence.",
    });
  }

  const activeTradeRows = paperTrades.filter((t) => (modelVersion ? t.modelRunId === modelVersion : true));
  const xs: number[] = [];
  const ys: number[] = [];
  for (const t of activeTradeRows) {
    const y = asNum(t.pnlPct);
    if (y == null) continue;
    xs.push(t.score);
    ys.push(y);
  }
  const scoreCorrelation = corr(xs, ys);
  if (scoreCorrelation == null) {
    nullFieldReasons.push({
      field: "scoreCorrelation",
      reason: "Insufficient closed-trade sample with numeric pnlPct in lookback window.",
    });
  }

  let bucketLift: MlScorecard["bucketLift"] = null;
  if (xs.length >= 4) {
    const [q1, , q3] = quartileBuckets(xs);
    const top = ys.filter((_, i) => xs[i] >= q3);
    const bottom = ys.filter((_, i) => xs[i] <= q1);
    const topHit = top.length ? top.filter((v) => v > 0).length / top.length : null;
    const bottomHit = bottom.length ? bottom.filter((v) => v > 0).length / bottom.length : null;
    bucketLift = {
      topQuartileHitRate: topHit,
      bottomQuartileHitRate: bottomHit,
      delta: topHit != null && bottomHit != null ? topHit - bottomHit : null,
    };
  } else {
    nullFieldReasons.push({
      field: "bucketLift",
      reason: "Need at least 4 scored closed trades to form quartile buckets deterministically.",
    });
  }

  let featureHealth: Record<string, unknown> | null = null;
  if (latestRun?.metricsJson) {
    try {
      const parsed = JSON.parse(latestRun.metricsJson) as Record<string, unknown>;
      featureHealth = {
        hasCoefficients: Array.isArray(parsed.coefficients),
        featureSetName: latestRun.featureSetName,
        leakageCheckPassed: latestRun.leakageCheckPassed ?? null,
      };
    } catch {
      featureHealth = null;
      nullFieldReasons.push({
        field: "featureHealth",
        reason: "Latest run metricsJson is not parseable.",
      });
    }
  } else {
    nullFieldReasons.push({
      field: "featureHealth",
      reason: "Latest model run has no metricsJson.",
    });
  }

  let labelHealth: Record<string, unknown> | null = null;
  const label = activeRun?.targetLabel ?? latestRun?.targetLabel ?? null;
  if (label) {
    const total = await prisma.mlShadowTrainingExample.count();
    const present = await prisma.mlShadowTrainingExample.count({
      where: { [label]: { not: null } },
    });
    labelHealth = {
      targetLabel: label,
      labeledRows: present,
      totalRows: total,
      coverage: total > 0 ? present / total : null,
    };
  } else {
    nullFieldReasons.push({
      field: "labelHealth",
      reason: "No active/latest model target label found.",
    });
  }

  const [bootstrapPreview, promotionPreview] = await Promise.all([
    computeBootstrapActivationPreview(),
    computeShadowPromotionPreview(),
  ]);
  const driftStatus = {
    holdoutNoisy: promotionPreview.holdout.noisy,
    holdoutRows: promotionPreview.holdout.rows,
    reason: promotionPreview.outcomeReason,
  };
  const challengerVsChampion = {
    wouldPromote: promotionPreview.wouldPromote,
    deltaAuc: promotionPreview.metrics.deltaAuc,
    deltaF1: promotionPreview.metrics.deltaF1,
    bootstrapWouldApprove: bootstrapPreview.wouldApprove,
  };

  const isHelping = bucketLift?.delta != null && scoreCorrelation != null
    ? bucketLift.delta > 0 && scoreCorrelation > 0
    : null;

  let primaryFailureMode: string | null = null;
  let recommendedAction: string | null = null;
  if (promotionPreview.holdout.noisy) {
    primaryFailureMode = "insufficient_or_noisy_holdout";
    recommendedAction = "increase labeled sample quality and rerun shadow evaluation";
  } else if ((bucketLift?.delta ?? 0) < 0 || (scoreCorrelation ?? 0) < 0) {
    primaryFailureMode = "model_not_helping";
    recommendedAction = "keep champion unchanged and investigate feature/label drift";
  }

  return {
    modelVersion,
    scope: "global_paper",
    botId: null,
    influenceRate,
    scoreCorrelation,
    bucketLift,
    featureHealth,
    labelHealth,
    driftStatus,
    challengerVsChampion,
    isHelping,
    primaryFailureMode,
    recommendedAction,
    nullFieldReasons,
  };
}
