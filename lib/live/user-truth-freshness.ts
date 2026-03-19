/**
 * User truth freshness: timestamp of last successful user_sync (GET /data/orders, GET /data/trades).
 * Used by the stream watchdog to avoid false kill-switch when the user WebSocket has no order/fill
 * messages but REST polling has recently succeeded. Same process only; job sets, runtime reads.
 */

const GLOBAL_KEY = "__polymarket_copilot_lastSuccessfulUserTruthFetchAt";
const globalStore = globalThis as unknown as Record<string, unknown>;

function getStoreValue(): Date | null {
  const v = globalStore[GLOBAL_KEY];
  return v instanceof Date ? v : null;
}

export function setLastSuccessfulUserTruthFetchAt(at: Date): void {
  globalStore[GLOBAL_KEY] = at;
}

export function getLastSuccessfulUserTruthFetchAt(): Date | null {
  return getStoreValue();
}
