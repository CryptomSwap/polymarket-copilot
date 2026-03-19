/**
 * Service layer for the execution ledger. Thin orchestration over the repository.
 * Future runtime code should call this API for durable execution lifecycle writes and reads.
 */

import type {
  CreateOrderIntentInput,
  AppendOrderIntentEventInput,
  OrderIntentRecord,
  CreateExecutedOrderInput,
  AppendExecutedOrderEventInput,
  RecordFillLedgerEntryInput,
  MarkFillAppliedInput,
  CreateCancelRequestInput,
  CreateReplaceRequestInput,
  UnappliedFillRow,
  ExecutionTimelineRow,
  FillLedgerRecord,
} from "./types";
import {
  createOrderIntent,
  createOrderIntentIdempotent,
  getOrderIntentById,
  appendOrderIntentEvent,
  updateOrderIntentExecutionPolicySnapshot,
  markOrderIntentStatus,
  createExecutedOrder,
  getExecutedOrderById,
  linkExecutedOrderToIntent,
  appendExecutedOrderEvent,
  recordFillLedgerEntry,
  getFillLedgerEntryByVenueTradeId,
  getFillLedgerEntryByFunderAndExchangeFillId,
  getAppliedFillsForRebuild as getAppliedFillsForRebuildRepo,
  getUnappliedFills,
  markFillApplied,
  createCancelRequest,
  createReplaceRequest,
  markCancelRequestStatus as markCancelRequestStatusRepo,
  markReplaceRequestStatus as markReplaceRequestStatusRepo,
  getExecutedOrderByVenueOrderId as getExecutedOrderByVenueOrderIdRepo,
  markExecutedOrderStatus as markExecutedOrderStatusRepo,
  getExecutionTimelineForIntent,
} from "./repository";

export type { OrderIntentRecord, ExecutedOrderRecord, FillLedgerRecord, UnappliedFillRow, ExecutionTimelineRow } from "./types";
export type { CreateOrderIntentInput, RecordFillLedgerEntryInput } from "./types";

// ----- Intent -----

export interface CreateIntentWithEventResult {
  intent: OrderIntentRecord;
  existing: boolean;
  eventId: string;
}

/**
 * Create an order intent idempotently (by idempotencyKey) and append a first event (e.g. "created").
 * If idempotencyKey is set and already used, returns existing intent and still appends the event unless eventType is idempotent.
 */
export async function createIntentWithEvent(
  input: CreateOrderIntentInput,
  firstEvent: { eventType: string; payloadJson?: string | null }
): Promise<CreateIntentWithEventResult> {
  const { record, existing } = await createOrderIntentIdempotent(input);
  const eventId = await appendOrderIntentEvent({
    orderIntentId: record.id,
    eventType: firstEvent.eventType,
    payloadJson: firstEvent.payloadJson ?? null,
  });
  return { intent: record, existing, eventId };
}

export async function getIntentTimeline(orderIntentId: string, limit?: number): Promise<ExecutionTimelineRow[]> {
  return getExecutionTimelineForIntent({ orderIntentId, limit });
}

export async function appendOrderIntentEventToLedger(input: AppendOrderIntentEventInput): Promise<string> {
  return appendOrderIntentEvent(input);
}

export async function markOrderIntentStatusInLedger(intentId: string, status: string): Promise<void> {
  return markOrderIntentStatus(intentId, status);
}

/**
 * After execution policy passes: persist snapshot on intent and append EXECUTION_POLICY_PASSED.
 */
export async function persistExecutionPolicyPassed(
  orderIntentId: string,
  executionPolicySnapshotJson: string
): Promise<void> {
  await updateOrderIntentExecutionPolicySnapshot(orderIntentId, executionPolicySnapshotJson);
  await appendOrderIntentEvent({
    orderIntentId,
    eventType: "EXECUTION_POLICY_PASSED",
    payloadJson: executionPolicySnapshotJson,
  });
}

/**
 * Append a blocking event (e.g. EXECUTION_POLICY_BLOCKED, INTENT_REJECTED) and optionally set intent status.
 */
