/**
 * Order lifecycle journal: append-only event trace for operator visibility and diagnostics.
 *
 * SOURCE OF TRUTH: The execution ledger (OrderIntent, ExecutedOrder, ExecutedOrderEvent,
 * CancelRequest, ReplaceRequest, FillLedgerEntry) is the authoritative durable lifecycle record.
 * This journal is a secondary, supplementary trace—useful for operator-friendly event history
 * and replay—but must not be treated as the primary persistence layer for order/fill lifecycle.
 * When both journal and ledger are written, meanings are aligned; the ledger remains canonical.
 *
 * No mutation of prior entries. Hot path uses a single adapter (this module).
 */

import { prisma } from "@/lib/db";
import type { RuntimeOrderState, RuntimeOrderStatus } from "../order-manager/order-manager";

/** Event types journaled. Order matters for replay. */
export const ORDER_LIFECYCLE_EVENT_TYPES = {
  INTENT_CREATED: "intent_created",
  LOCAL_ORDER_CREATED: "local_order_created",
  ACK: "ack",
  PARTIAL_FILL: "partial_fill",
  FILL: "fill",
  CANCEL_REQUESTED: "cancel_requested",
  CANCELED: "canceled",
  REJECTED: "rejected",
  STALE_DETECTED: "stale_detected",
  RECONCILE_KEEP: "reconcile_keep",
  RECONCILE_PLACE: "reconcile_place",
  RECONCILE_CANCEL: "reconcile_cancel",
  RECONCILE_CANCEL_REPLACE: "reconcile_cancel_replace",
  REBUILD_IMPORTED: "rebuild_imported",
  REPAIR_RECOMMENDED: "repair_recommended",
  REPAIR_APPLIED: "repair_applied",
  /** Execution ambiguity: submit/cancel/replace outcome unknown (failure containment). */
  SUBMIT_AMBIGUOUS: "submit_ambiguous",
  CANCEL_AMBIGUOUS: "cancel_ambiguous",
  REPLACE_AMBIGUOUS: "replace_ambiguous",
  /** Execution policy gate passed; payloadJson = execution policy snapshot for audit. */
  EXECUTION_POLICY_PASSED: "execution_policy_passed",
} as const;

export type OrderLifecycleEventType = (typeof ORDER_LIFECYCLE_EVENT_TYPES)[keyof typeof ORDER_LIFECYCLE_EVENT_TYPES];

export interface AppendOrderLifecycleEventParams {
  funderAddress: string;
  clientOrderId?: string | null;
  exchangeOrderId?: string | null;
  intentId?: string | null;
  assetId: string;
  marketId: string;
  side: string;
  eventType: OrderLifecycleEventType;
  payloadJson?: string | null;
  metadataJson?: string | null;
  occurredAt: Date;
}

/** Single journal entry (DB row). */
export interface OrderLifecycleJournalEntryRow {
  id: string;
  funderAddress: string;
  clientOrderId: string | null;
  exchangeOrderId: string | null;
  intentId: string | null;
  assetId: string;
  marketId: string;
  side: string;
  eventType: string;
  eventSequence: number;
  payloadJson: string | null;
  metadataJson: string | null;
  occurredAt: Date;
  createdAt: Date;
}

/**
 * Append one lifecycle event. Append-only; never mutates prior entries.
 * Call from hot path (lifecycle handler, order manager, sweeper, rebuild, reconciliation).
 */
export async function appendOrderLifecycleEvent(params: AppendOrderLifecycleEventParams): Promise<string> {
  const normalizedFunder = params.funderAddress.toLowerCase();
  const occurredAt = params.occurredAt instanceof Date ? params.occurredAt : new Date(params.occurredAt);
  const created = await prisma.orderLifecycleJournalEntry.create({
    data: {
      funderAddress: normalizedFunder,
      clientOrderId: params.clientOrderId ?? null,
      exchangeOrderId: params.exchangeOrderId ?? null,
      intentId: params.intentId ?? null,
      assetId: params.assetId,
      marketId: params.marketId,
      side: params.side,
      eventType: params.eventType,
      eventSequence: 0,
      payloadJson: params.payloadJson ?? null,
      metadataJson: params.metadataJson ?? null,
      occurredAt,
    },
  });
  return created.id;
}

/**
 * Get lifecycle history: by funder, optionally by clientOrderId or exchangeOrderId.
 * Ordered by createdAt ascending for deterministic replay.
 */
