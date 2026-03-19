import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";
import {
  getLiveOfficialOpenOrders,
  getOrdersReconciliationDiagnostics,
  type LocalOpenOrderRow,
} from "@/lib/portfolio/live-open-orders-service";

export const dynamic = "force-dynamic";

/**
 * GET /api/portfolio/orders-reconciliation-debug
 * Compares live official open orders (CLOB) with local UserOrder table.
 * Returns counts, missing ids, status mismatches, and sample diffs.
 * Diagnostics only; no auto-repair.
 */
export async function GET() {
  const funder = await getFunderForRecompute();
  if (!funder) {
    return NextResponse.json(
      { error: "No funder address. Connect wallet and save connection." },
      { status: 400 }
    );
  }

  const liveResult = await getLiveOfficialOpenOrders(funder);
  const localRows = await prisma.userOrder.findMany({
    where: { funderAddress: funder },
  });

  const localOrders: LocalOpenOrderRow[] = localRows.map((r) => ({
    orderId: r.orderId,
    marketId: r.market,
    assetId: r.assetId,
    side: r.side,
    status: r.status,
    sizeMatched: r.sizeMatched,
    originalSize: r.originalSize,
    price: r.price,
  }));

  const diagnostics = getOrdersReconciliationDiagnostics(
    liveResult.orders,
    localOrders,
    liveResult.metadata.success,
    liveResult.metadata.asOf
  );

  return NextResponse.json({
    funderAddress: funder,
    note: "Compares live CLOB open orders vs local UserOrder table. No auto-repair.",
    ...diagnostics,
  });
}