export async function appendIntentBlockedEvent(
  orderIntentId: string,
  eventType: string,
  payloadJson?: string | null,
  status?: string
): Promise<void> {
  await appendOrderIntentEvent({ orderIntentId, eventType, payloadJson });
  if (status) await markOrderIntentStatus(orderIntentId, status);
}

// ----- Executed order -----

export interface CreateExecutedOrderForIntentResult {
  executedOrderId: string;
  intent: OrderIntentRecord | null;
}

/**
 * Create an executed order and optionally link it to an intent. If orderIntentId is provided, links after create.
 */
export async function createExecutedOrderForIntent(
  input: CreateExecutedOrderInput,
  options?: { linkToIntentId?: string }
): Promise<CreateExecutedOrderForIntentResult> {
  const record = await createExecutedOrder(input);
  if (options?.linkToIntentId) {
    await linkExecutedOrderToIntent(record.id, options.linkToIntentId);
  }
  const intent = options?.linkToIntentId ? await getOrderIntentById(options.linkToIntentId) : null;
  return { executedOrderId: record.id, intent };
}

export async function appendExecutedOrderEventForOrder(input: AppendExecutedOrderEventInput): Promise<string> {
  return appendExecutedOrderEvent(input);
}

export async function getExecutedOrder(id: string) {
  return getExecutedOrderById(id);
}

// ----- Fill -----

export interface RecordFillAndReturnDedupResult {
  record: FillLedgerRecord;
  duplicate: boolean;
}

/**
 * Record a fill in the ledger. Duplicate (funderAddress+exchangeFillId or venueTradeId) returns existing record and duplicate: true.
 */
export async function recordFillAndReturnDedupResult(input: RecordFillLedgerEntryInput): Promise<RecordFillAndReturnDedupResult> {
  return recordFillLedgerEntry(input);
}

/**
 * Mark a fill as applied. Returns true if the row was updated (single-apply safe: only unapplied rows are updated).
 */
export async function markFillAppliedSafely(input: MarkFillAppliedInput): Promise<boolean> {
  return markFillApplied(input);
}

export async function getFillByVenueTradeId(venueTradeId: string) {
  return getFillLedgerEntryByVenueTradeId(venueTradeId);
}

/** Get fill by (funderAddress, exchangeFillId). Used to gate position mutation by durable applied state. */
export async function getFillByFunderAndExchangeFillId(funderAddress: string, exchangeFillId: string) {
  return getFillLedgerEntryByFunderAndExchangeFillId(funderAddress, exchangeFillId);
}

/** Applied fills only, for position store rebuild. Order by filledAt. */
export async function getAppliedFillsForRebuild(funderAddress: string): Promise<UnappliedFillRow[]> {
  return getAppliedFillsForRebuildRepo(funderAddress);
}

/**
 * Fills not yet applied to runtime position, ordered by filledAt for replay.
 */
export async function getReplayableUnappliedFills(funderAddress?: string): Promise<UnappliedFillRow[]> {
  return getUnappliedFills(funderAddress);
}

// ----- Cancel / replace -----

export async function createCancelRequestForOrder(input: CreateCancelRequestInput): Promise<string> {
  return createCancelRequest(input);
}

export async function createReplaceRequestForOrder(input: CreateReplaceRequestInput): Promise<string> {
  return createReplaceRequest(input);
}

export async function markCancelRequestStatus(cancelRequestId: string, status: string): Promise<void> {
  return markCancelRequestStatusRepo(cancelRequestId, status);
}

export async function markReplaceRequestStatus(replaceRequestId: string, status: string): Promise<void> {
  return markReplaceRequestStatusRepo(replaceRequestId, status);
}

/** Find executed order by venue order id (e.g. paper exchange order id). */
export async function getExecutedOrderByVenueOrderId(venueOrderId: string) {
  return getExecutedOrderByVenueOrderIdRepo(venueOrderId);
}

/** Update executed order status (e.g. open -> canceled, filled). */
export async function markExecutedOrderStatus(executedOrderId: string, status: string): Promise<void> {
  return markExecutedOrderStatusRepo(executedOrderId, status);
}
