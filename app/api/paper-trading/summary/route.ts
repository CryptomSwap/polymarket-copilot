import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getPaperTradingConfig } from "@/lib/paper-trading/config";

export const dynamic = "force-dynamic";

/**
 * GET /api/paper-trading/summary
 * Aggregate stats: total, open, closed, win rate, avg pnl, cumulative pnl, avg score, avg hold time, win/loss counts, pnl distribution.
 * Query: from (ISO date), to (ISO date), modelRunId - applied to all aggregates.
 */
export async function GET(request: NextRequest) {
  try {
    const config = getPaperTradingConfig();
    const { searchParams } = new URL(request.url);
    const from = searchParams.get("from");
    const to = searchParams.get("to");
    const modelRunId = searchParams.get("modelRunId") ?? undefined;
    const botTypeFilter = searchParams.get("botType") ?? undefined;

    const where: { status?: string; modelRunId?: string; botType?: string; entryTime?: { gte?: Date; lte?: Date }; createdAt?: { gte?: Date; lte?: Date } } = {};
    if (modelRunId) where.modelRunId = modelRunId;
    if (botTypeFilter) where.botType = botTypeFilter;
    if (from || to) {
      where.entryTime = {};
      if (from) where.entryTime.gte = new Date(from);
      if (to) where.entryTime.lte = new Date(to);
    }

    const [allTrades, openTrades, closedTrades] = await Promise.all([
      prisma.paperTrade.findMany({ where, select: { id: true, status: true, score: true, entryTime: true, exitTime: true, pnlPct: true, modelRunId: true, threshold: true, paperPolicyMode: true, botType: true } }),
      prisma.paperTrade.findMany({ where: { ...where, status: "open" }, select: { id: true, score: true, botType: true } }),
      prisma.paperTrade.findMany({ where: { ...where, status: "closed" }, select: { pnlPct: true, entryTime: true, exitTime: true, paperPolicyMode: true, botType: true } }),
    ]);

    const totalCount = allTrades.length;
    const openCount = openTrades.length;
    const closed = closedTrades;

    const pnlPcts = closed.map((t) => parseFloat(t.pnlPct ?? "")).filter((n) => Number.isFinite(n));
    const wins = pnlPcts.filter((p) => p > 0).length;
    const losses = pnlPcts.filter((p) => p < 0).length;
    const winRate = pnlPcts.length > 0 ? wins / pnlPcts.length : null;
    const avgPnl = pnlPcts.length > 0 ? pnlPcts.reduce((a, b) => a + b, 0) / pnlPcts.length : null;
    const cumulativePnl = pnlPcts.length > 0 ? pnlPcts.reduce((a, b) => a + b, 0) : null;

    const scoresOpened = allTrades.map((t) => t.score).filter((n) => Number.isFinite(n));
    const averageScoreOfOpened = scoresOpened.length > 0 ? scoresOpened.reduce((a, b) => a + b, 0) / scoresOpened.length : null;

    const holdTimesHours: number[] = [];
    for (const t of closed) {
      if (t.entryTime && t.exitTime) {
        const ms = new Date(t.exitTime).getTime() - new Date(t.entryTime).getTime();
        holdTimesHours.push(ms / (60 * 60 * 1000));
      }
    }
    const averageHoldTimeHours = holdTimesHours.length > 0 ? holdTimesHours.reduce((a, b) => a + b, 0) / holdTimesHours.length : null;

    const pnlDistribution = {
      winCount: wins,
      lossCount: losses,
      flatCount: pnlPcts.filter((p) => p === 0).length,
      buckets: [] as { min: number; max: number; count: number }[],
    };
    if (pnlPcts.length > 0) {
      const sorted = [...pnlPcts].sort((a, b) => a - b);
      const minP = Math.min(...sorted);
      const maxP = Math.max(...sorted);
      const step = (maxP - minP) / 5 || 0.01;
      for (let i = 0; i < 5; i++) {
        const lo = minP + i * step;
        const hi = i === 4 ? maxP + 0.0001 : minP + (i + 1) * step;
        pnlDistribution.buckets.push({
          min: Math.round(lo * 100) / 100,
          max: Math.round(hi * 100) / 100,
          count: sorted.filter((p) => p >= lo && p < hi).length,
        });
      }
    }

    const latestRun =
      allTrades.length > 0
        ? (await prisma.paperTrade.findFirst({
            where,
            orderBy: { createdAt: "desc" },
            select: { modelRunId: true },
          }))?.modelRunId ?? null
        : null;

    const closedByMode = { normal: closed.filter((t) => t.paperPolicyMode !== "relaxed_block_candidate"), relaxed_block_candidate: closed.filter((t) => t.paperPolicyMode === "relaxed_block_candidate") };
    const pnlByPolicyMode = {
      normal: (() => {
        const arr = closedByMode.normal.map((t) => parseFloat(t.pnlPct ?? "")).filter((n) => Number.isFinite(n));
        return {
          count: closedByMode.normal.length,
          winCount: arr.filter((p) => p > 0).length,
          lossCount: arr.filter((p) => p < 0).length,
          averagePnlPct: arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : null,
          cumulativePnlPct: arr.length > 0 ? arr.reduce((a, b) => a + b, 0) : null,
        };
      })(),
      relaxed_block_candidate: (() => {
        const arr = closedByMode.relaxed_block_candidate.map((t) => parseFloat(t.pnlPct ?? "")).filter((n) => Number.isFinite(n));
        return {
          count: closedByMode.relaxed_block_candidate.length,
          winCount: arr.filter((p) => p > 0).length,
          lossCount: arr.filter((p) => p < 0).length,
          averagePnlPct: arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : null,
          cumulativePnlPct: arr.length > 0 ? arr.reduce((a, b) => a + b, 0) : null,
        };
      })(),
    };

    const perBotSummary: Record<
      string,
      {
        totalPaperTrades: number;
        openTrades: number;
        closedTrades: number;
        winRate: number | null;
        winCount: number;
        lossCount: number;
        averagePnlPct: number | null;
        cumulativePnlPct: number | null;
        averageScoreOfOpened: number | null;
      }
    > = {};

    const botKeys = [...new Set(allTrades.map((t) => t.botType ?? "default"))];
    for (const botType of botKeys) {
      const allForBot = allTrades.filter((t) => (t.botType ?? "default") === botType);
      const openForBot = openTrades.filter((t) => (t.botType ?? "default") === botType);
      const closedForBot = closed.filter((t) => (t.botType ?? "default") === botType);

      const pnlPctsBot = closedForBot
        .map((t) => parseFloat(t.pnlPct ?? ""))
        .filter((n) => Number.isFinite(n));
      const winsBot = pnlPctsBot.filter((p) => p > 0).length;
      const lossesBot = pnlPctsBot.filter((p) => p < 0).length;
      const winRateBot = pnlPctsBot.length > 0 ? winsBot / pnlPctsBot.length : null;
      const avgPnlBot =
        pnlPctsBot.length > 0
          ? pnlPctsBot.reduce((a, b) => a + b, 0) / pnlPctsBot.length
          : null;
      const cumulativePnlBot =
        pnlPctsBot.length > 0 ? pnlPctsBot.reduce((a, b) => a + b, 0) : null;

      const scoresOpenedBot = allForBot
        .map((t) => t.score)
        .filter((n) => Number.isFinite(n));
      const avgScoreBot =
        scoresOpenedBot.length > 0
          ? scoresOpenedBot.reduce((a, b) => a + b, 0) / scoresOpenedBot.length
          : null;

      perBotSummary[botType] = {
        totalPaperTrades: allForBot.length,
        openTrades: openForBot.length,
        closedTrades: closedForBot.length,
        winRate: winRateBot,
        winCount: winsBot,
        lossCount: lossesBot,
        averagePnlPct: avgPnlBot,
        cumulativePnlPct: cumulativePnlBot,
        averageScoreOfOpened: avgScoreBot,
      };
    }

    return NextResponse.json({
      totalPaperTrades: totalCount,
      openTrades: openCount,
      closedTrades: closed.length,
      winRate,
      winCount: wins,
      lossCount: losses,
      averagePnlPct: avgPnl,
      cumulativePnlPct: cumulativePnl,
      averageScoreOfOpened,
      averageHoldTimeHours,
      pnlDistribution,
      pnlByPolicyMode,
      currentModelRunId: latestRun,
      threshold: config.threshold,
      enabled: config.enabled,
      perBotSummary,
    });
  } catch (e) {
    console.error("[GET /api/paper-trading/summary]", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Summary failed" },
      { status: 500 }
    );
  }
}
