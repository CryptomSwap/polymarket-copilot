/**
 * Live event handlers: parse WS payloads, persist LiveEvent, trigger reconciliation and drift checks.
 * No autonomous trading or exits; monitoring and sync only.
 */

import { persistLiveEvent, updateWsStatus } from "./status";
import { checkLocalOpenVsRemote, checkRemoteFillNoLocalOrder } from "./drift";
import { onStreamEvent } from "./streaming-sync";

export interface ParsedUserEvent {
  eventType: string;
  orderId?: string;
  assetId?: string;
  marketId?: string;
  status?: string;
  size?: string;
  sizeMatched?: string;
  payload?: unknown;
}

/**
 * Parse a user-feed message into a structured event. Safe parsing; returns null if unknown shape.
 */
export function parseUserFeedMessage(data: unknown): ParsedUserEvent | null {
  if (data == null || typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;
  const type = typeof obj.type === "string" ? obj.type : typeof obj.event === "string" ? obj.event : "";
  const payload = obj.payload ?? obj;
  const p = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const orderId = typeof p.orderID === "string" ? p.orderID : typeof p.order_id === "string" ? p.order_id : typeof p.id === "string" ? p.id : undefined;
  const assetId = typeof p.asset_id === "string" ? p.asset_id : typeof p.assetId === "string" ? p.assetId : undefined;
  const marketId = typeof p.market === "string" ? p.market : typeof p.marketId === "string" ? p.marketId : undefined;
  const status = typeof p.status === "string" ? p.status : undefined;
  const size = typeof p.size === "string" ? p.size : typeof p.size === "number" ? String(p.size) : undefined;
  const sizeMatched = typeof p.size_matched === "string" ? p.size_matched : typeof p.sizeMatched === "string" ? p.sizeMatched : undefined;
  return {
    eventType: type || "unknown",
    orderId,
    assetId,
    marketId,
    status,
    size,
    sizeMatched,
    payload: data,
  };
}

/**
 * Handle a user-feed message: persist event, update status lastMessageAt, run drift checks.
 * Call from ws-user onmessage. Fire-and-forget; does not block.
 */
export async function handleUserFeedMessage(
  funderAddress: string,
  data: unknown
): Promise<void> {
  const parsed = parseUserFeedMessage(data);
  const eventType = parsed?.eventType ?? "unknown";
  const payloadJson = typeof data === "object" ? JSON.stringify(data) : String(data);

  await persistLiveEvent({
    funderAddress,
    source: "user-feed",
    eventType,
    payloadJson,
    polymarketOrderId: parsed?.orderId ?? undefined,
    assetId: parsed?.assetId ?? undefined,
    marketId: parsed?.marketId ?? undefined,
  });

  await updateWsStatus(funderAddress, "user-feed", {
    connected: true,
    lastMessageAt: new Date(),
  });

  if (parsed?.orderId && parsed?.status) {
    void checkLocalOpenVsRemote(funderAddress, parsed.orderId, parsed.status);
  }
  if (parsed?.orderId && (eventType === "fill" || eventType === "order" || eventType === "trade")) {
    void checkRemoteFillNoLocalOrder(
      funderAddress,
      parsed.orderId,
      parsed.assetId,
      parsed.marketId
    );
  }
  onStreamEvent();
}

/**
 * Handle market-feed message: persist event, update status.
 */
export async function handleMarketFeedMessage(
  funderAddress: string,
  data: unknown
): Promise<void> {
  const obj = data != null && typeof data === "object" ? (data as Record<string, unknown>) : {};
  const eventType = typeof obj.type === "string" ? obj.type : typeof obj.event === "string" ? obj.event : "unknown";
  const payloadJson = typeof data === "object" ? JSON.stringify(data) : String(data);
  const marketId = typeof obj.market === "string" ? obj.market : typeof obj.marketId === "string" ? obj.marketId : undefined;
  const assetId = typeof (obj as Record<string, unknown>).asset_id === "string" ? (obj as Record<string, unknown>).asset_id as string : undefined;

  await persistLiveEvent({
    funderAddress,
    source: "market-feed",
    eventType,
    payloadJson,
    marketId,
    assetId,
  });

  await updateWsStatus(funderAddress, "market-feed", {
    connected: true,
    lastMessageAt: new Date(),
  });
  onStreamEvent();
}
