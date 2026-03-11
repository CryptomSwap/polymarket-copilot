/**
 * Execution summary and funnel aggregates. Analytics only.
 */

import { prisma } from "@/lib/db";

function parseNum(s: string | null | undefined): number {
  if (s == null || s === "") return 0;
  const n = parseFloat(String(s).trim());
  return Number.isFinite(n) ? n : 0;
}

export interface ExecutionSummaryResult {
  actedOnCount: number;
  ignoredCount: number;
  actedOnWinRate: number | null;
  ignoredWinRate: number | null;
  approvedActedOnWinRate: number | null;
  rejectedSkippedWinRate: number | null;
  averageSlippage: number | null;
  averageSizeOverride: number | null;
  overridePerformance: { overriddenWinRate: number | null; matchedWinRate: number | null };
  /** Execution-aware: heuristic top picks (priorityScore > 0.5) acted on vs ignored. */
  heuristicTopActedCount?: number;
  heuristicTopActedWinRate?: number | null;
  heuristicTopIgnoredCount?: number;
  heuristicTopIgnoredWinRate?: number | null;
  /** ML-supported (has mlScore) acted on vs ignored. */
  mlSupportedActedCount?: number;
  mlSupportedActedWinRate?: number | null;
  mlSupportedIgnoredCount?: number;
  mlSupportedIgnoredWinRate?: number | null;
  /** Strong heuristic/ML disagreement (|priority - mlScore| > 0.25) and outcomes. */
  strongDisagreementCount?: number;
  strongDisagreementActedCount?: number;
  strongDisagreementActedWinRate?: number | null;
}

