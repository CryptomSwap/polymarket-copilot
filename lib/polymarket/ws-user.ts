/**
 * Server-side user WebSocket: authenticate with stored L2 credentials only.
 * Reconnect with exponential backoff; heartbeat and connection status persisted to DB.
 * Polymarket CLOB user channel: wss://ws-subscriptions-clob.polymarket.com/ws/user
 * Auth via subscription message (auth.apiKey, auth.secret, auth.passphrase) after connect, not query params.
 * Exposes real connection state (connecting, open, reconnecting, closed) and timestamps.
 */

import { getStoredCredentials } from "@/lib/polymarket/auth";
import { updateWsStatus } from "@/lib/live/status";
import { handleUserFeedMessage } from "@/lib/live/handlers";
import { normalizeUserFeedMessage } from "@/lib/live/user-feed-normalizer";
import type { StreamConnectionState } from "@/lib/runtime/stream-connection-state";
import { createInitialStreamConnectionState, cloneStreamConnectionState } from "@/lib/runtime/stream-connection-state";

/** User channel endpoint per Polymarket docs (subscription-based auth, not query params). */
const USER_WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/user";

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
/** Per Polymarket docs: send PING every 10s for user channel. */
const HEARTBEAT_INTERVAL_MS = 10000;

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
    return cloneStreamConnectionState(connectionState);
  }

  function markRealDataEvent(kind: "order" | "fill"): void {
    const now = new Date();
    connectionState.lastDataEventAt = now;
    connectionState.lastMessageAt = now;
    connectionState.lastSocketFrameAt = now;
    if (kind === "order") connectionState.lastOrderEventAt = now;
    if (kind === "fill") connectionState.lastFillEventAt = now;
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

  function sendSubscriptionMessage(sock: WebSocket, creds: { apiKey: string; secret: string; passphrase: string }): void {
    const payload = {
      auth: {
        apiKey: creds.apiKey,
        secret: creds.secret,
        passphrase: creds.passphrase,
      },
      markets: [] as string[],
      type: "user",
    };
    sock.send(JSON.stringify(payload));
  }

  async function connect(): Promise<void> {
    if (closed) {
      log("warn", "connect called after close", {});
      return;
    }
    const { credential: creds } = await getStoredCredentials();
    if (!creds) {
      log("error", "No stored L2 credentials; cannot authenticate user WS", {});
      return;
    }
    const funder = creds.funderAddress;
    const credentialId = creds.credentialId ?? "(unknown)";
    const authPresent = {
      apiKey: Boolean(creds.apiKey?.trim()),
      secret: Boolean(creds.secret?.trim()),
      passphrase: Boolean(creds.passphrase?.trim()),
    };
    log("info", "User WS auth attempted: connecting with stored L2 credentials", {
      url: USER_WS_URL,
      funderAddress: funder,
      credentialId,
      authPresent,
    });

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
        ws = new WS(USER_WS_URL);
      } catch (e) {
        connectionState.status = "closed";
        connectionState.lastErrorAt = new Date();
        connectionState.lastError = String(e);
        log("error", "User WS constructor failed", {
          error: String(e),
          funderAddress: funder,
          credentialId,
        });
        void updateWsStatus(funder, "user-feed", { connected: false, lastError: String(e) });
        reject(e);
        return;
      }

      ws.onopen = () => {
        retryCount = 0;
        clearHeartbeat();
        try {
          sendSubscriptionMessage(ws!, creds);
        } catch (e) {
          log("error", "User WS failed to send auth subscription", {
            error: String(e),
            funderAddress: funder,
            credentialId,
          });
          connectionState.lastErrorAt = new Date();
          connectionState.lastError = String(e);
          void updateWsStatus(funder, "user-feed", { connected: false, lastError: String(e) });
          reject(e);
          return;
        }
        connectionState.status = "open";
        const nowOpen = new Date();
        connectionState.lastOpenAt = nowOpen;
        connectionState.lastMessageAt = nowOpen;
        connectionState.lastSocketFrameAt = nowOpen;
        connectionState.lastErrorAt = null;
        connectionState.lastError = null;
        log("info", "User WebSocket opened and auth subscription sent", { funderAddress: funder, credentialId });
        void updateWsStatus(funder, "user-feed", { connected: true, lastError: null });
        heartbeatTimer = setInterval(() => {
          if (ws?.readyState === 1) {
            ws.send("PING");
          }
          connectionState.lastHeartbeatAt = new Date();
          void updateWsStatus(funder, "user-feed", { connected: true, lastHeartbeatAt: connectionState.lastHeartbeatAt ?? undefined });
        }, HEARTBEAT_INTERVAL_MS);
        resolve();
      };

      ws.onmessage = (event) => {
        const now = new Date();
        connectionState.lastMessageAt = now;
        connectionState.lastSocketFrameAt = now;
        const raw = event.data;
        if (raw === "PONG" || (typeof raw === "string" && raw.trim() === "PONG")) {
          connectionState.lastHeartbeatAt = now;
          void updateWsStatus(funder, "user-feed", { connected: true, lastHeartbeatAt: now });
          return;
        }
        try {
          const data = typeof raw === "string" ? JSON.parse(raw) : raw;
          const msg = data as UserWsMessage;
          const norm = normalizeUserFeedMessage(funder, data);
          if (norm?.lifecycle) {
            const k = norm.lifecycle.kind;
            markRealDataEvent(k === "fill" || k === "partial_fill" ? "fill" : "order");
          } else if (norm?.positionFill) {
            markRealDataEvent("fill");
          } else {
            const type = (msg.type ?? "").toString().toUpperCase();
            const eventType = (
              typeof (data as Record<string, unknown>).event_type === "string"
                ? (data as Record<string, unknown>).event_type
                : type
            )
              .toString()
              .toLowerCase();
            if (
              type === "PLACEMENT" ||
              type === "ORDER" ||
              eventType === "order" ||
              type === "CANCELLATION" ||
              type === "UPDATE"
            ) {
              markRealDataEvent("order");
            } else if (type === "TRADE" || eventType === "trade" || eventType === "fill" || type === "FILL") {
              markRealDataEvent("fill");
            }
          }
          if (messageHandler) {
            messageHandler(msg);
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
        log("error", "User WS error", {
          message: errMsg,
          funderAddress: funder,
          credentialId,
          codeHint: "Check for non-101 (auth failure) if handshake never completed",
        });
        void updateWsStatus(funder, "user-feed", { connected: true, lastError: errMsg });
      };

      ws.onclose = (event) => {
        clearHeartbeat();
        log("info", "User WS closed", {
          code: event.code,
          reason: event.reason || undefined,
          wasClean: event.wasClean,
          funderAddress: funder,
          credentialId,
        });
        if (event.code !== 1000 && event.code !== 1001) {
          log("warn", "User WS closed with non-normal code; may indicate auth or server rejection", {
            code: event.code,
            reason: event.reason || undefined,
            funderAddress: funder,
            credentialId,
          });
        }
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
