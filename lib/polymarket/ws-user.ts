/**
 * Server-side user WebSocket: authenticate with stored L2 credentials only.
 * Reconnect with exponential backoff; heartbeat and connection status persisted to DB.
 * Polymarket CLOB WS: wss://clob.polymarket.com/ws with api_key and passphrase.
 * Exposes real connection state (connecting, open, reconnecting, closed) and timestamps.
 */

import { getStoredCredentials } from "@/lib/polymarket/auth";
import { updateWsStatus } from "@/lib/live/status";
import { handleUserFeedMessage } from "@/lib/live/handlers";
import type { StreamConnectionState } from "@/lib/runtime/stream-connection-state";
import { createInitialStreamConnectionState } from "@/lib/runtime/stream-connection-state";

export type UserWsMessage = {
  type: string;
  payload?: unknown;
};

export type WsUserLogLevel = "debug" | "info" | "warn" | "error";

export interface WsUserLogHook {
  (level: WsUserLogLevel, message: string, meta?: Record<string, unknown>): void;
}

const noopLog: WsUserLogHook = () => {};

/**
 * Default structured log: console with level and meta.
 */
export function defaultWsUserLog(level: WsUserLogLevel, message: string, meta?: Record<string, unknown>): void {
  const line = meta ? `${message} ${JSON.stringify(meta)}` : message;
  switch (level) {
    case "debug":
      console.debug("[ws-user]", line);
      break;
    case "info":
      console.info("[ws-user]", line);
      break;
    case "warn":
      console.warn("[ws-user]", line);
      break;
    case "error":
      console.error("[ws-user]", line);
      break;
  }
}

const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 30000;
const DEFAULT_MAX_RETRIES = 10;
const HEARTBEAT_INTERVAL_MS = 30000;

/**
 * Create user WebSocket client authenticated with stored L2 creds only (no signer).
 * Reconnect with exponential backoff. Persists connection status and live events.
 * Server-side only.
 */
export function createUserWs(opts?: {
  log?: WsUserLogHook;
  baseDelayMs?: number;
  maxDelayMs?: number;
  maxRetries?: number;
}): {
  onMessage: (handler: (msg: UserWsMessage) => void) => void;
  close: () => void;
  connect: () => Promise<void>;
} {
  const log = opts?.log ?? noopLog;
  const baseDelayMs = opts?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = opts?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const maxRetries = opts?.maxRetries ?? DEFAULT_MAX_RETRIES;

  let messageHandler: ((msg: UserWsMessage) => void) | null = null;
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
    const delay = Math.min(baseDelayMs * 2 ** retryCount, maxDelayMs);
    retryCount = Math.min(retryCount + 1, maxRetries);
    return delay;
  }

  function clearHeartbeat(): void {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  async function connect(): Promise<void> {
    if (closed) {
      log("warn", "connect called after close", {});
      return;
    }
    const creds = await getStoredCredentials();
    if (!creds) {
      log("error", "No stored L2 credentials; cannot authenticate user WS", {});
      return;
    }
    const funder = creds.funderAddress;

    const wsUrl = "wss://clob.polymarket.com/ws";
    const urlWithAuth = `${wsUrl}?api_key=${encodeURIComponent(creds.apiKey)}&passphrase=${encodeURIComponent(creds.passphrase)}`;
    log("info", "Connecting user WS", { url: wsUrl });

    const WS = typeof WebSocket !== "undefined" ? WebSocket : (global as unknown as { WebSocket?: typeof WebSocket }).WebSocket;
    if (!WS) {
      log("error", "WebSocket not available (e.g. polyfill with ws package in Node)", {});
      return Promise.reject(new Error("WebSocket not available"));
    }

    connectionState.status = "connecting";
    connectionState.lastErrorAt = null;
    connectionState.lastError = null;

    return new Promise((resolve, reject) => {
      try {
        ws = new WS(urlWithAuth);
      } catch (e) {
        connectionState.status = "closed";
        connectionState.lastErrorAt = new Date();
        connectionState.lastError = String(e);
        log("error", "WebSocket constructor failed", { error: String(e) });
        void updateWsStatus(funder, "user-feed", { connected: false, lastError: String(e) });
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
        log("info", "User WS connected", {});
        void updateWsStatus(funder, "user-feed", { connected: true, lastError: null });
        heartbeatTimer = setInterval(() => {
          connectionState.lastMessageAt = new Date();
          void updateWsStatus(funder, "user-feed", { connected: true, lastHeartbeatAt: new Date(), lastMessageAt: new Date() });
        }, HEARTBEAT_INTERVAL_MS);
        resolve();
      };

      ws.onmessage = (event) => {
        connectionState.lastMessageAt = new Date();
        try {
          const data = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
          if (messageHandler) {
            messageHandler(data as UserWsMessage);
          }
          void handleUserFeedMessage(funder, data);
        } catch (e) {
          log("warn", "User WS message parse error", { error: String(e) });
        }
      };

      ws.onerror = (event) => {
        const errMsg = (event as unknown as { message?: string }).message ?? "Unknown error";
        connectionState.lastErrorAt = new Date();
        connectionState.lastError = errMsg;
        log("error", "User WS error", { type: (event as unknown as { type?: string }).type });
        void updateWsStatus(funder, "user-feed", { connected: true, lastError: errMsg });
      };

      ws.onclose = (event) => {
        clearHeartbeat();
        log("info", "User WS closed", { code: event.code, reason: event.reason });
        ws = null;
        const willReconnect = !closed && retryCount < maxRetries;
        connectionState.status = willReconnect ? "reconnecting" : "closed";
        if (willReconnect) {
          connectionState.reconnectAttempts += 1;
          const delay = getBackoffDelay();
          log("info", "User WS reconnect scheduled", { delayMs: delay, retryCount });
          setTimeout(() => connect().catch(() => {}), delay);
        }
        void updateWsStatus(funder, "user-feed", { connected: false });
      };
    });
  }

  return {
    onMessage(handler: (msg: UserWsMessage) => void) {
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
      log("info", "User WS client closed", {});
    },
    getConnectionState,
    connect,
  };
}
