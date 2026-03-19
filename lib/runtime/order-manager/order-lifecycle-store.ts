import type { RuntimeOrderState, RuntimeOrderStatus } from "./order-manager";

/**
 * In-memory order lifecycle store. No Prisma on hot path.
 * Create local orders, apply acks/fills/cancels; list working/open by asset; snapshot; stale detection.
 *
 * Numeric invariants (enforced in mutators):
 * - filledSize <= order.size (never overfill)
 * - remainingSize = size - filledSize, always >= 0
 * - appliedPositionFilledSize <= filledSize (capped in setAppliedPositionFilledSize)
 * Terminal states (filled, canceled, rejected, expired) are immutable; no further lifecycle mutations.
 */

const OPEN_STATUSES: RuntimeOrderStatus[] = [
  "pending_submit",
  "working",
  "partially_filled",
  "pending_cancel",
];

const TERMINAL_STATUSES: RuntimeOrderStatus[] = ["filled", "canceled", "rejected", "expired"];

/** Ambiguous execution states: no further auto transitions until verification. */
const AMBIGUOUS_STATUSES: RuntimeOrderStatus[] = [
  "submit_ambiguous",
  "cancel_ambiguous",
  "replace_ambiguous",
  "exchange_ack_timeout",
  "execution_verification_required",
];

function isOpen(status: RuntimeOrderStatus): boolean {
  return OPEN_STATUSES.includes(status);
}

