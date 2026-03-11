import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";

export const dynamic = "force-dynamic";

/**
 * GET /api/live/alerts
 * Drift alerts. Query: resolved (default false for active only), limit (default 50).
 */
export async function GET(request: Request) {
  const funder = await getFunderForRecompute();
  if (!funder) {
    return NextResponse.json(
      { error: "No funder address. Connect wallet and save connection." },
      { status: 400 }
    );
  }

  const { searchParams } = new URL(request.url);
  const resolvedParam = searchParams.get("resolved");
  const resolved = resolvedParam === "true" ? true : resolvedParam === "false" ? false : undefined;
  const limit = Math.min(Number(searchParams.get("limit")) || 50, 200);

  const where = {
    funderAddress: funder.toLowerCase(),
    ...(resolved !== undefined && { resolved }),
  };

  const alerts = await prisma.driftAlert.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  return NextResponse.json({
    alerts: alerts.map((a) => ({
      id: a.id,
      alertType: a.alertType,
      severity: a.severity,
      message: a.message,
      detailsJson: a.detailsJson,
      polymarketOrderId: a.polymarketOrderId,
      assetId: a.assetId,
      marketId: a.marketId,
      resolved: a.resolved,
      createdAt: a.createdAt.toISOString(),
      updatedAt: a.updatedAt.toISOString(),
    })),
  });
}
