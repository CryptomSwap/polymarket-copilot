import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";

export const dynamic = "force-dynamic";

/**
 * GET /api/live/events
 * Recent live events (user-feed, market-feed). Query: limit (default 50), source.
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
  const limit = Math.min(Number(searchParams.get("limit")) || 50, 200);
  const source = searchParams.get("source") ?? undefined;

  const where = {
    funderAddress: funder.toLowerCase(),
    ...(source && { source: source as "user-feed" | "market-feed" }),
  };

  const events = await prisma.liveEvent.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  return NextResponse.json({
    events: events.map((e) => ({
      id: e.id,
      source: e.source,
      eventType: e.eventType,
      polymarketOrderId: e.polymarketOrderId,
      assetId: e.assetId,
      marketId: e.marketId,
      payloadJson: e.payloadJson,
      createdAt: e.createdAt.toISOString(),
    })),
  });
}
