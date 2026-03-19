/**
 * Real WebSocket connection state for health and readiness.
 * Replaces boolean "connected" with truthful status and timestamps.
 * Freshness timestamps distinguish socket/heartbeat from real data flow.
 */

export type StreamConnectionStatus =
  | "closed"       // No socket or closed, not reconnecting
  | "connecting"   // Socket created, open not yet received
  | "open"        // Socket open and active
  | "reconnecting"; // Closed but reconnect scheduled

export interface StreamConnectionState {
  status: StreamConnectionStatus;
  lastOpenAt: Date | null;
  /** Last time any frame was received (including PONG). Kept for backward compatibility. */
  lastMessageAt: Date | null;
  lastErrorAt: Date | null;
  lastError: string | null;
  reconnectAttempts: number;
  /** Last time any socket frame was received (same as lastMessageAt when set from onmessage). */
  lastSocketFrameAt?: Date | null;
  /** Last time heartbeat (PING sent / PONG received) was observed. Not real data. */
  lastHeartbeatAt?: Date | null;
  /** Last time a real exchange data event was received (excludes PING/PONG). */
  lastDataEventAt?: Date | null;
  /** Market stream: last book (order book) event. */
  lastBookEventAt?: Date | null;
  /** Market stream: last trade event (last_trade_price, etc.). */
  lastTradeEventAt?: Date | null;
  /** User stream: last order lifecycle event (ack, cancel, etc.). */
  lastOrderEventAt?: Date | null;
  /** User stream: last fill/trade event. */
  lastFillEventAt?: Date | null;
}

export function createInitialStreamConnectionState(): StreamConnectionState {
  return {
    status: "closed",
    lastOpenAt: null,
    lastMessageAt: null,
    lastErrorAt: null,
    lastError: null,
    reconnectAttempts: 0,
    lastSocketFrameAt: null,
    lastHeartbeatAt: null,
    lastDataEventAt: null,
    lastBookEventAt: null,
    lastTradeEventAt: null,
    lastOrderEventAt: null,
    lastFillEventAt: null,
  };
}

/** Copy timestamp for safe exposure (clone Date so caller cannot mutate). */
function copyDate(d: Date | null | undefined): Date | null | undefined {
  if (d == null) return d;
  return new Date(d.getTime());
}

/** Return a shallow copy of state with Date fields cloned for safe exposure. */
export function cloneStreamConnectionState(state: StreamConnectionState): StreamConnectionState {
  return {
    ...state,
    lastOpenAt: copyDate(state.lastOpenAt) ?? null,
    lastMessageAt: copyDate(state.lastMessageAt) ?? null,
    lastErrorAt: copyDate(state.lastErrorAt) ?? null,
    lastSocketFrameAt: state.lastSocketFrameAt != null ? new Date(state.lastSocketFrameAt.getTime()) : null,
    lastHeartbeatAt: state.lastHeartbeatAt != null ? new Date(state.lastHeartbeatAt.getTime()) : null,
    lastDataEventAt: state.lastDataEventAt != null ? new Date(state.lastDataEventAt.getTime()) : null,
    lastBookEventAt: state.lastBookEventAt != null ? new Date(state.lastBookEventAt.getTime()) : null,
    lastTradeEventAt: state.lastTradeEventAt != null ? new Date(state.lastTradeEventAt.getTime()) : null,
    lastOrderEventAt: state.lastOrderEventAt != null ? new Date(state.lastOrderEventAt.getTime()) : null,
    lastFillEventAt: state.lastFillEventAt != null ? new Date(state.lastFillEventAt.getTime()) : null,
  };
}

export function isStreamOpen(state: StreamConnectionState): boolean {
  return state.status === "open";
}
