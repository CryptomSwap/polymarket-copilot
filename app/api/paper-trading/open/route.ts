import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * GET /api/paper-trading/open
 * Open paper trades only.
 */
export async function GET() {
  try {
    const trades = await prisma.paperTrade.findMany({
      where: { status: "open" },
      orderBy: { entryTime: "desc" },
    });

    return NextResponse.json({
      trades: trades.map((t) => ({
        id: t.id,
        modelRunId: t.modelRunId,
        marketId: t.marketId,
        assetId: t.assetId,
        theme: t.theme ?? null,
        category: t.category ?? null,
        funderAddress: t.funderAddress,
        side: t.side,
        score: t.score,
        threshold: t.threshold,
        entryPrice: t.entryPrice,
        entryTime: t.entryTime.toISOString(),
        intendedSize: t.intendedSize,
        status: t.status,
        createdAt: t.createdAt.toISOString(),
      })),
    });
  } catch (e) {
    console.error("[GET /api/paper-trading/open]", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Open trades fetch failed" },
      { status: 500 }
    );
  }
}
