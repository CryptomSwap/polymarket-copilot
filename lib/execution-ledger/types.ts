/**
 * Application-layer types for the execution ledger. Stable, app-facing types;
 * not raw Prisma model types. Used by repository and service.
 */

// ----- Order intent -----

export interface CreateOrderIntentInput {
  funderAddress: string;
  recommendationId?: string | null;
  source?: string | null;
  marketId: string;
  assetId: string;
  outcome: string;
  side: string;
  orderType: string;
  limitPrice: string;
  requestedSize: string;
  status: string;
  idempotencyKey?: string | null;
  decisionSnapshotId?: string | null;
  riskPreviewJson?: string | null;
  riskCheckSnapshotJson?: string | null;
  executionPolicySnapshotJson?: string | null;
  metadataJson?: string | null;
}

export interface AppendOrderIntentEventInput {
  orderIntentId: string;
  eventType: string;
  payloadJson?: string | null;
}

export interface OrderIntentRecord {
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
}

// ----- Executed order -----

export interface CreateExecutedOrderInput {
  funderAddress: string;
  orderIntentId?: string | null;
  venue?: string | null;
  polymarketOrderId: string;
  venueOrderId?: string | null;
  marketId: string;
  assetId: string;
  side: string;
  orderType?: string | null;
  price: string;
  size: string;
  originalSize?: string | null;
  remainingSize?: string | null;
  status: string;
  rawJson?: string | null;
  metadataJson?: string | null;
}

export interface AppendExecutedOrderEventInput {
  executedOrderId: string;
  eventType: string;
  payloadJson?: string | null;
}

export interface ExecutedOrderRecord {
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
}

// ----- Fill ledger -----

export type FillLedgerSource = "user_feed" | "replay" | "execution_ledger";

export interface RecordFillLedgerEntryInput {
  funderAddress: string;
  /** Legacy dedupe key; required when venueTradeId not provided. */
  exchangeFillId: string;
  clientOrderId?: string | null;
  exchangeOrderId?: string | null;
  executedOrderId?: string | null;
  orderIntentId?: string | null;
  /** Venue-specific trade id; unique. When set, used for dedupe in addition to exchangeFillId. */
  venueTradeId?: string | null;
  assetId: string;
  marketId: string;
  side: string;
  fillSize: number;
  fillPrice: number;
  fee?: number | null;
  filledAt: Date;
  source: FillLedgerSource;
  payloadJson?: string | null;
  rawPayloadJson?: string | null;
}

export interface MarkFillAppliedInput {
  id?: string;
  funderAddress?: string;
  exchangeFillId?: string;
  venueTradeId?: string;
}

export interface FillLedgerRecord {
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
}

// ----- Cancel / replace -----

export interface CreateCancelRequestInput {
  executedOrderId: string;
  status: string;
  reason?: string | null;
  venueRequestId?: string | null;
}

export interface CreateReplaceRequestInput {
  executedOrderId: string;
  newPrice?: string | null;
  newSize?: string | null;
  status: string;
  reason?: string | null;
  venueRequestId?: string | null;
}

// ----- Timeline and replay -----

export interface ExecutionTimelineRow {
  kind: "intent" | "intent_event" | "executed_order" | "order_event" | "fill" | "cancel_request" | "replace_request";
  occurredAt: Date;
  id: string;
  orderIntentId?: string | null;
  executedOrderId?: string | null;
  eventType?: string | null;
  payloadJson?: string | null;
  /** For intent: full record id. For event: parent intent/order id. */
  parentId?: string | null;
}

export interface UnappliedFillRow {
  id: string;
  funderAddress: string;
  exchangeFillId: string;
  venueTradeId: string | null;
  assetId: string;
  marketId: string;
  side: string;
  size: number;
  price: number;
  filledAt: Date;
  outcome: string;
}
