import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * GET /api/paper-trading/equity
 * Equity curve: cumulative PnL over time. Query: modelRunId (optional), points (default 100, max 500).
 * Returns [{ date (ISO), cumulativePnlPct }] ordered by date.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const modelRunId = searchParams.get("modelRunId") ?? undefined;
    const botType = searchParams.get("botType") ?? undefined;
    const from = searchParams.get("from");
    const to = searchParams.get("to");
    const points = Math.min(parseInt(searchParams.get("points") ?? "100", 10) || 100, 500);

    const where: { modelRunId?: string; botType?: string; status: string; exitTime?: { gte?: Date; lte?: Date } } = { status: "closed" };
    if (modelRunId) where.modelRunId = modelRunId;
    if (botType) where.botType = botType;
    if (from || to) {
      where.exitTime = {};
      if (from) where.exitTime.gte = new Date(from);
      if (to) where.exitTime.lte = new Date(to);
    }
    const closed = await prisma.paperTrade.findMany({
      where,
      orderBy: { exitTime: "asc" },
      select: { exitTime: true, pnlPct: true },
    });

    const withPnl = closed
      .filter((t) => t.exitTime != null && t.pnlPct != null)
      .map((t) => ({ date: t.exitTime!, pnl: parseFloat(t.pnlPct!) }))
      .filter((t) => Number.isFinite(t.pnl));

    let cumulative = 0;
    const curve: { date: string; cumulativePnlPct: number }[] = [];
    const step = Math.max(1, Math.floor(withPnl.length / points));
    for (let i = 0; i < withPnl.length; i++) {
      cumulative += withPnl[i].pnl;
      if (i % step === 0 || i === withPnl.length - 1) {
        curve.push({
          date: withPnl[i].date.toISOString(),
          cumulativePnlPct: cumulative,
        });
      }
    }

    return NextResponse.json({ equityCurve: curve });
  } catch (e) {
    console.error("[GET /api/paper-trading/equity]", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Equity curve failed" },
      { status: 500 }
    );
  }
}
