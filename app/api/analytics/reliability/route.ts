import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";

export const dynamic = "force-dynamic";

function parseNum(s: string | null | undefined): number {
  if (s == null || s === "") return 0;
  const n = parseFloat(String(s).trim());
  return Number.isFinite(n) ? n : 0;
}

/**
 * GET /api/analytics/reliability
 * Preflight pass rate, reconciliation mismatch count, partial fill count, avg effective slippage, recent post-trade notes.
 */
export async function GET(request: Request) {
  const funder = await getFunderForRecompute();
  if (!funder) {
    return NextResponse.json(
      { error: "No funder address. Connect wallet and save connection." },
      { status: 400 }
    );
  }

  const f = funder.toLowerCase();
  const [preflights, snapshots, journalEntries] = await Promise.all([
    prisma.tradePreflightCheck.findMany({
      where: { funderAddress: f },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
    prisma.orderReconciliationSnapshot.findMany({
      where: { funderAddress: f },
    }),
    prisma.postTradeJournalEntry.findMany({
      where: { funderAddress: f },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
  ]);

  const preflightPassCount = preflights.filter((p) => p.passed).length;
  const preflightPassRate = preflights.length > 0 ? preflightPassCount / preflights.length : null;

  const mismatchCount = snapshots.filter((s) => s.mismatch).length;
  const partialFillCount = snapshots.filter((s) => {
    const filled = parseNum(s.filledSize);
    const remaining = parseNum(s.remainingSize);
    return filled > 0 && remaining > 0;
  }).length;

  const slippageValues: number[] = [];
  for (const s of snapshots) {
    const filled = parseNum(s.filledSize);
    const avgFill = parseNum(s.avgFillPrice);
    if (filled > 0 && avgFill > 0) {
      const exec = await prisma.executedOrder.findFirst({
        where: { funderAddress: f, polymarketOrderId: s.polymarketOrderId },
      });
      if (exec) {
        const limitPrice = parseNum(exec.price);
        if (limitPrice > 0) slippageValues.push((avgFill - limitPrice) / limitPrice);
      }
    }
  }
  const avgEffectiveSlippage = slippageValues.length > 0
    ? slippageValues.reduce((a, b) => a + b, 0) / slippageValues.length
    : null;

  return NextResponse.json({
    preflightPassRate,
    preflightTotal: preflights.length,
    preflightPassCount,
    reconciliationMismatchCount: mismatchCount,
    reconciliationTotal: snapshots.length,
    partialFillCount,
    avgEffectiveSlippage,
    recentPostTradeNotes: journalEntries.map((e) => ({
      id: e.id,
      recommendationId: e.recommendationId,
      executedOrderId: e.executedOrderId,
      note: e.note,
      tag: e.tag,
      createdAt: e.createdAt.toISOString(),
    })),
  });
}
