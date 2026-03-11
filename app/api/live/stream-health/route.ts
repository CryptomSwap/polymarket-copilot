import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";
import { getStreamSyncState } from "@/lib/live/streaming-sync";

export const dynamic = "force-dynamic";

const MARKET_FEED_FUNDER = "system";

/**
 * GET /api/live/stream-health
 * Internal health/status for Streaming Sync Layer v1:
 * user stream connected, market stream connected, tracked asset count,
 * last event time, last reconciliation time.
 */
export async function GET() {
  const funder = await getFunderForRecompute();
  const [userRow, marketRow, syncState] = await Promise.all([
    funder
      ? prisma.websocketConnectionStatus.findUnique({
          where: { funderAddress_channel: { funderAddress: funder.toLowerCase(), channel: "user-feed" } },
        })
      : null,
    prisma.websocketConnectionStatus.findUnique({
      where: { funderAddress_channel: { funderAddress: MARKET_FEED_FUNDER, channel: "market-feed" } },
    }),
    getStreamSyncState(),
  ]);

  return NextResponse.json({
    userStreamConnected: userRow?.connected ?? false,
    marketStreamConnected: marketRow?.connected ?? false,
    trackedAssetCount: syncState?.trackedAssetCount ?? 0,
    lastEventAt: syncState?.lastEventAt?.toISOString() ?? null,
    lastReconciliationAt: syncState?.lastReconciliationAt?.toISOString() ?? null,
    updatedAt: syncState?.updatedAt?.toISOString() ?? null,
  });
}
