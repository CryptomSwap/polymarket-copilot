/**
 * Feeds normalized user-feed events into Order Lifecycle Handler.
 * Resolves exchangeOrderId → clientOrderId via store; logs unmatched/mismatch.
 * Durable-first: every fill is persisted via execution-ledger before lifecycle/position.
 * Position mutation is gated by ledger applied state (handled in stream-runtime fill handlers).
 */

import type { OrderLifecycleStore } from "@/lib/runtime/order-manager/order-lifecycle-store";
import type { OrderLifecycleHandler } from "@/lib/runtime/order-manager/order-lifecycle-handler";
import {
  type NormalizedUserFeedResult,
  type NormalizedUserFeedLifecycle,
} from "./user-feed-normalizer";
import { recordFillAndReturnDedupResult } from "@/lib/execution-ledger/service";
import type { RecordFillLedgerEntryInput } from "@/lib/execution-ledger/types";
import { resolveFillIdentity } from "@/lib/execution-ledger/fill-identity";

export interface UserFeedRuntimeTelemetry {
  lifecycleApplied: number;
  unmatchedOrderEvents: number;
  lifecycleMismatch: number;
  fillLedgerDuplicatesSkipped: number;
}

const DEFAULT_TELEMETRY: UserFeedRuntimeTelemetry = {
  lifecycleApplied: 0,
  unmatchedOrderEvents: 0,
  lifecycleMismatch: 0,
  fillLedgerDuplicatesSkipped: 0,
};

export interface UserFeedToRuntimeOptions {
  orderStore: OrderLifecycleStore;
  lifecycleHandler: OrderLifecycleHandler | null;
  /** Optional: fill ledger enabled; when true, records fills durably and skips duplicates. */
  fillLedgerEnabled?: boolean;
  /** Optional: log with structured meta (e.g. funder, kind, exchangeOrderId). */
  log?: (level: "info" | "warn", message: string, meta?: Record<string, unknown>) => void;
  /** Optional: telemetry counters (mutated in place). */
  telemetry?: UserFeedRuntimeTelemetry;
  /** Optional: called when exchange order id has no matching local order (integrity). */
  onUnmatchedExchangeOrderId?: () => void;
  /** Optional: called when a duplicate lifecycle event was skipped (e.g. fill ledger duplicate). */
  onDuplicateLifecycleEvent?: () => void;
  /** Optional: called when an out-of-order fill is detected (integrity). */
  onOutOfOrderFill?: () => void;
}

/**
 * Apply a single normalized user-feed result to the runtime.
 * When fillLedgerEnabled and result has a fill with exchangeFillId: records to ledger first;
 * if duplicate, skips lifecycle (no double-apply). Otherwise applies lifecycle; position
 * updates happen via order.partial_fill / order.filled subscribers which mark ledger applied.
 */