export async function getOrderLifecycleHistory(params: {
  funderAddress: string;
  clientOrderId?: string | null;
  exchangeOrderId?: string | null;
  limit?: number;
}): Promise<OrderLifecycleJournalEntryRow[]> {
  const funder = params.funderAddress.toLowerCase();
  type Where = { funderAddress: string; clientOrderId?: string; exchangeOrderId?: string; OR?: Array<{ clientOrderId: string } | { exchangeOrderId: string }> };
  const where: Where = { funderAddress: funder };
  if (params.clientOrderId != null && params.clientOrderId !== "" && params.exchangeOrderId != null && params.exchangeOrderId !== "") {
    where.OR = [{ clientOrderId: params.clientOrderId }, { exchangeOrderId: params.exchangeOrderId }];
  } else if (params.clientOrderId != null && params.clientOrderId !== "") {
    where.clientOrderId = params.clientOrderId;
  } else if (params.exchangeOrderId != null && params.exchangeOrderId !== "") {
    where.exchangeOrderId = params.exchangeOrderId;
  }
  const rows = await prisma.orderLifecycleJournalEntry.findMany({
    where,
    orderBy: { createdAt: "asc" },
    take: params.limit ?? 10_000,
  });
  return rows as OrderLifecycleJournalEntryRow[];
}

/** Parsed payload for local_order_created. */
interface LocalOrderCreatedPayload {
  clientOrderId: string;
  price?: number;
  size?: number;
  intentId?: string | null;
}

/** Parsed payload for ack. */
interface AckPayload {
  exchangeOrderId?: string;
}

/** Parsed payload for partial_fill / fill. */
interface FillPayload {
  fillSize?: number;
  totalFilledSize?: number;
  fillPrice?: number;
  avgPrice?: number;
}

