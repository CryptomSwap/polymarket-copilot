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
 * GET /api/orders/reconciliation-summary
 * Returns reconciliation snapshots plus summary: mismatch count, partial fill count, avg effective slippage.
 */
export async function GET(request: Request) {
  const funder = await getFunderForRecompute();
  if (!funder) {
    return NextResponse.json(
      { error: "No funder address. Connect wallet and save connection." },
      { status: 400 }
    );
  }

  const snapshots = await prisma.orderReconciliationSnapshot.findMany({
    where: { funderAddress: funder },
    orderBy: { updatedAt: "desc" },
    take: 100,
  });

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
        where: { funderAddress: funder, polymarketOrderId: s.polymarketOrderId },
      });
      if (exec) {
        const limitPrice = parseNum(exec.price);
        if (limitPrice > 0) {
          const slip = (avgFill - limitPrice) / limitPrice;
          slippageValues.push(slip);
        }
      }
    }
  }
  const avgSlippage = slippageValues.length > 0
    ? slippageValues.reduce((a, b) => a + b, 0) / slippageValues.length
    : null;

  return NextResponse.json({
    snapshots: snapshots.map((s) => ({
      id: s.id,
      polymarketOrderId: s.polymarketOrderId,
      localStatus: s.localStatus,
      remoteStatus: s.remoteStatus,
      filledSize: s.filledSize,
      remainingSize: s.remainingSize,
      avgFillPrice: s.avgFillPrice,
      mismatch: s.mismatch,
      detailsJson: s.detailsJson,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
    })),
    summary: {
      total: snapshots.length,
      mismatchCount,
      partialFillCount,
      avgEffectiveSlippage: avgSlippage,
    },
  });
}
