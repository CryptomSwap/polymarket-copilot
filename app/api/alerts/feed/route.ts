import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";
import { getPortfolioIntelligence } from "@/lib/portfolio/intelligence";
import { getAlertFeed, type DriftAlertRowForFeed } from "@/lib/alerts/engine";

export const dynamic = "force-dynamic";

/**
 * GET /api/alerts/feed
 * Merged alert feed: drift alerts (persisted) + engine alerts (computed from portfolio intelligence).
 * Query: resolved (default false), limit (default 50), source (all | drift | engine).
 * Existing GET /api/live/alerts and POST /api/live/alerts/resolve remain unchanged.
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
  const sourceParam = (searchParams.get("source") ?? "all").toLowerCase();
  const source =
    sourceParam === "engine" ? "engine" : sourceParam === "drift" ? "drift" : "all";

  let driftAlerts: DriftAlertRowForFeed[] = [];
  if (source === "drift" || source === "all") {
    const where = {
      funderAddress: funder.toLowerCase(),
      ...(resolved !== undefined && { resolved }),
    };
    const rows = await prisma.driftAlert.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    driftAlerts = rows.map((a) => ({
      id: a.id,
      alertType: a.alertType,
      severity: a.severity,
      message: a.message,
      polymarketOrderId: a.polymarketOrderId,
      assetId: a.assetId,
      marketId: a.marketId,
      resolved: a.resolved,
      createdAt: a.createdAt,
    }));
  }

  let intelligence: Awaited<ReturnType<typeof getPortfolioIntelligence>> | null = null;
  if (source === "engine" || source === "all") {
    try {
      intelligence = await getPortfolioIntelligence({ funderAddress: funder });
    } catch {
      // Engine alerts omitted on intelligence failure; drift still returned
    }
  }

  const alerts = getAlertFeed({
    funderAddress: funder,
    driftAlerts,
    intelligence: intelligence ?? undefined,
    source,
    limit,
  });

  return NextResponse.json({ alerts });
}