function parsePayloadJson<T>(json: string | null): T | null {
  if (json == null || json === "") return null;
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

/**
 * Replay journal entries for one order and return the resulting runtime order state.
 * Deterministic: same entries in order produce same state. Duplicate events (e.g. double ack)
 * are applied idempotently (only valid transitions).
 */
export function rebuildOrderFromJournal(entries: OrderLifecycleJournalEntryRow[]): RuntimeOrderState | null {
  if (entries.length === 0) return null;

  const byClient = entries.filter((e) => e.clientOrderId != null && e.clientOrderId !== "");
  if (byClient.length === 0) return null;

  const clientOrderId = byClient[0].clientOrderId!;
  const funder = byClient[0].funderAddress;
  const assetId = byClient[0].assetId;
  const marketId = byClient[0].marketId;
  const side = byClient[0].side as "BUY" | "SELL";

  let state: RuntimeOrderState | null = null;
  const now = new Date();

  for (const e of byClient) {
    switch (e.eventType) {
      case ORDER_LIFECYCLE_EVENT_TYPES.LOCAL_ORDER_CREATED:
      case ORDER_LIFECYCLE_EVENT_TYPES.REBUILD_IMPORTED: {
        const p = parsePayloadJson<LocalOrderCreatedPayload>(e.payloadJson);
        const price = p?.price ?? 0;
        const size = p?.size ?? 0;
        if (state == null && size > 0) {
          state = {
            clientOrderId: p?.clientOrderId ?? clientOrderId,
            runtimeOrderId: p?.clientOrderId ?? clientOrderId,
            exchangeOrderId: null,
            externalOrderId: null,
            funderAddress: e.funderAddress,
            assetId: e.assetId,
            marketId: e.marketId,
            side: e.side as "BUY" | "SELL",
            price,
            limitPrice: price,
            size,
            desiredSize: size,
            filledSize: 0,
            remainingSize: size,
            status: "pending_submit",
            intentId: p?.intentId ?? null,
            createdAt: e.occurredAt,
            updatedAt: e.occurredAt,
            lastAckAt: null,
            staleAfterMs: 120_000,
            replaceGroupKey: null,
            lastFillAt: null,
            appliedPositionFilledSize: 0,
          };
        }
        break;
      }
      case ORDER_LIFECYCLE_EVENT_TYPES.ACK: {
        const p = parsePayloadJson<AckPayload>(e.payloadJson);
        const exId = p?.exchangeOrderId ?? e.exchangeOrderId ?? "";
        if (state != null && state.status === "pending_submit" && exId) {
          const current: RuntimeOrderState = state;
          state = {
            ...current,
            exchangeOrderId: exId,
            externalOrderId: exId,
            status: "working" as const,
            lastAckAt: e.occurredAt,
            updatedAt: e.occurredAt,
          };
        }
        break;
      }
      case ORDER_LIFECYCLE_EVENT_TYPES.PARTIAL_FILL:
      case ORDER_LIFECYCLE_EVENT_TYPES.FILL: {
        const p = parsePayloadJson<FillPayload>(e.payloadJson);
        const fillSize = p?.fillSize ?? p?.totalFilledSize ?? 0;
        const fillPrice = p?.fillPrice ?? p?.avgPrice ?? 0;
        if (state != null && (state.status === "working" || state.status === "partially_filled") && fillSize > 0) {
          const current: RuntimeOrderState = state;
          const newFilled = Math.min(current.size, current.filledSize + fillSize);
          const newRemaining: number = current.size - newFilled;
          const status: RuntimeOrderStatus = newRemaining === 0 ? "filled" : "partially_filled";
          state = {
            ...current,
            filledSize: newFilled,
            remainingSize: newRemaining,
            status,
            updatedAt: e.occurredAt,
            lastFillAt: e.occurredAt,
          };
        }
        break;
      }
      case ORDER_LIFECYCLE_EVENT_TYPES.CANCELED:
      case ORDER_LIFECYCLE_EVENT_TYPES.REPAIR_APPLIED: {
        if (state != null && state.status !== "filled" && state.status !== "rejected" && state.status !== "expired") {
          const current: RuntimeOrderState = state;
          state = { ...current, status: "canceled" as const, updatedAt: e.occurredAt };
        }
        break;
      }
      case ORDER_LIFECYCLE_EVENT_TYPES.REJECTED: {
        if (state != null && state.status === "pending_submit") {
          const current: RuntimeOrderState = state;
          state = { ...current, status: "rejected" as const, updatedAt: e.occurredAt };
        }
        break;
      }
      case ORDER_LIFECYCLE_EVENT_TYPES.SUBMIT_AMBIGUOUS: {
        if (state != null && state.status === "pending_submit") {
          const current: RuntimeOrderState = state;
          state = { ...current, status: "submit_ambiguous" as const, updatedAt: e.occurredAt };
        }
        break;
      }
      case ORDER_LIFECYCLE_EVENT_TYPES.CANCEL_AMBIGUOUS: {
        if (state != null && (state.status === "working" || state.status === "partially_filled" || state.status === "pending_cancel")) {
          const current: RuntimeOrderState = state;
          state = { ...current, status: "cancel_ambiguous" as const, updatedAt: e.occurredAt };
        }
        break;
      }
      case ORDER_LIFECYCLE_EVENT_TYPES.REPLACE_AMBIGUOUS: {
        if (state != null && (state.status === "working" || state.status === "partially_filled" || state.status === "pending_cancel")) {
          const current: RuntimeOrderState = state;
          state = { ...current, status: "replace_ambiguous" as const, updatedAt: e.occurredAt };
        }
        break;
      }
      default:
        break;
    }
  }

  return state;
}

/**
 * Get latest runtime order state for an order by replaying its journal.
 * Returns null if no entries or order not created in journal.
 */
export async function getLatestJournalStateForOrder(params: {
  funderAddress: string;
  clientOrderId?: string | null;
  exchangeOrderId?: string | null;
}): Promise<RuntimeOrderState | null> {
  const entries = await getOrderLifecycleHistory({
    funderAddress: params.funderAddress,
    clientOrderId: params.clientOrderId,
    exchangeOrderId: params.exchangeOrderId,
  });
  return rebuildOrderFromJournal(entries);
}

/**
 * Replay one order from journal and upsert into the given store.
 * Use for optional rebuild-from-journal (e.g. orders that exist only in journal).
 * No-op if journal has no entries or replay produces null.
 */
export async function replayOrderFromJournalIntoStore(params: {
  funderAddress: string;
  clientOrderId?: string | null;
  exchangeOrderId?: string | null;
  orderStore: { upsert(state: RuntimeOrderState): void };
}): Promise<RuntimeOrderState | null> {
  const state = await getLatestJournalStateForOrder({
    funderAddress: params.funderAddress,
    clientOrderId: params.clientOrderId,
    exchangeOrderId: params.exchangeOrderId,
  });
  if (state) {
    params.orderStore.upsert(state);
  }
  return state;
}
