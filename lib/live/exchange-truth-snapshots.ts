/**
 * Cross-cutting timestamps for successful exchange REST snapshots (orders / fills).
 * StreamRuntime updates private fields on startup + in-process reconciliation; scheduled
 * `user_sync` also pulls authoritative user data. Merging avoids false `exchange_truth_*_stale`
 * when one path succeeded recently but another did not update StreamRuntime fields.
 *
 * Same-process only (globalThis), analogous to user-truth-freshness.
 */

const G_ORDERS = "__polymarket_copilot_recordedExchangeOrdersSnapshotAt";
const G_FILLS = "__polymarket_copilot_recordedExchangeFillsSnapshotAt";

function read(key: string): Date | null {
  const v = (globalThis as unknown as Record<string, unknown>)[key];
  return v instanceof Date ? v : null;
}

/** Record a successful authoritative open-orders (or equivalent) snapshot. */
export function recordExchangeOrdersSnapshotSuccess(at: Date = new Date()): void {
  (globalThis as unknown as Record<string, unknown>)[G_ORDERS] = at;
}

/** Record a successful recent-fills snapshot fetch. */
export function recordExchangeFillsSnapshotSuccess(at: Date = new Date()): void {
  (globalThis as unknown as Record<string, unknown>)[G_FILLS] = at;
}

export function getRecordedExchangeOrdersSnapshotAt(): Date | null {
  return read(G_ORDERS);
}

export function getRecordedExchangeFillsSnapshotAt(): Date | null {
  return read(G_FILLS);
}

/** Clear recorded snapshots (e.g. stream runtime stop). */
export function clearRecordedExchangeSnapshots(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  delete g[G_ORDERS];
  delete g[G_FILLS];
}

/** Prefer the newest of two successful snapshot times (local StreamRuntime vs global). */
export function mergeExchangeSnapshotAt(local: Date | null, globalAt: Date | null): Date | null {
  if (!local) return globalAt;
  if (!globalAt) return local;
  return local.getTime() >= globalAt.getTime() ? local : globalAt;
}
