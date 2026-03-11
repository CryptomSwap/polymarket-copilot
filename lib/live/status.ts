/**
 * Persist WebSocket connection status and live events.
 * Used by ws-user and ws-market to record heartbeat, last message, and events.
 */

import { prisma } from "@/lib/db";

export async function updateWsStatus(
  funderAddress: string,
  channel: "user-feed" | "market-feed",
  data: {
    connected: boolean;
    lastHeartbeatAt?: Date | null;
    lastMessageAt?: Date | null;
    lastError?: string | null;
  }
): Promise<void> {
  const funder = funderAddress.toLowerCase();
  try {
    await prisma.websocketConnectionStatus.upsert({
      where: {
        funderAddress_channel: { funderAddress: funder, channel },
      },
      create: {
        funderAddress: funder,
        channel,
        connected: data.connected,
        lastHeartbeatAt: data.lastHeartbeatAt ?? undefined,
        lastMessageAt: data.lastMessageAt ?? undefined,
        lastError: data.lastError ?? undefined,
      },
      update: {
        connected: data.connected,
        ...(data.lastHeartbeatAt !== undefined && { lastHeartbeatAt: data.lastHeartbeatAt }),
        ...(data.lastMessageAt !== undefined && { lastMessageAt: data.lastMessageAt }),
        ...(data.lastError !== undefined && { lastError: data.lastError }),
      },
    });
  } catch (e) {
    console.error("[live/status] updateWsStatus failed", e);
  }
}

export async function persistLiveEvent(params: {
  funderAddress: string;
  source: "user-feed" | "market-feed";
  eventType: string;
  payloadJson?: string | null;
  polymarketOrderId?: string | null;
  assetId?: string | null;
  marketId?: string | null;
}): Promise<void> {
  const funder = params.funderAddress.toLowerCase();
  try {
    await prisma.liveEvent.create({
      data: {
        funderAddress: funder,
        source: params.source,
        eventType: params.eventType,
        payloadJson: params.payloadJson ?? undefined,
        polymarketOrderId: params.polymarketOrderId ?? undefined,
        assetId: params.assetId ?? undefined,
        marketId: params.marketId ?? undefined,
      },
    });
  } catch (e) {
    console.error("[live/events] persistLiveEvent failed", e);
  }
}