export async function feedUserFeedResultToRuntime(
  result: NormalizedUserFeedResult,
  opts: UserFeedToRuntimeOptions
): Promise<void> {
  const { orderStore, lifecycleHandler, fillLedgerEnabled = true, log, telemetry, onUnmatchedExchangeOrderId, onDuplicateLifecycleEvent } = opts;
  const counts = telemetry ?? DEFAULT_TELEMETRY;

  if (!result.lifecycle) return;

  const order = orderStore.getByExternalId(result.lifecycle.exchangeOrderId);
  const clientOrderId = order?.clientOrderId ?? null;

  if (!clientOrderId) {
    counts.unmatchedOrderEvents++;
    onUnmatchedExchangeOrderId?.();
    if (log) log("warn", "user_feed_unmatched_order", { kind: result.lifecycle.kind, exchangeOrderId: result.lifecycle.exchangeOrderId, funderAddress: result.funderAddress });
    return;
  }

  const isFillKind = result.lifecycle.kind === "partial_fill" || result.lifecycle.kind === "fill";
  if (fillLedgerEnabled && isFillKind) {
    const ledgerParams = buildExecutionLedgerFillParams(result, order, clientOrderId, log);
    if (ledgerParams) {
      try {
        const { record, duplicate } = await recordFillAndReturnDedupResult(ledgerParams);
        if (duplicate) {
          counts.fillLedgerDuplicatesSkipped++;
          onDuplicateLifecycleEvent?.();
          if (log) log("info", "fill_duplicate_ignored", { exchangeFillId: record.exchangeFillId, funderAddress: result.funderAddress });
          return;
        }
        if (log) log("info", "fill_persisted", { ledgerId: record.id, exchangeFillId: record.exchangeFillId, funderAddress: result.funderAddress });
        try {
          applyLifecycle(result.lifecycle, clientOrderId, order, orderStore, lifecycleHandler, record.exchangeFillId);
          counts.lifecycleApplied++;
        } catch (e) {
          counts.lifecycleMismatch++;
          if (log) log("warn", "user_feed_lifecycle_mismatch", { kind: result.lifecycle.kind, clientOrderId, error: String(e) });
        }
        return;
      } catch (e) {
        if (log) log("warn", "fill_ledger_record_failed", { error: String(e), funderAddress: result.funderAddress });
        return;
      }
    }
    if (isFillKind && log) log("warn", "fill_skip_no_ledger_params", { kind: result.lifecycle.kind, exchangeOrderId: result.lifecycle.exchangeOrderId });
  }

  if (!isFillKind || !fillLedgerEnabled) {
    try {
      applyLifecycle(result.lifecycle, clientOrderId, order, orderStore, lifecycleHandler, result.exchangeFillId ?? undefined);
      counts.lifecycleApplied++;
    } catch (e) {
      counts.lifecycleMismatch++;
      if (log) log("warn", "user_feed_lifecycle_mismatch", { kind: result.lifecycle.kind, clientOrderId, error: String(e) });
    }
  }
}

function buildExecutionLedgerFillParams(
  result: NormalizedUserFeedResult,
  order: { assetId: string; marketId: string; side: string } | null,
  clientOrderId: string,
  log?: (level: "info" | "warn", message: string, meta?: Record<string, unknown>) => void
): RecordFillLedgerEntryInput | null {
  const life = result.lifecycle;
  if (!life || (life.kind !== "partial_fill" && life.kind !== "fill")) return null;
  const o = order;
  if (!o) return null;

  const size = life.kind === "partial_fill" ? life.fillSize : life.totalFilledSize;
  const price = life.kind === "partial_fill" ? life.fillPrice : life.avgPrice;
  const identity = resolveFillIdentity({
    funderAddress: result.funderAddress,
    exchangeOrderId: life.exchangeOrderId,
    exchangeFillId: result.exchangeFillId ?? null,
    venueTradeId: (result as { venueTradeId?: string | null }).venueTradeId ?? null,
    filledAt: life.at,
    size,
    price,
    side: o.side,
  });

  if (identity.strength === "weak_fingerprint" && log) {
    log("warn", "weak_fill_fingerprint_used", {
      exchangeOrderId: life.exchangeOrderId,
      funderAddress: result.funderAddress,
      size,
      price,
      at: life.at.toISOString(),
    });
  }

  return {
    funderAddress: result.funderAddress,
    exchangeFillId: identity.exchangeFillId,
    clientOrderId,
    exchangeOrderId: life.exchangeOrderId,
    venueTradeId: identity.venueTradeId,
    assetId: o.assetId,
    marketId: o.marketId,
    side: o.side,
    fillSize: size,
    fillPrice: price,
    filledAt: life.at,
    source: "user_feed",
  };
}

function applyLifecycle(
  event: NormalizedUserFeedLifecycle,
  clientOrderId: string,
  order: { filledSize: number } | null,
  orderStore: OrderLifecycleStore,
  handler: OrderLifecycleHandler | null,
  exchangeFillId?: string
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
      if (delta > 0) handler.applyPartialFill({ clientOrderId, fillSize: delta, fillPrice: event.fillPrice, filledAt: at, exchangeFillId: exchangeFillId ?? null });
      break;
    }
    case "fill":
      handler.applyFullFill({ clientOrderId, totalFilledSize: event.totalFilledSize, avgPrice: event.avgPrice, filledAt: at, exchangeFillId: exchangeFillId ?? null });
      break;
    case "cancel":
      handler.applyCancelAck({ clientOrderId, canceledAt: at, reason: event.reason });
      break;
    case "reject":
      handler.applyRejection({ clientOrderId, rejectedAt: at, reason: event.reason });
      break;
  }
}
