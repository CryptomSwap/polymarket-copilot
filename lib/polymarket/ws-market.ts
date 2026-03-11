/**
 * WebSocket client for Polymarket market updates (orderbook, price_change, last_trade_price).
 * Connects to wss://ws-subscriptions-clob.polymarket.com/ws/market, subscribes by asset IDs,
 * reconnect with exponential backoff, heartbeat (PING every 10s), status persisted.
 * Dynamic subscribe/unsubscribe when tracked asset set changes.
 * Exposes real connection state (connecting, open, reconnecting, closed) and timestamps.
 */

import { updateWsStatus } from "@/lib/live/status";
import { handleMarketFeedMessage } from "@/lib/live/handlers";
import type { StreamConnectionState } from "@/lib/runtime/stream-connection-state";
import { createInitialStreamConnectionState } from "@/lib/runtime/stream-connection-state";

export type MarketWsMessage = {
  type?: string;
  event_type?: string;
  market?: string;
  asset_id?: string;
  payload?: unknown;
};

const MARKET_WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 30000;
const DEFAULT_MAX_RETRIES = 10;
const HEARTBEAT_INTERVAL_MS = 10000;
const MARKET_FEED_FUNDER = "system";

/**
 * Create market WebSocket. Reconnect with exponential backoff; persist status and events.
 * After connect, sends initial subscription with assets_ids; supports dynamic subscribe/unsubscribe.
 */
