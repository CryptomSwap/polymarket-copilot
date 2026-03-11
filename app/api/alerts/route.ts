import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";

export const dynamic = "force-dynamic";

/**
 * GET /api/alerts
 * List Copilot Alert Engine v1 alerts for the connected funder.
 * Query: unreadOnly (default false), limit (default 50), type (optional filter).
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
  const unreadOnly = searchParams.get("unreadOnly") === "true";
  const limit = Math.min(Number(searchParams.get("limit")) || 50, 200);
  const type = searchParams.get("type") ?? undefined;

  const where = {
    funderAddress: funder.toLowerCase(),
    ...(unreadOnly && { isRead: false }),
    ...(type && { type }),
  };

  const alerts = await prisma.copilotAlert.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  const unreadCount = await prisma.copilotAlert.count({
    where: { funderAddress: funder.toLowerCase(), isRead: false },
  });

  return NextResponse.json({
    alerts: alerts.map((a) => ({
      id: a.id,
      type: a.type,
      severity: a.severity,
      title: a.title,
      message: a.message,
      marketId: a.marketId,
      recommendationId: a.recommendationId,
      assetId: a.assetId,
      metadata: a.metadata,
      isRead: a.isRead,
      createdAt: a.createdAt.toISOString(),
      updatedAt: a.updatedAt.toISOString(),
    })),
    unreadCount,
  });
}
