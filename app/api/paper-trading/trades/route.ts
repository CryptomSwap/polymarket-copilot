import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * GET /api/paper-trading/trades
 * Recent paper trades. Query: limit (default 50), status (open|closed), modelRunId, from (ISO date), to (ISO date).
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = Math.min(parseInt(searchParams.get("limit") ?? "50", 10) || 50, 200);
    const status = searchParams.get("status") ?? undefined;
    const modelRunId = searchParams.get("modelRunId") ?? undefined;
    const botType = searchParams.get("botType") ?? undefined;
    const from = searchParams.get("from");
    const to = searchParams.get("to");

    const where: { status?: string; modelRunId?: string; botType?: string; entryTime?: { gte?: Date; lte?: Date } } = {};
    if (status === "open" || status === "closed") where.status = status;
    if (modelRunId) where.modelRunId = modelRunId;
    if (botType) where.botType = botType;
    if (from || to) {
      where.entryTime = {};
      if (from) where.entryTime.gte = new Date(from);
      if (to) where.entryTime.lte = new Date(to);
    }

    const trades = await prisma.paperTrade.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    return NextResponse.json({
      trades: trades.map((t) => ({
        id: t.id,
        modelRunId: t.modelRunId,
        championModelRunId: t.championModelRunId ?? null,
        challengerModelRunId: t.challengerModelRunId ?? null,
        marketId: t.marketId,
        assetId: t.assetId,
        theme: t.theme ?? null,
        category: t.category ?? null,
        funderAddress: t.funderAddress,
        side: t.side,
        score: t.score,
        championScore: t.championScore ?? null,
        challengerScore: t.challengerScore ?? null,
        challengerScoreDelta: t.challengerScoreDelta ?? null,
        challengerAvailable: t.challengerAvailable ?? null,
        explorationAdmissionMode: t.explorationAdmissionMode ?? null,
        threshold: t.threshold,
        entryPrice: t.entryPrice,
        entryTime: t.entryTime.toISOString(),
        intendedSize: t.intendedSize,
        status: t.status,
        exitPrice: t.exitPrice,
        exitTime: t.exitTime?.toISOString() ?? null,
        markout12h: t.markout12h,
        pnlPct: t.pnlPct,
        pnlDollars: t.pnlDollars,
        metadataJson: t.metadataJson,
        createdAt: t.createdAt.toISOString(),
        updatedAt: t.updatedAt.toISOString(),
      })),
    });
  } catch (e) {
    console.error("[GET /api/paper-trading/trades]", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Trades fetch failed" },
      { status: 500 }
    );
  }
}