function isTerminal(status: RuntimeOrderStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

function isAmbiguous(status: RuntimeOrderStatus): boolean {
  return AMBIGUOUS_STATUSES.includes(status);
}

/** Allowed transitions for lifecycle mutations. */
function canTransitionTo(current: RuntimeOrderStatus, next: RuntimeOrderStatus): boolean {
  if (current === "pending_submit") return next === "working" || next === "rejected";
  if (current === "working" || current === "partially_filled") return next === "partially_filled" || next === "filled" || next === "canceled";
  if (current === "pending_cancel") return next === "canceled";
  return false;
}

function cloneOrder(o: RuntimeOrderState): RuntimeOrderState {
  return {
    ...o,
    appliedPositionFilledSize: o.appliedPositionFilledSize ?? 0,
    createdAt: new Date(o.createdAt.getTime()),
    updatedAt: new Date(o.updatedAt.getTime()),
    lastAckAt: o.lastAckAt ? new Date(o.lastAckAt.getTime()) : null,
    lastFillAt: o.lastFillAt ? new Date(o.lastFillAt.getTime()) : null,
  };
}

export interface CreateOrderParams {
  clientOrderId: string;
  funderAddress: string;
  assetId: string;
  marketId: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  intentId?: string | null;
  staleAfterMs?: number;
  replaceGroupKey?: string | null;
}

export interface OrderLifecycleStore {
  get(clientOrderId: string): RuntimeOrderState | null;
  getByExternalId(exchangeOrderId: string): RuntimeOrderState | null;
  getAll(): RuntimeOrderState[];
  /** Create a new order in pending_submit. */
  create(params: CreateOrderParams): RuntimeOrderState;
  /** Update status only. */
  updateStatus(clientOrderId: string, status: RuntimeOrderStatus): void;
  /** Set exchange id and move to working; set lastAckAt. */
  applyAck(clientOrderId: string, exchangeOrderId: string): void;
  /** Add fill; update filledSize/remainingSize; set status partially_filled or filled. */
  applyPartialFill(clientOrderId: string, fillSize: number, fillPrice: number): void;
  applyFill(clientOrderId: string, fillSize: number, fillPrice: number): void;
  applyCancel(clientOrderId: string): void;
  applyReject(clientOrderId: string): void;
  /** Orders that are working or partially_filled (resting on book). */
  listWorkingByAsset(funderAddress: string, assetId: string): RuntimeOrderState[];
  /** All open (pending_submit, working, partially_filled, pending_cancel). */
  listOpenByAsset(funderAddress: string, assetId: string): RuntimeOrderState[];
  snapshot(): RuntimeOrderState[];
  /** Orders that are open and past staleAfterMs since createdAt/lastAckAt. */
  getStaleCandidates(now?: Date): RuntimeOrderState[];
  /** Orders in pending_submit with no ack, older than ms (for sweeper). */
  getPendingSubmitOlderThan(ms: number, now?: Date): RuntimeOrderState[];
  /** Orders in working or partially_filled, last activity older than ms (for sweeper). */
  getWorkingOlderThan(ms: number, now?: Date): RuntimeOrderState[];
  /** Set cumulative filled size already applied to position (idempotency). Capped to order.filledSize; monotonic (only updates if newValue >= current). */
  setAppliedPositionFilledSize(clientOrderId: string, newValue: number): void;
  upsert(state: RuntimeOrderState): void;
  delete(clientOrderId: string): void;
  clear(): void;
}

const DEFAULT_STALE_MS = 120_000;
const ORDER_TERMINAL_TTL_MS =
  Number(process.env.RUNTIME_ORDER_TERMINAL_TTL_MS ?? String(6 * 60 * 60 * 1000)) ||
  6 * 60 * 60 * 1000;
const ORDER_TERMINAL_MAX =
  Number(process.env.RUNTIME_ORDER_TERMINAL_MAX ?? "4000") || 4000;

export class InMemoryOrderLifecycleStore implements OrderLifecycleStore {
  private readonly byClientId = new Map<string, RuntimeOrderState>();
  private readonly byExternalId = new Map<string, RuntimeOrderState>();
  private mutationCount = 0;

  private maybePruneTerminal(now: Date = new Date()): void {
    this.mutationCount++;
    if (this.mutationCount % 200 !== 0) return;
    const cutoff = now.getTime() - ORDER_TERMINAL_TTL_MS;
    const terminal: Array<{ id: string; updatedAt: number; exchangeOrderId: string | null }> = [];
    for (const [id, o] of this.byClientId.entries()) {
      if (!isTerminal(o.status)) continue;
      terminal.push({ id, updatedAt: o.updatedAt.getTime(), exchangeOrderId: o.exchangeOrderId ?? null });
      if (o.updatedAt.getTime() < cutoff) {
        if (o.exchangeOrderId) this.byExternalId.delete(o.exchangeOrderId);
        this.byClientId.delete(id);
      }
    }
    if (terminal.length <= ORDER_TERMINAL_MAX) return;
    terminal.sort((a, b) => a.updatedAt - b.updatedAt);
    const excess = terminal.length - ORDER_TERMINAL_MAX;
    for (let i = 0; i < excess; i++) {
      const t = terminal[i];
      if (t.exchangeOrderId) this.byExternalId.delete(t.exchangeOrderId);
      this.byClientId.delete(t.id);
    }
  }

  private toLegacy(state: RuntimeOrderState): RuntimeOrderState {
    return {
      ...state,
      appliedPositionFilledSize: state.appliedPositionFilledSize ?? 0,
      runtimeOrderId: state.clientOrderId,
      externalOrderId: state.exchangeOrderId,
      limitPrice: state.price,
      desiredSize: state.size,
    };
  }

  get(clientOrderId: string): RuntimeOrderState | null {
    const o = this.byClientId.get(clientOrderId);
    return o ? this.toLegacy(cloneOrder(o)) : null;
  }

  getByExternalId(exchangeOrderId: string): RuntimeOrderState | null {
    const o = this.byExternalId.get(exchangeOrderId);
    return o ? this.toLegacy(cloneOrder(o)) : null;
  }

  getAll(): RuntimeOrderState[] {
    return Array.from(this.byClientId.values()).map((o) => this.toLegacy(cloneOrder(o)));
  }

  create(params: CreateOrderParams): RuntimeOrderState {
    const now = new Date();
    const state: RuntimeOrderState = {
      clientOrderId: params.clientOrderId,
      runtimeOrderId: params.clientOrderId,
      exchangeOrderId: null,
      externalOrderId: null,
      funderAddress: params.funderAddress,
      assetId: params.assetId,
      marketId: params.marketId,
      side: params.side,
      price: params.price,
      limitPrice: params.price,
      size: params.size,
      desiredSize: params.size,
      filledSize: 0,
      remainingSize: params.size,
      status: "pending_submit",
      intentId: params.intentId ?? null,
      createdAt: now,
      updatedAt: now,
      lastAckAt: null,
      staleAfterMs: params.staleAfterMs ?? DEFAULT_STALE_MS,
      replaceGroupKey: params.replaceGroupKey ?? null,
      lastFillAt: null,
      appliedPositionFilledSize: 0,
    };
    this.byClientId.set(params.clientOrderId, state);
    this.maybePruneTerminal(now);
    return this.toLegacy(cloneOrder(state));
  }

  updateStatus(clientOrderId: string, status: RuntimeOrderStatus): void {
    const o = this.byClientId.get(clientOrderId);
    if (!o) return;
    if (isTerminal(o.status)) return;
    if (isAmbiguous(o.status)) return;
    const next = { ...o, status, updatedAt: new Date() };
    this.byClientId.set(clientOrderId, next);
    this.maybePruneTerminal(next.updatedAt);
  }

  applyAck(clientOrderId: string, exchangeOrderId: string): void {
    const o = this.byClientId.get(clientOrderId);
    if (!o) return;
    if (o.status !== "pending_submit") return;
    if (isAmbiguous(o.status)) return;
    const now = new Date();
    const next: RuntimeOrderState = {
      ...o,
      exchangeOrderId,
      externalOrderId: exchangeOrderId,
      status: "working",
      lastAckAt: now,
      updatedAt: now,
    };
    this.byClientId.set(clientOrderId, next);
    this.byExternalId.set(exchangeOrderId, next);
    this.maybePruneTerminal(now);
  }

  applyPartialFill(clientOrderId: string, fillSize: number, _fillPrice: number): void {
    const o = this.byClientId.get(clientOrderId);
    if (!o || fillSize <= 0) return;
    if (o.status !== "working" && o.status !== "partially_filled") return;
    const newFilled = Math.min(o.size, o.filledSize + fillSize);
    const newRemaining = o.size - newFilled;
    const now = new Date();
    const status: RuntimeOrderStatus = newRemaining === 0 ? "filled" : "partially_filled";
    const next: RuntimeOrderState = {
      ...o,
      filledSize: newFilled,
      remainingSize: newRemaining,
      status,
      updatedAt: now,
      lastFillAt: now,
    };
    this.byClientId.set(clientOrderId, next);
    if (o.exchangeOrderId) this.byExternalId.set(o.exchangeOrderId, next);
    this.maybePruneTerminal(now);
  }

  applyFill(clientOrderId: string, fillSize: number, fillPrice: number): void {
    this.applyPartialFill(clientOrderId, fillSize, fillPrice);
  }

  applyCancel(clientOrderId: string): void {
    const o = this.byClientId.get(clientOrderId);
    if (!o) return;
    if (isTerminal(o.status)) return;
    if (!isOpen(o.status)) return;
    const now = new Date();
    const next: RuntimeOrderState = { ...o, status: "canceled", updatedAt: now };
    this.byClientId.set(clientOrderId, next);
    if (o.exchangeOrderId) this.byExternalId.set(o.exchangeOrderId, next);
    this.maybePruneTerminal(now);
  }

  applyReject(clientOrderId: string): void {
    const o = this.byClientId.get(clientOrderId);
    if (!o) return;
    if (o.status !== "pending_submit") return;
    const now = new Date();
    const next: RuntimeOrderState = { ...o, status: "rejected", updatedAt: now };
    this.byClientId.set(clientOrderId, next);
    if (o.exchangeOrderId) this.byExternalId.delete(o.exchangeOrderId);
    this.maybePruneTerminal(now);
  }

  setAppliedPositionFilledSize(clientOrderId: string, newValue: number): void {
    const o = this.byClientId.get(clientOrderId);
    if (!o) return;
    const current = o.appliedPositionFilledSize ?? 0;
    const capped = Math.min(newValue, o.filledSize);
    if (capped < current) return;
    const next = { ...o, appliedPositionFilledSize: capped, updatedAt: new Date() };
    this.byClientId.set(clientOrderId, next);
    if (o.exchangeOrderId) this.byExternalId.set(o.exchangeOrderId, next);
    this.maybePruneTerminal(next.updatedAt);
  }

  listWorkingByAsset(funderAddress: string, assetId: string): RuntimeOrderState[] {
    const f = funderAddress.toLowerCase();
    return Array.from(this.byClientId.values())
      .filter(
        (o) =>
          o.funderAddress.toLowerCase() === f &&
          o.assetId === assetId &&
          (o.status === "working" || o.status === "partially_filled")
      )
      .map((o) => this.toLegacy(cloneOrder(o)));
  }

  listOpenByAsset(funderAddress: string, assetId: string): RuntimeOrderState[] {
    const f = funderAddress.toLowerCase();
    return Array.from(this.byClientId.values())
      .filter(
        (o) =>
          o.funderAddress.toLowerCase() === f &&
          o.assetId === assetId &&
          isOpen(o.status)
      )
      .map((o) => this.toLegacy(cloneOrder(o)));
  }

  snapshot(): RuntimeOrderState[] {
    return this.getAll();
  }

  getStaleCandidates(now: Date = new Date()): RuntimeOrderState[] {
    const t = now.getTime();
    return Array.from(this.byClientId.values())
      .filter((o) => {
        if (!isOpen(o.status)) return false;
        const ref = o.lastAckAt ?? o.createdAt;
        return t - ref.getTime() >= o.staleAfterMs;
      })
      .map((o) => this.toLegacy(cloneOrder(o)));
  }

  getPendingSubmitOlderThan(ms: number, now: Date = new Date()): RuntimeOrderState[] {
    const t = now.getTime();
    return Array.from(this.byClientId.values())
      .filter(
        (o) =>
          o.status === "pending_submit" &&
          t - o.createdAt.getTime() >= ms
      )
      .map((o) => this.toLegacy(cloneOrder(o)));
  }

  getWorkingOlderThan(ms: number, now: Date = new Date()): RuntimeOrderState[] {
    const t = now.getTime();
    return Array.from(this.byClientId.values())
      .filter((o) => {
        if (o.status !== "working" && o.status !== "partially_filled") return false;
        const ref = o.lastFillAt ?? o.lastAckAt ?? o.createdAt;
        return ref != null && t - ref.getTime() >= ms;
      })
      .map((o) => this.toLegacy(cloneOrder(o)));
  }

  upsert(state: RuntimeOrderState): void {
    const id = state.clientOrderId;
    const normalized: RuntimeOrderState = {
      ...state,
      appliedPositionFilledSize: state.appliedPositionFilledSize ?? 0,
      runtimeOrderId: state.runtimeOrderId ?? id,
      externalOrderId: state.externalOrderId ?? state.exchangeOrderId,
      limitPrice: state.limitPrice ?? state.price,
      desiredSize: state.desiredSize ?? state.size,
      createdAt: state.createdAt instanceof Date ? state.createdAt : new Date(state.createdAt as unknown as string),
      updatedAt: state.updatedAt instanceof Date ? state.updatedAt : new Date(state.updatedAt as unknown as string),
      lastAckAt: state.lastAckAt ? new Date(state.lastAckAt.getTime()) : null,
      lastFillAt: state.lastFillAt ? new Date(state.lastFillAt.getTime()) : null,
    };
    this.byClientId.set(id, normalized);
    if (normalized.exchangeOrderId) {
      this.byExternalId.set(normalized.exchangeOrderId, normalized);
    }
    this.maybePruneTerminal(normalized.updatedAt);
  }

  delete(clientOrderId: string): void {
    const o = this.byClientId.get(clientOrderId);
    if (o?.exchangeOrderId) this.byExternalId.delete(o.exchangeOrderId);
    this.byClientId.delete(clientOrderId);
  }

  clear(): void {
    this.byClientId.clear();
    this.byExternalId.clear();
  }
}
