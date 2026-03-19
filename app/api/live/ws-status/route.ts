import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";

export const dynamic = "force-dynamic";

/**
 * GET /api/live/ws-status
 * WebSocket connection status for user-feed and market-feed.
 */
export async function GET(request: Request) {
  const funder = await getFunderForRecompute();
  if (!funder) {
    return NextResponse.json(
      { error: "No funder address. Connect wallet and save connection." },
      { status: 400 }
    );
  }

  const statuses = await prisma.websocketConnectionStatus.findMany({
    where: {
      funderAddress: funder.toLowerCase(),
    },
  });

  const byChannel = statuses.reduce(
    (acc, s) => {
      acc[s.channel] = {
        connected: s.connected,
        lastHeartbeatAt: s.lastHeartbeatAt?.toISOString() ?? null,
        lastMessageAt: s.lastMessageAt?.toISOString() ?? null,
        lastError: s.lastError,
        updatedAt: s.updatedAt.toISOString(),
      };
      return acc;
    },
    {} as Record<string, { connected: boolean; lastHeartbeatAt: string | null; lastMessageAt: string | null; lastError: string | null; updatedAt: string }>
  );

  return NextResponse.json({
    funderAddress: funder,
    channels: byChannel,
    userFeed: byChannel["user-feed"] ?? { connected: false, lastHeartbeatAt: null, lastMessageAt: null, lastError: null, updatedAt: new Date().toISOString() },
    marketFeed: byChannel["market-feed"] ?? { connected: false, lastHeartbeatAt: null, lastMessageAt: null, lastError: null, updatedAt: new Date().toISOString() },
    /** For connection vs heartbeat vs real data vs reconciled vs safeToAutomate, use GET /api/live/stream-health (includes operatorHealth when runtime is running). */
    streamHealthUrl: "/api/live/stream-health",
  });
}