export async function getExecutionSummary(funderAddress?: string): Promise<ExecutionSummaryResult> {
  const funderFilter = funderAddress ? { funderAddress: funderAddress.toLowerCase() } : {};

  const outcomes = await prisma.recommendationExecutionOutcome.findMany({
    where: funderFilter,
    include: { recommendation: { include: { review: true } } },
  });

  const actedOn = outcomes.filter((o) => o.actedOn);
  const actedOnCount = actedOn.length;

  const recsWithOutcome = new Set(outcomes.map((o) => o.recommendationId));
  const allRecs = await prisma.recommendation.findMany({
    where: { marketSignal: funderFilter },
    select: { id: true },
  });
  const ignoredCount = Math.max(0, allRecs.length - recsWithOutcome.size);

  function winRate(items: { forwardReturn24h: string | null }[]): number | null {
    if (items.length === 0) return null;
    const withReturn = items.filter((i) => i.forwardReturn24h != null && i.forwardReturn24h !== "");
    if (withReturn.length === 0) return null;
    const wins = withReturn.filter((i) => parseNum(i.forwardReturn24h) > 0).length;
    return wins / withReturn.length;
  }

  const actedOnWinRate = winRate(actedOn);
  const ignoredRecs = allRecs.filter((r) => !recsWithOutcome.has(r.id));
  const ignoredEvals = await prisma.recommendationEvaluation.findMany({
    where: { recommendationId: { in: ignoredRecs.map((r) => r.id) } },
    orderBy: { evaluatedAt: "desc" },
  });
  const latestByRec = new Map<string | null, string>();
  for (const e of ignoredEvals) {
    if (!latestByRec.has(e.recommendationId))
      latestByRec.set(e.recommendationId, e.priceChange24h ?? "");
  }
  const ignoredWinRate =
    latestByRec.size === 0
      ? null
      : (Array.from(latestByRec.values()).filter((v) => parseNum(v) > 0).length / latestByRec.size) || null;

  const approvedActedOn = actedOn.filter((o) => o.recommendation.review?.status === "APPROVED");
  const approvedActedOnWinRate = winRate(approvedActedOn);

  const rejectedRecs = await prisma.recommendation.findMany({
    where: { marketSignal: funderFilter, review: { status: "REJECTED" } },
    select: { id: true },
  });
  const rejectedSkippedIds = rejectedRecs.filter((r) => !recsWithOutcome.has(r.id)).map((r) => r.id);
  const rejectedEvals = await prisma.recommendationEvaluation.findMany({
    where: { recommendationId: { in: rejectedSkippedIds } },
    orderBy: { evaluatedAt: "desc" },
  });
  const rejectedLatestByRec = new Map<string, string>();
  for (const e of rejectedEvals) {
    if (!rejectedLatestByRec.has(e.recommendationId))
      rejectedLatestByRec.set(e.recommendationId, e.priceChange24h ?? "");
  }
  const rejectedSkippedWinRate =
    rejectedLatestByRec.size === 0
      ? null
      : Array.from(rejectedLatestByRec.values()).filter((v) => parseNum(v) > 0).length /
        rejectedLatestByRec.size;

  const slippageValues = actedOn
    .map((o) => (o.slippage != null && o.slippage !== "" ? parseNum(o.slippage) : null))
    .filter((v): v is number => v !== null);
  const averageSlippage =
    slippageValues.length === 0 ? null : slippageValues.reduce((a, b) => a + b, 0) / slippageValues.length;

  const sizeOverrides = actedOn
    .filter((o) => o.suggestedSize != null && o.actualSize != null)
    .map((o) => {
      const sug = parseNum(o.suggestedSize);
      const act = parseNum(o.actualSize);
      if (sug <= 0) return null;
      return Math.abs(act - sug) / sug;
    })
    .filter((v): v is number => v !== null);
  const averageSizeOverride =
    sizeOverrides.length === 0 ? null : sizeOverrides.reduce((a, b) => a + b, 0) / sizeOverrides.length;

  const overridden = actedOn.filter((o) => o.overridden);
  const matched = actedOn.filter((o) => !o.overridden);
  const overridePerformance = {
    overriddenWinRate: winRate(overridden),
    matchedWinRate: winRate(matched),
  };

  const allRecsWithScores = await prisma.recommendation.findMany({
    where: { marketSignal: funderFilter },
    select: { id: true, priorityScore: true, mlScore: true },
  });
  const heuristicTopIds = new Set(
    allRecsWithScores.filter((r) => parseNum(r.priorityScore) > 0.5).map((r) => r.id)
  );
  const mlSupportedIds = new Set(
    allRecsWithScores.filter((r) => r.mlScore != null && r.mlScore !== "").map((r) => r.id)
  );
  const strongDisagreementIds = new Set(
    allRecsWithScores.filter((r) => {
      const p = parseNum(r.priorityScore);
      const m = parseNum(r.mlScore);
      return Number.isFinite(p) && Number.isFinite(m) && Math.abs(p - m) > 0.25;
    }).map((r) => r.id)
  );

  const heuristicTopActed = actedOn.filter((o) => heuristicTopIds.has(o.recommendationId));
  const heuristicTopActedCount = heuristicTopActed.length;
  const heuristicTopActedWinRate = winRate(heuristicTopActed);
  const heuristicTopIgnoredRecs = allRecs.filter((r) => heuristicTopIds.has(r.id) && !recsWithOutcome.has(r.id));
  const heuristicTopIgnoredCount = heuristicTopIgnoredRecs.length;
  const heuristicTopIgnoredEvals = await prisma.recommendationEvaluation.findMany({
    where: { recommendationId: { in: heuristicTopIgnoredRecs.map((r) => r.id) } },
    orderBy: { evaluatedAt: "desc" },
  });
  const htIgnoredLatest = new Map<string, string>();
  for (const e of heuristicTopIgnoredEvals) {
    if (!htIgnoredLatest.has(e.recommendationId)) htIgnoredLatest.set(e.recommendationId, e.priceChange24h ?? "");
  }
  const heuristicTopIgnoredWinRate =
    htIgnoredLatest.size === 0
      ? null
      : Array.from(htIgnoredLatest.values()).filter((v) => parseNum(v) > 0).length / htIgnoredLatest.size;

  const mlSupportedActed = actedOn.filter((o) => mlSupportedIds.has(o.recommendationId));
  const mlSupportedActedCount = mlSupportedActed.length;
  const mlSupportedActedWinRate = winRate(mlSupportedActed);
  const mlSupportedIgnoredRecs = allRecs.filter((r) => mlSupportedIds.has(r.id) && !recsWithOutcome.has(r.id));
  const mlSupportedIgnoredCount = mlSupportedIgnoredRecs.length;
  const mlSupportedIgnoredEvals = await prisma.recommendationEvaluation.findMany({
    where: { recommendationId: { in: mlSupportedIgnoredRecs.map((r) => r.id) } },
    orderBy: { evaluatedAt: "desc" },
  });
  const mlIgnoredLatest = new Map<string, string>();
  for (const e of mlSupportedIgnoredEvals) {
    if (!mlIgnoredLatest.has(e.recommendationId)) mlIgnoredLatest.set(e.recommendationId, e.priceChange24h ?? "");
  }
  const mlSupportedIgnoredWinRate =
    mlIgnoredLatest.size === 0
      ? null
      : Array.from(mlIgnoredLatest.values()).filter((v) => parseNum(v) > 0).length / mlIgnoredLatest.size;

  const strongDisagreementActed = actedOn.filter((o) => strongDisagreementIds.has(o.recommendationId));
  const strongDisagreementCount = strongDisagreementIds.size;
  const strongDisagreementActedCount = strongDisagreementActed.length;
  const strongDisagreementActedWinRate = winRate(strongDisagreementActed);

  return {
    actedOnCount,
    ignoredCount,
    actedOnWinRate,
    ignoredWinRate,
    approvedActedOnWinRate,
    rejectedSkippedWinRate: rejectedSkippedWinRate ?? null,
    averageSlippage,
    averageSizeOverride,
    overridePerformance,
    heuristicTopActedCount,
    heuristicTopActedWinRate: heuristicTopActedWinRate ?? undefined,
    heuristicTopIgnoredCount,
    heuristicTopIgnoredWinRate: heuristicTopIgnoredWinRate ?? undefined,
    mlSupportedActedCount,
    mlSupportedActedWinRate: mlSupportedActedWinRate ?? undefined,
    mlSupportedIgnoredCount,
    mlSupportedIgnoredWinRate: mlSupportedIgnoredWinRate ?? undefined,
    strongDisagreementCount,
    strongDisagreementActedCount,
    strongDisagreementActedWinRate: strongDisagreementActedWinRate ?? undefined,
  };
}