export function createMarketWs(
  initialAssetIds: string[],
  opts?: { funderAddress?: string }
): {
  setTrackedAssetIds: (assetIds: string[]) => void;
  subscribe: (ids: string[]) => void;
  unsubscribe: (ids: string[]) => void;
  onMessage: (handler: (msg: MarketWsMessage) => void) => void;
  close: () => void;
  connect: () => Promise<void>;
} {
  const funder = opts?.funderAddress ?? MARKET_FEED_FUNDER;
  let trackedAssetIds = Array.from(new Set(initialAssetIds));
  let messageHandler: ((msg: MarketWsMessage) => void) | null = null;
  let ws: WebSocket | null = null;
  let retryCount = 0;
  let closed = false;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  const connectionState: StreamConnectionState = createInitialStreamConnectionState();
  function getConnectionState(): StreamConnectionState {
    return {
      ...connectionState,
      lastOpenAt: connectionState.lastOpenAt ? new Date(connectionState.lastOpenAt.getTime()) : null,
      lastMessageAt: connectionState.lastMessageAt ? new Date(connectionState.lastMessageAt.getTime()) : null,
      lastErrorAt: connectionState.lastErrorAt ? new Date(connectionState.lastErrorAt.getTime()) : null,
    };
  }

  function getBackoffDelay(): number {
    const delay = Math.min(DEFAULT_BASE_DELAY_MS * 2 ** retryCount, DEFAULT_MAX_DELAY_MS);
    retryCount = Math.min(retryCount + 1, DEFAULT_MAX_RETRIES);
    return delay;
  }

  function clearHeartbeat(): void {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function send(data: unknown): void {
    if (!ws || ws.readyState !== 1) return;
    try {
      const payload = typeof data === "string" ? data : JSON.stringify(data);
      ws.send(payload);
    } catch (e) {
      console.warn("[ws-market] send failed", e);
    }
  }

  function sendInitialSubscription(): void {
    if (trackedAssetIds.length === 0) return;
    send({
      assets_ids: trackedAssetIds,
      type: "market",
      custom_feature_enabled: true,
    });
  }

  function sendSubscribe(ids: string[]): void {
    const filtered = ids.filter((id) => id.trim().length > 0);
    if (filtered.length === 0) return;
    send({ assets_ids: filtered, operation: "subscribe" });
  }

  function sendUnsubscribe(ids: string[]): void {
    const filtered = ids.filter((id) => id.trim().length > 0);
    if (filtered.length === 0) return;
    send({ assets_ids: filtered, operation: "unsubscribe" });
  }

  async function connect(): Promise<void> {
    if (closed) return;
    const WS =
      typeof WebSocket !== "undefined"
        ? WebSocket
        : (global as unknown as { WebSocket?: typeof WebSocket }).WebSocket;
    if (!WS) return Promise.reject(new Error("WebSocket not available"));

    connectionState.status = "connecting";
    connectionState.lastErrorAt = null;
    connectionState.lastError = null;

    return new Promise((resolve, reject) => {
      try {
        ws = new WS(MARKET_WS_URL);
      } catch (e) {
        connectionState.status = "closed";
        connectionState.lastErrorAt = new Date();
        connectionState.lastError = String(e);
        void updateWsStatus(funder, "market-feed", { connected: false, lastError: String(e) });
        reject(e);
        return;
      }

      ws.onopen = () => {
        retryCount = 0;
        clearHeartbeat();
        connectionState.status = "open";
        connectionState.lastOpenAt = new Date();
        connectionState.lastMessageAt = new Date();
        connectionState.lastErrorAt = null;
        connectionState.lastError = null;
        void updateWsStatus(funder, "market-feed", { connected: true, lastError: null });
        sendInitialSubscription();
        heartbeatTimer = setInterval(() => {
          send("PING");
          connectionState.lastMessageAt = new Date();
          void updateWsStatus(funder, "market-feed", {
            connected: true,
            lastHeartbeatAt: new Date(),
            lastMessageAt: new Date(),
          });
        }, HEARTBEAT_INTERVAL_MS);
        resolve();
      };

      ws.onmessage = (event) => {
        connectionState.lastMessageAt = new Date();
        try {
          const raw = event.data;
          if (raw === "PONG" || (typeof raw === "string" && raw.trim() === "PONG")) {
            void updateWsStatus(funder, "market-feed", { connected: true, lastMessageAt: new Date() });
            return;
          }
          const data = typeof raw === "string" ? JSON.parse(raw) : raw;
          if (messageHandler) messageHandler(data as MarketWsMessage);
          void handleMarketFeedMessage(funder, data);
        } catch {
          /* ignore parse errors */
        }
      };

      ws.onerror = () => {
        connectionState.lastErrorAt = new Date();
        connectionState.lastError = "WebSocket error";
        void updateWsStatus(funder, "market-feed", { connected: true, lastError: "WebSocket error" });
      };

      ws.onclose = () => {
        clearHeartbeat();
        ws = null;
        const willReconnect = !closed && retryCount < DEFAULT_MAX_RETRIES;
        connectionState.status = willReconnect ? "reconnecting" : "closed";
        if (willReconnect) {
          connectionState.reconnectAttempts += 1;
          setTimeout(() => connect().catch(() => {}), getBackoffDelay());
        }
        void updateWsStatus(funder, "market-feed", { connected: false });
      };
    });
  }

  function setTrackedAssetIds(assetIds: string[]): void {
    const next = Array.from(new Set(assetIds));
    const prevSet = new Set(trackedAssetIds);
    const nextSet = new Set(next);
    const toAdd = next.filter((id) => !prevSet.has(id));
    const toRemove = trackedAssetIds.filter((id) => !nextSet.has(id));
    trackedAssetIds = next;
    if (ws?.readyState === 1) {
      if (toRemove.length > 0) sendUnsubscribe(toRemove);
      if (toAdd.length > 0) sendSubscribe(toAdd);
    }
  }

  return {
    setTrackedAssetIds,
    subscribe(ids: string[]) {
      const added = ids.filter((id) => !trackedAssetIds.includes(id));
      if (added.length === 0) return;
      trackedAssetIds = Array.from(new Set([...trackedAssetIds, ...added]));
      if (ws?.readyState === 1) sendSubscribe(added);
    },
    unsubscribe(ids: string[]) {
      const set = new Set(ids);
      const before = trackedAssetIds.length;
      trackedAssetIds = trackedAssetIds.filter((id) => !set.has(id));
      if (trackedAssetIds.length < before && ws?.readyState === 1) sendUnsubscribe(ids);
    },
    onMessage(handler: (msg: MarketWsMessage) => void) {
      messageHandler = handler;
    },
    close() {
      closed = true;
      connectionState.status = "closed";
      clearHeartbeat();
      if (ws) {
        ws.close();
        ws = null;
      }
    },
    getConnectionState,
    connect,
  };
}

export type MarketWsWithState = ReturnType<typeof createMarketWs>;
