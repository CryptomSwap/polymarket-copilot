/**
 * Feeds normalized user-feed events into Order Lifecycle Handler.
 * Resolves exchangeOrderId → clientOrderId via store; logs unmatched/mismatch.
 *
 * Position updates are driven exclusively by lifecycle events (order.partial_fill and
 * order.filled). Do not apply position fill here; subscribers to those events update
 * the position store with idempotent delta logic.
 */

import type { OrderLifecycleStore } from "@/lib/runtime/order-manager/order-lifecycle-store";
import type { OrderLifecycleHandler } from "@/lib/runtime/order-manager/order-lifecycle-handler";
import {
  type NormalizedUserFeedResult,
  type NormalizedUserFeedLifecycle,
} from "./user-feed-normalizer";

export interface UserFeedRuntimeTelemetry {
  lifecycleApplied: number;
  unmatchedOrderEvents: number;
  lifecycleMismatch: number;
}

const DEFAULT_TELEMETRY: UserFeedRuntimeTelemetry = {
  lifecycleApplied: 0,
  unmatchedOrderEvents: 0,
  lifecycleMismatch: 0,
};

export interface UserFeedToRuntimeOptions {
  orderStore: OrderLifecycleStore;
  lifecycleHandler: OrderLifecycleHandler | null;
  /** Optional: log with structured meta (e.g. funder, kind, exchangeOrderId). */
  log?: (level: "info" | "warn", message: string, meta?: Record<string, unknown>) => void;
  /** Optional: telemetry counters (mutated in place). */
  telemetry?: UserFeedRuntimeTelemetry;
}

/**
 * Apply a single normalized user-feed result to the runtime.
 * Resolves exchangeOrderId → clientOrderId; applies lifecycle only when order is in store.
 * Position updates happen only via order.partial_fill / order.filled event subscribers.
 */
export function feedUserFeedResultToRuntime(
  result: NormalizedUserFeedResult,
  opts: UserFeedToRuntimeOptions
): void {
  const { orderStore, lifecycleHandler, log, telemetry } = opts;
  const counts = telemetry ?? DEFAULT_TELEMETRY;

  if (result.lifecycle) {
    const order = orderStore.getByExternalId(result.lifecycle.exchangeOrderId);
    const clientOrderId = order?.clientOrderId ?? null;

    if (!clientOrderId) {
      counts.unmatchedOrderEvents++;
      if (log) log("warn", "user_feed_unmatched_order", { kind: result.lifecycle.kind, exchangeOrderId: result.lifecycle.exchangeOrderId, funderAddress: result.funderAddress });
    } else {
      try {
        applyLifecycle(result.lifecycle, clientOrderId, order, orderStore, lifecycleHandler);
        counts.lifecycleApplied++;
      } catch (e) {
        counts.lifecycleMismatch++;
        if (log) log("warn", "user_feed_lifecycle_mismatch", { kind: result.lifecycle.kind, clientOrderId, error: String(e) });
      }
    }
  }
}

function applyLifecycle(
  event: NormalizedUserFeedLifecycle,
  clientOrderId: string,
  order: { filledSize: number } | null,
  orderStore: OrderLifecycleStore,
  handler: OrderLifecycleHandler | null
): void {
  if (!handler) return;
  const at = event.at;

  switch (event.kind) {
    case "ack":
      handler.applyAck({ clientOrderId, exchangeOrderId: event.exchangeOrderId, acknowledgedAt: at });
      break;
    case "partial_fill": {
      const current = order ?? orderStore.get(clientOrderId);
      const prevFilled = current?.filledSize ?? 0;
      const delta = Math.max(0, event.fillSize - prevFilled);
      if (delta > 0) handler.applyPartialFill({ clientOrderId, fillSize: delta, fillPrice: event.fillPrice, filledAt: at });
      break;
    }
    case "fill":
      handler.applyFullFill({ clientOrderId, totalFilledSize: event.totalFilledSize, avgPrice: event.avgPrice, filledAt: at });
      break;
    case "cancel":
      handler.applyCancelAck({ clientOrderId, canceledAt: at, reason: event.reason });
      break;
    case "reject":
      handler.applyRejection({ clientOrderId, rejectedAt: at, reason: event.reason });
      break;
  }
}