export interface RecommendationFunnelResult {
  shown: number;
  reviewed: number;
  approved: number;
  rejected: number;
  previewed: number;
  intentCreated: number;
  placed: number;
  filled: number;
  skipped: number;
}

export async function getRecommendationFunnel(funderAddress?: string): Promise<RecommendationFunnelResult> {
  const funderFilter = funderAddress ? { funderAddress: funderAddress.toLowerCase() } : {};

  const events = await prisma.recommendationLifecycleEvent.findMany({
    where: funderFilter,
    select: { eventType: true },
  });

  const counts = {
    SHOWN: 0,
    REVIEWED: 0,
    APPROVED: 0,
    REJECTED: 0,
    PREVIEWED: 0,
    INTENT_CREATED: 0,
    ORDER_PLACED: 0,
    ORDER_CANCELLED: 0,
    FILLED: 0,
    SKIPPED: 0,
  };
  for (const e of events) {
    if (e.eventType in counts) (counts as Record<string, number>)[e.eventType]++;
  }

  return {
    shown: counts.SHOWN,
    reviewed: counts.REVIEWED,
    approved: counts.APPROVED,
    rejected: counts.REJECTED,
    previewed: counts.PREVIEWED,
    intentCreated: counts.INTENT_CREATED,
    placed: counts.ORDER_PLACED,
    filled: counts.FILLED,
    skipped: counts.SKIPPED,
  };
}
