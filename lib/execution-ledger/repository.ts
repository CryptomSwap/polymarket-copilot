/**
 * Repository layer for the execution ledger. Prisma-backed, strongly typed.
 * Single place for intent, executed order, fill ledger, cancel/replace, and timeline reads/writes.
 * Transaction boundaries where appropriate; duplicate keys handled explicitly.
 */

import { prisma } from "@/lib/db";
import type {
  CreateOrderIntentInput,
  AppendOrderIntentEventInput,
  OrderIntentRecord,
  CreateExecutedOrderInput,
  AppendExecutedOrderEventInput,
  ExecutedOrderRecord,
  RecordFillLedgerEntryInput,
  MarkFillAppliedInput,
  FillLedgerRecord,
  CreateCancelRequestInput,
  CreateReplaceRequestInput,
  UnappliedFillRow,
  ExecutionTimelineRow,
} from "./types";
import { createOrGetByUniqueKey, isPrismaUniqueViolation, normalizeIdempotencyKey } from "./idempotency";

const FUNDER_NORMALIZE = (s: string) => s.toLowerCase().trim();

// ----- OrderIntent -----

function toOrderIntentRecord(row: {
  id: string;
  funderAddress: string;
  recommendationId: string | null;
  source: string | null;
  marketId: string;
  assetId: string;
  outcome: string;
  side: string;
  orderType: string;
  limitPrice: string;
  size: string;
  status: string;
  idempotencyKey: string | null;
  decisionSnapshotId: string | null;
  riskPreviewJson: string | null;
  riskCheckSnapshotJson: string | null;
  executionPolicySnapshotJson: string | null;
  metadataJson: string | null;
  createdAt: Date;
  updatedAt: Date;
}): OrderIntentRecord {
  return {
    id: row.id,
    funderAddress: row.funderAddress,
    recommendationId: row.recommendationId,
    source: row.source,
    marketId: row.marketId,
    assetId: row.assetId,
    outcome: row.outcome,
    side: row.side,
    orderType: row.orderType,
    limitPrice: row.limitPrice,
    size: row.size,
    status: row.status,
    idempotencyKey: row.idempotencyKey,
    decisionSnapshotId: row.decisionSnapshotId,
    riskPreviewJson: row.riskPreviewJson,
    riskCheckSnapshotJson: row.riskCheckSnapshotJson,
    executionPolicySnapshotJson: row.executionPolicySnapshotJson,
    metadataJson: row.metadataJson,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function createOrderIntent(input: CreateOrderIntentInput): Promise<OrderIntentRecord> {
  const funder = FUNDER_NORMALIZE(input.funderAddress);
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  const now = new Date();
  try {
    const created = await prisma.orderIntent.create({
      data: {
        funderAddress: funder,
        recommendationId: input.recommendationId ?? null,
        source: input.source ?? null,
        marketId: input.marketId,
        assetId: input.assetId,
        outcome: input.outcome,
        side: input.side,
        orderType: input.orderType,
        limitPrice: input.limitPrice,
        size: input.requestedSize,
        status: input.status,
        idempotencyKey,
        decisionSnapshotId: input.decisionSnapshotId ?? null,
        riskPreviewJson: input.riskPreviewJson ?? null,
        riskCheckSnapshotJson: input.riskCheckSnapshotJson ?? null,
        executionPolicySnapshotJson: input.executionPolicySnapshotJson ?? null,
        metadataJson: input.metadataJson ?? null,
        updatedAt: now,
      },
    });
    return toOrderIntentRecord(created);
  } catch (err) {
    if (isPrismaUniqueViolation(err) && idempotencyKey != null) {
      const existing = await prisma.orderIntent.findUnique({
        where: { funderAddress_idempotencyKey: { funderAddress: funder, idempotencyKey } },
      });
      if (existing) {
        console.log("[execution-ledger] OrderIntent creation idempotent reuse: existing row returned for funderAddress + idempotencyKey", {
          funderAddress: funder,
          idempotencyKey,
          orderIntentId: existing.id,
        });
        if (input.recommendationId && existing.recommendationId == null) {
          const updated = await prisma.orderIntent.update({
            where: { id: existing.id },
            data: {
              recommendationId: input.recommendationId,
              ...(input.metadataJson != null && existing.metadataJson == null
                ? { metadataJson: input.metadataJson }
                : {}),
              updatedAt: new Date(),
            },
          });
          return toOrderIntentRecord(updated);
        }
        return toOrderIntentRecord(existing);
      }
    }
    throw err;
  }
}

/** Create intent only if idempotencyKey is not already used; otherwise return existing. */
export async function createOrderIntentIdempotent(input: CreateOrderIntentInput): Promise<{ record: OrderIntentRecord; existing: boolean }> {
  const key = normalizeIdempotencyKey(input.idempotencyKey);
  if (key == null) {
    const record = await createOrderIntent(input);
    return { record, existing: false };
  }
  const funder = FUNDER_NORMALIZE(input.funderAddress);
  const result = await createOrGetByUniqueKey({
    create: async () => {
      const r = await createOrderIntent(input);
      return r.id;
    },
    getExisting: async () => {
      const existing = await prisma.orderIntent.findUnique({
        where: { funderAddress_idempotencyKey: { funderAddress: funder, idempotencyKey: key } },
        select: { id: true },
      });
      return existing?.id ?? null;
    },
  });
  let record = await getOrderIntentById(result.id);
  if (!record) throw new Error("createOrderIntentIdempotent: getOrderIntentById null after createOrGet");
  if (result.existing && input.recommendationId && record.recommendationId == null) {
    await prisma.orderIntent.update({
      where: { id: record.id },
      data: {
        recommendationId: input.recommendationId,
        ...(input.metadataJson != null && record.metadataJson == null ? { metadataJson: input.metadataJson } : {}),
        updatedAt: new Date(),
      },
    });
    const again = await getOrderIntentById(record.id);
    if (again) record = again;
  }
  return { record, existing: result.existing };
}

export async function getOrderIntentById(id: string): Promise<OrderIntentRecord | null> {
  const row = await prisma.orderIntent.findUnique({ where: { id } });
  return row ? toOrderIntentRecord(row) : null;
}

export async function getOrderIntentByIdempotencyKey(funderAddress: string, idempotencyKey: string): Promise<OrderIntentRecord | null> {
  const funder = FUNDER_NORMALIZE(funderAddress);
  const key = normalizeIdempotencyKey(idempotencyKey);
  if (key == null) return null;
  const row = await prisma.orderIntent.findUnique({
    where: { funderAddress_idempotencyKey: { funderAddress: funder, idempotencyKey: key } },
  });
  return row ? toOrderIntentRecord(row) : null;
}

export async function appendOrderIntentEvent(input: AppendOrderIntentEventInput): Promise<string> {
  const created = await prisma.orderIntentEvent.create({
    data: {
      orderIntentId: input.orderIntentId,
      eventType: input.eventType,
      payloadJson: input.payloadJson ?? null,
    },
  });
  return created.id;
}

export async function markOrderIntentStatus(intentId: string, status: string): Promise<void> {
  await prisma.orderIntent.update({
    where: { id: intentId },
    data: { status, updatedAt: new Date() },
  });
}

export async function updateOrderIntentExecutionPolicySnapshot(
  intentId: string,
  executionPolicySnapshotJson: string
): Promise<void> {
  await prisma.orderIntent.update({
    where: { id: intentId },
    data: { executionPolicySnapshotJson, updatedAt: new Date() },
  });
}

// ----- ExecutedOrder -----

function toExecutedOrderRecord(row: {
  id: string;
  funderAddress: string;
  orderIntentId: string | null;
  venue: string | null;
  polymarketOrderId: string;
  venueOrderId: string | null;
  marketId: string;
  assetId: string;
  side: string;
  orderType: string | null;
  price: string;
  size: string;
  originalSize: string | null;
  remainingSize: string | null;
  status: string;
  rawJson: string | null;
  metadataJson: string | null;
  createdAt: Date;
  updatedAt: Date;
}): ExecutedOrderRecord {
  return {
    id: row.id,
    funderAddress: row.funderAddress,
    orderIntentId: row.orderIntentId,
    venue: row.venue,
    polymarketOrderId: row.polymarketOrderId,
    venueOrderId: row.venueOrderId,
    marketId: row.marketId,
    assetId: row.assetId,
    side: row.side,
    orderType: row.orderType,
    price: row.price,
    size: row.size,
    originalSize: row.originalSize,
    remainingSize: row.remainingSize,
    status: row.status,
    rawJson: row.rawJson,
    metadataJson: row.metadataJson,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function createExecutedOrder(input: CreateExecutedOrderInput): Promise<ExecutedOrderRecord> {
  const funder = FUNDER_NORMALIZE(input.funderAddress);
  const now = new Date();
  const created = await prisma.executedOrder.create({
    data: {
      funderAddress: funder,
      orderIntentId: input.orderIntentId ?? null,
      venue: input.venue ?? null,
      polymarketOrderId: input.polymarketOrderId,
      venueOrderId: input.venueOrderId ?? null,
      marketId: input.marketId,
      assetId: input.assetId,
      side: input.side,
      orderType: input.orderType ?? null,
      price: input.price,
      size: input.size,
      originalSize: input.originalSize ?? null,
      remainingSize: input.remainingSize ?? null,
      status: input.status,
      rawJson: input.rawJson ?? null,
      metadataJson: input.metadataJson ?? null,
      updatedAt: now,
    },
  });
  return toExecutedOrderRecord(created);
}

export async function getExecutedOrderById(id: string): Promise<ExecutedOrderRecord | null> {
  const row = await prisma.executedOrder.findUnique({ where: { id } });
  return row ? toExecutedOrderRecord(row) : null;
}

export async function getExecutedOrderByVenueOrderId(venueOrderId: string): Promise<ExecutedOrderRecord | null> {
  const row = await prisma.executedOrder.findUnique({ where: { venueOrderId } });
  return row ? toExecutedOrderRecord(row) : null;
}

export async function linkExecutedOrderToIntent(executedOrderId: string, orderIntentId: string): Promise<void> {
  await prisma.executedOrder.update({
    where: { id: executedOrderId },
    data: { orderIntentId, updatedAt: new Date() },
  });
}

export async function appendExecutedOrderEvent(input: AppendExecutedOrderEventInput): Promise<string> {
  const created = await prisma.executedOrderEvent.create({
    data: {
      executedOrderId: input.executedOrderId,
      eventType: input.eventType,
      payloadJson: input.payloadJson ?? null,
    },
  });
  return created.id;
}

export async function markExecutedOrderStatus(executedOrderId: string, status: string): Promise<void> {
  await prisma.executedOrder.update({
    where: { id: executedOrderId },
    data: { status, updatedAt: new Date() },
  });
}

// ----- Fill ledger -----

function toFillLedgerRecord(row: {
  id: string;
  funderAddress: string;
  exchangeFillId: string;
  clientOrderId: string | null;
  exchangeOrderId: string | null;
  executedOrderId: string | null;
  orderIntentId: string | null;
  venueTradeId: string | null;
  assetId: string;
  marketId: string;
  side: string;
  size: number;
  price: number;
  fee: number | null;
  filledAt: Date;
  source: string;
  appliedToRuntimePosition: boolean;
  appliedToPosition: boolean;
  appliedAt: Date | null;
  payloadJson: string | null;
  rawPayloadJson: string | null;
  createdAt: Date;
  updatedAt: Date;
}): FillLedgerRecord {
  return {
    id: row.id,
    funderAddress: row.funderAddress,
    exchangeFillId: row.exchangeFillId,
    clientOrderId: row.clientOrderId,
    exchangeOrderId: row.exchangeOrderId,
    executedOrderId: row.executedOrderId,
    orderIntentId: row.orderIntentId,
    venueTradeId: row.venueTradeId,
    assetId: row.assetId,
    marketId: row.marketId,
    side: row.side,
    size: row.size,
    price: row.price,
    fee: row.fee,
    filledAt: row.filledAt,
    source: row.source,
    appliedToRuntimePosition: row.appliedToRuntimePosition,
    appliedToPosition: row.appliedToPosition,
    appliedAt: row.appliedAt,
    payloadJson: row.payloadJson,
    rawPayloadJson: row.rawPayloadJson,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Record a fill. If (funderAddress, exchangeFillId) or venueTradeId already exists, returns existing record and duplicate: true. */
export async function recordFillLedgerEntry(input: RecordFillLedgerEntryInput): Promise<{ record: FillLedgerRecord; duplicate: boolean }> {
  const funder = FUNDER_NORMALIZE(input.funderAddress);
  const now = new Date();

  const existingByExchange = await prisma.fillLedgerEntry.findUnique({
    where: { funderAddress_exchangeFillId: { funderAddress: funder, exchangeFillId: input.exchangeFillId } },
  });
  if (existingByExchange) return { record: toFillLedgerRecord(existingByExchange), duplicate: true };

  if (input.venueTradeId) {
    const existingByVenue = await prisma.fillLedgerEntry.findUnique({
      where: { venueTradeId: input.venueTradeId },
    });
    if (existingByVenue) return { record: toFillLedgerRecord(existingByVenue), duplicate: true };
  }

  const created = await prisma.fillLedgerEntry.create({
    data: {
      funderAddress: funder,
      exchangeFillId: input.exchangeFillId,
      clientOrderId: input.clientOrderId ?? null,
      exchangeOrderId: input.exchangeOrderId ?? null,
      executedOrderId: input.executedOrderId ?? null,
      orderIntentId: input.orderIntentId ?? null,
      venueTradeId: input.venueTradeId ?? null,
      assetId: input.assetId,
      marketId: input.marketId,
      side: input.side,
      size: input.fillSize,
      price: input.fillPrice,
      fillPrice: input.fillPrice,
      fillSize: input.fillSize,
      fee: input.fee ?? null,
      filledAt: input.filledAt,
      fillTimestamp: input.filledAt,
      source: input.source,
      appliedToRuntimePosition: false,
      appliedToPosition: false,
      payloadJson: input.payloadJson ?? null,
      rawPayloadJson: input.rawPayloadJson ?? null,
      updatedAt: now,
    },
  });
  return { record: toFillLedgerRecord(created), duplicate: false };
}

export async function getFillLedgerEntryByVenueTradeId(venueTradeId: string): Promise<FillLedgerRecord | null> {
  const row = await prisma.fillLedgerEntry.findUnique({ where: { venueTradeId } });
  return row ? toFillLedgerRecord(row) : null;
}

/** Get fill ledger row by (funderAddress, exchangeFillId). Used to gate position mutation by durable applied state. */
export async function getFillLedgerEntryByFunderAndExchangeFillId(
  funderAddress: string,
  exchangeFillId: string
): Promise<FillLedgerRecord | null> {
  const funder = FUNDER_NORMALIZE(funderAddress);
  const row = await prisma.fillLedgerEntry.findUnique({
    where: { funderAddress_exchangeFillId: { funderAddress: funder, exchangeFillId } },
  });
  return row ? toFillLedgerRecord(row) : null;
}

/** Applied fills only, for position store rebuild. Order by filledAt so rebuild is deterministic. */
export async function getAppliedFillsForRebuild(funderAddress: string): Promise<UnappliedFillRow[]> {
  const funder = FUNDER_NORMALIZE(funderAddress);
  const rows = await prisma.fillLedgerEntry.findMany({
    where: { funderAddress: funder, appliedToRuntimePosition: true },
    orderBy: { filledAt: "asc" },
    select: {
      id: true,
      funderAddress: true,
      exchangeFillId: true,
      venueTradeId: true,
      assetId: true,
      marketId: true,
      side: true,
      size: true,
      price: true,
      filledAt: true,
      payloadJson: true,
    },
  });
  return rows.map((r) => ({
    id: r.id,
    funderAddress: r.funderAddress,
    exchangeFillId: r.exchangeFillId,
    venueTradeId: r.venueTradeId,
    assetId: r.assetId,
    marketId: r.marketId,
    side: r.side,
    size: r.size,
    price: r.price,
    filledAt: r.filledAt,
    outcome: parseOutcomeFromPayload(r.payloadJson),
  }));
}

export async function getUnappliedFills(funderAddress?: string): Promise<UnappliedFillRow[]> {
  const where: { appliedToRuntimePosition: boolean; funderAddress?: string } = { appliedToRuntimePosition: false };
  if (funderAddress) where.funderAddress = FUNDER_NORMALIZE(funderAddress);
  const rows = await prisma.fillLedgerEntry.findMany({
    where,
    orderBy: { filledAt: "asc" },
    select: {
      id: true,
      funderAddress: true,
      exchangeFillId: true,
      venueTradeId: true,
      assetId: true,
      marketId: true,
      side: true,
      size: true,
      price: true,
      filledAt: true,
      payloadJson: true,
    },
  });
  return rows.map((r) => ({
    id: r.id,
    funderAddress: r.funderAddress,
    exchangeFillId: r.exchangeFillId,
    venueTradeId: r.venueTradeId,
    assetId: r.assetId,
    marketId: r.marketId,
    side: r.side,
    size: r.size,
    price: r.price,
    filledAt: r.filledAt,
    outcome: parseOutcomeFromPayload(r.payloadJson),
  }));
}

function parseOutcomeFromPayload(payloadJson: string | null): string {
  if (!payloadJson) return "";
  try {
    const p = JSON.parse(payloadJson) as Record<string, unknown>;
    return (typeof p.outcome === "string" ? p.outcome : "") as string;
  } catch {
    return "";
  }
}

/**
 * Mark fill as applied. Only rows with appliedToRuntimePosition = false are updated.
 * Returns true if at least one row was updated (single-apply safe).
 */
export async function markFillApplied(input: MarkFillAppliedInput): Promise<boolean> {
  const now = new Date();
  if (input.id) {
    const r = await prisma.fillLedgerEntry.updateMany({
      where: { id: input.id, appliedToRuntimePosition: false },
      data: { appliedToRuntimePosition: true, appliedToPosition: true, appliedAt: now, updatedAt: now },
    });
    return r.count > 0;
  }
  if (input.funderAddress && input.exchangeFillId) {
    const funder = FUNDER_NORMALIZE(input.funderAddress);
    const r = await prisma.fillLedgerEntry.updateMany({
      where: { funderAddress: funder, exchangeFillId: input.exchangeFillId, appliedToRuntimePosition: false },
      data: { appliedToRuntimePosition: true, appliedToPosition: true, appliedAt: now, updatedAt: now },
    });
    return r.count > 0;
  }
  if (input.venueTradeId) {
    const r = await prisma.fillLedgerEntry.updateMany({
      where: { venueTradeId: input.venueTradeId, appliedToRuntimePosition: false },
      data: { appliedToRuntimePosition: true, appliedToPosition: true, appliedAt: now, updatedAt: now },
    });
    return r.count > 0;
  }
  return false;
}

// ----- Cancel / replace -----

export async function createCancelRequest(input: CreateCancelRequestInput): Promise<string> {
  const now = new Date();
  const created = await prisma.cancelRequest.create({
    data: {
      executedOrderId: input.executedOrderId,
      status: input.status,
      reason: input.reason ?? null,
      venueRequestId: input.venueRequestId ?? null,
      updatedAt: now,
    },
  });
  return created.id;
}

export async function createReplaceRequest(input: CreateReplaceRequestInput): Promise<string> {
  const now = new Date();
  const created = await prisma.replaceRequest.create({
    data: {
      executedOrderId: input.executedOrderId,
      newPrice: input.newPrice ?? null,
      newSize: input.newSize ?? null,
      status: input.status,
      reason: input.reason ?? null,
      venueRequestId: input.venueRequestId ?? null,
      updatedAt: now,
    },
  });
  return created.id;
}

export async function markCancelRequestStatus(cancelRequestId: string, status: string): Promise<void> {
  await prisma.cancelRequest.update({
    where: { id: cancelRequestId },
    data: { status, updatedAt: new Date() },
  });
}

export async function markReplaceRequestStatus(replaceRequestId: string, status: string): Promise<void> {
  await prisma.replaceRequest.update({
    where: { id: replaceRequestId },
    data: { status, updatedAt: new Date() },
  });
}

// ----- Timeline -----

export interface GetExecutionTimelineForIntentParams {
  orderIntentId: string;
  limit?: number;
}

/** Returns intent, intent events, executed orders, order events, and fills in a single ordered timeline (by occurredAt). */
export async function getExecutionTimelineForIntent(params: GetExecutionTimelineForIntentParams): Promise<ExecutionTimelineRow[]> {
  const { orderIntentId, limit = 500 } = params;
  const intent = await prisma.orderIntent.findUnique({
    where: { id: orderIntentId },
    include: {
      intentEvents: { orderBy: { createdAt: "asc" } },
      executedOrders: {
        include: {
          orderEvents: { orderBy: { createdAt: "asc" } },
          fillLedgerEntries: { orderBy: { filledAt: "asc" } },
          cancelRequests: { orderBy: { createdAt: "asc" } },
          replaceRequests: { orderBy: { createdAt: "asc" } },
        },
      },
    },
  });
  if (!intent) return [];

  const rows: ExecutionTimelineRow[] = [];
  rows.push({
    kind: "intent",
    occurredAt: intent.createdAt,
    id: intent.id,
    orderIntentId: intent.id,
    parentId: null,
  });
  for (const e of intent.intentEvents) {
    rows.push({
      kind: "intent_event",
      occurredAt: e.createdAt,
      id: e.id,
      orderIntentId: intent.id,
      executedOrderId: null,
      eventType: e.eventType,
      payloadJson: e.payloadJson,
      parentId: e.orderIntentId,
    });
  }
  for (const order of intent.executedOrders) {
    rows.push({
      kind: "executed_order",
      occurredAt: order.createdAt,
      id: order.id,
      orderIntentId: intent.id,
      executedOrderId: order.id,
      parentId: order.orderIntentId ?? null,
    });
    for (const e of order.orderEvents) {
      rows.push({
        kind: "order_event",
        occurredAt: e.createdAt,
        id: e.id,
        orderIntentId: intent.id,
        executedOrderId: order.id,
        eventType: e.eventType,
        payloadJson: e.payloadJson,
        parentId: e.executedOrderId,
      });
    }
    for (const cr of order.cancelRequests) {
      rows.push({
        kind: "cancel_request",
        occurredAt: cr.createdAt,
        id: cr.id,
        orderIntentId: intent.id,
        executedOrderId: order.id,
        eventType: cr.status,
        parentId: order.id,
      });
    }
    for (const rr of order.replaceRequests) {
      rows.push({
        kind: "replace_request",
        occurredAt: rr.createdAt,
        id: rr.id,
        orderIntentId: intent.id,
        executedOrderId: order.id,
        eventType: rr.status,
        parentId: order.id,
      });
    }
    for (const f of order.fillLedgerEntries) {
      rows.push({
        kind: "fill",
        occurredAt: f.filledAt,
        id: f.id,
        orderIntentId: intent.id,
        executedOrderId: order.id,
        parentId: f.executedOrderId ?? null,
      });
    }
  }
  rows.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  return rows.slice(0, limit);
}
