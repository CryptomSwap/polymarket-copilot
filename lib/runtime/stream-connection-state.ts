/**
 * Real WebSocket connection state for health and readiness.
 * Replaces boolean "connected" with truthful status and timestamps.
 */

export type StreamConnectionStatus =
  | "closed"       // No socket or closed, not reconnecting
  | "connecting"   // Socket created, open not yet received
  | "open"        // Socket open and active
  | "reconnecting"; // Closed but reconnect scheduled

export interface StreamConnectionState {
  status: StreamConnectionStatus;
  lastOpenAt: Date | null;
  lastMessageAt: Date | null;
  lastErrorAt: Date | null;
  lastError: string | null;
  reconnectAttempts: number;
}

export function createInitialStreamConnectionState(): StreamConnectionState {
  return {
    status: "closed",
    lastOpenAt: null,
    lastMessageAt: null,
    lastErrorAt: null,
    lastError: null,
    reconnectAttempts: 0,
  };
}

export function isStreamOpen(state: StreamConnectionState): boolean {
  return state.status === "open";
}
