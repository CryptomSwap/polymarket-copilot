/**
 * Order Manager: reconciles desired actions vs. actual order state.
 * Bot runtime decides what it wants; this layer produces place/cancel/replace plans.
 * Paper mode: no live exchange calls; emits actions/events/telemetry only.
 *
 * Lifecycle: use OrderLifecycleHandler (order-lifecycle-handler.ts) to apply normalized
 * ack/partial fill/full fill/cancel/reject to the store and emit order.* events.
 * Stale orders: use OrderStaleSweeper (order-stale-sweeper.ts) to identify and cancel stale orders.
 */

export type RuntimeOrderStatus =
  | "pending_submit"
  | "working"
  | "partially_filled"
  | "pending_cancel"
  | "canceled"
  | "filled"
  | "rejected"
  | "expired"
  | "unknown"
  // Execution failure / ambiguity (fail closed; no hide under working/unknown)
  | "submit_ambiguous"
  | "cancel_ambiguous"
  | "replace_ambiguous"
  | "exchange_ack_timeout"
  | "execution_verification_required";

/** In-memory order state; keyed by clientOrderId. */
export interface RuntimeOrderState {
  /** Our id (primary key). */
  clientOrderId: string;
  /** @deprecated Use clientOrderId. Same value for compat. */
  runtimeOrderId: string;
  /** Exchange order id once acked. */
  exchangeOrderId: string | null;
  /** @deprecated Use exchangeOrderId. */
  externalOrderId: string | null;
  funderAddress: string;
  assetId: string;
  marketId: string;
  side: "BUY" | "SELL";
  /** Limit price (0–1). */
  price: number;
  /** @deprecated Use price. */
  limitPrice: number;
  /** Original order size. */
  size: number;
  /** @deprecated Use size. */
  desiredSize: number;
  /** Working size on book (for compat with old workingSize). */
  remainingSize: number;
  filledSize: number;
  status: RuntimeOrderStatus;
  /** Idempotency key from intent. */
  intentId: string | null;
  createdAt: Date;
  updatedAt: Date;
  lastAckAt: Date | null;
  /** Consider stale if no ack/fill after this many ms. */
  staleAfterMs: number;
  /** Optional group for cancel-replace (e.g. same asset/side). */
  replaceGroupKey: string | null;
  /** Time of last partial or full fill (for lifecycle/maintenance). */
  lastFillAt: Date | null;
  /** Cumulative filled size already applied to position store (idempotency for replay). Invariant: 0 <= appliedPositionFilledSize <= filledSize. */
  appliedPositionFilledSize: number;
}

// ---------- Normalized lifecycle event inputs (for handler / exchange seam) ----------

export interface OrderAckInput {
  clientOrderId: string;
  exchangeOrderId: string;
  acknowledgedAt: Date;
}

export interface OrderPartialFillInput {
  clientOrderId: string;
  fillSize: number;
  fillPrice: number;
  filledAt: Date;
  /** For durable fill ledger: dedupe and mark applied after position update. */
  exchangeFillId?: string | null;
}

export interface OrderFullFillInput {
  clientOrderId: string;
  totalFilledSize: number;
  avgPrice: number;
  filledAt: Date;
  /** For durable fill ledger: dedupe and mark applied after position update. */
  exchangeFillId?: string | null;
}

export interface OrderCancelAckInput {
  clientOrderId: string;
  canceledAt: Date;
  reason?: string;
}

export interface OrderRejectInput {
  clientOrderId: string;
  rejectedAt: Date;
  reason: string;
}

/** @deprecated Use RuntimeOrderStatus. */
export type RuntimeOrderLifecycleStatus = RuntimeOrderStatus;

/** Normalized order intent (from Bot Runtime / order.intent.created). */
export interface OrderIntent {
  funderAddress: string;
  strategyId: string;
  assetId: string;
  marketId: string;
  side: "BUY" | "SELL";
  size: number;
  limitPrice: number;
  intentId?: string;
}

export interface OrderManager {
  /** Reconcile desired intents vs current lifecycle state; produce and emit paper actions. */
  reconcileIntents(intents: OrderIntent[]): Promise<void>;
}
