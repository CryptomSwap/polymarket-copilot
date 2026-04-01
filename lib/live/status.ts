/**
 * Persist WebSocket connection status and live events.
 * Used by ws-user and ws-market to record heartbeat, last message, and events.
 *
 * Writes are debounced/coalesced (except disconnect and errors) to reduce Prisma pool pressure.
 */

import { prisma } from "@/lib/db";

const DEBOUNCE_MS = Number(process.env.WS_STATUS_PERSIST_DEBOUNCE_MS ?? "2500") || 2500;
const LIVE_EVENT_MARKET_FEED_SAMPLE_N =
  Math.max(1, Number(process.env.LIVE_EVENT_MARKET_FEED_SAMPLE_N ?? "1")) || 1;
const LIVE_EVENT_SKIP_LOG_INTERVAL_MS = 30_000;
const ALWAYS_PERSIST_MARKET_EVENT_TYPES = new Set(["trade", "fill"]);
let marketFeedSampleCounter = 0;
let skippedLiveEventsSinceLastLog = 0;
let lastLiveEventSkipLogAtMs = 0;

type MergedWs = {
  connected: boolean;
  lastHeartbeatAt: Date | null | undefined;
  lastMessageAt: Date | null | undefined;
  lastError: string | null | undefined;
};

const pending = new Map<string, MergedWs>();
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const lastSerializedOk = new Map<string, string>();

function cacheKey(funder: string, channel: string): string {
  return `${funder}\0${channel}`;
}

function serialize(m: MergedWs): string {
  return JSON.stringify({
    c: m.connected,
    h: m.lastHeartbeatAt instanceof Date ? m.lastHeartbeatAt.toISOString() : m.lastHeartbeatAt ?? null,
    m: m.lastMessageAt instanceof Date ? m.lastMessageAt.toISOString() : m.lastMessageAt ?? null,
    e: m.lastError ?? null,
  });
}

function merge(prev: MergedWs | undefined, data: {
  connected: boolean;
  lastHeartbeatAt?: Date | null;
  lastMessageAt?: Date | null;
  lastError?: string | null;
}): MergedWs {
  const p = prev ?? {
    connected: false,
    lastHeartbeatAt: undefined,
    lastMessageAt: undefined,
    lastError: undefined,
  };
  return {
    connected: data.connected,
    lastHeartbeatAt:
      data.lastHeartbeatAt !== undefined ? data.lastHeartbeatAt : p.lastHeartbeatAt,
    lastMessageAt: data.lastMessageAt !== undefined ? data.lastMessageAt : p.lastMessageAt,
    lastError: data.lastError !== undefined ? data.lastError : p.lastError,
  };
}

async function upsertWsRow(
  funder: string,
  channel: "user-feed" | "market-feed",
  m: MergedWs
): Promise<void> {
  await prisma.websocketConnectionStatus.upsert({
    where: {
      funderAddress_channel: { funderAddress: funder, channel },
    },
    create: {
      funderAddress: funder,
      channel,
      connected: m.connected,
      lastHeartbeatAt: m.lastHeartbeatAt ?? undefined,
      lastMessageAt: m.lastMessageAt ?? undefined,
      lastError: m.lastError ?? undefined,
    },
    update: {
      connected: m.connected,
      ...(m.lastHeartbeatAt !== undefined && { lastHeartbeatAt: m.lastHeartbeatAt }),
      ...(m.lastMessageAt !== undefined && { lastMessageAt: m.lastMessageAt }),
      ...(m.lastError !== undefined && { lastError: m.lastError }),
    },
  });
}

async function flushKey(k: string, funder: string, channel: "user-feed" | "market-feed"): Promise<void> {
  const m = pending.get(k);
  pending.delete(k);
  if (!m) return;
  const ser = serialize(m);
  if (ser === lastSerializedOk.get(k)) return;
  try {
    await upsertWsRow(funder, channel, m);
    lastSerializedOk.set(k, ser);
  } catch (e) {
    console.error("[live/status] updateWsStatus flush failed", e);
  }
}

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
  const k = cacheKey(funder, channel);
  const merged = merge(pending.get(k), data);
  pending.set(k, merged);

  const disconnect = !data.connected;
  const errorSignal =
    data.lastError !== undefined && data.lastError !== null && String(data.lastError).length > 0;

  if (disconnect || errorSignal) {
    const t = debounceTimers.get(k);
    if (t) {
      clearTimeout(t);
      debounceTimers.delete(k);
    }
    try {
      await flushKey(k, funder, channel);
    } catch (e) {
      console.error("[live/status] updateWsStatus failed", e);
    }
    return;
  }

  const t = debounceTimers.get(k);
  if (t) clearTimeout(t);
  debounceTimers.set(
    k,
    setTimeout(() => {
      debounceTimers.delete(k);
      void flushKey(k, funder, channel);
    }, DEBOUNCE_MS)
  );
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
  if (params.source === "market-feed" && LIVE_EVENT_MARKET_FEED_SAMPLE_N > 1) {
    const normalizedType = params.eventType.toLowerCase();
    if (!ALWAYS_PERSIST_MARKET_EVENT_TYPES.has(normalizedType)) {
      marketFeedSampleCounter += 1;
      if (marketFeedSampleCounter % LIVE_EVENT_MARKET_FEED_SAMPLE_N !== 0) {
        skippedLiveEventsSinceLastLog += 1;
        const nowMs = Date.now();
        if (nowMs - lastLiveEventSkipLogAtMs >= LIVE_EVENT_SKIP_LOG_INTERVAL_MS) {
          lastLiveEventSkipLogAtMs = nowMs;
          console.warn("[live/events] market-feed persistence sampled", {
            sampleEveryN: LIVE_EVENT_MARKET_FEED_SAMPLE_N,
            skippedSinceLastLog: skippedLiveEventsSinceLastLog,
          });
          skippedLiveEventsSinceLastLog = 0;
        }
        return;
      }
    }
  }

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
