import type { RuntimeEventBus } from "../events/runtime-event-bus";
import { createRuntimeEventId } from "../events/runtime-events";
import type { PositionChangedEvent } from "../events/runtime-events";
import type { RuntimePositionState, RuntimePositionStore } from "./runtime-position-store";

/**
 * Runtime position updater: consumes normalized fill events, updates the in-memory
 * position store immediately, and emits position.changed when material.
 *
 * DESIGN:
 * - RUNTIME LIVE INVENTORY: updates from fills are applied here without waiting for
 *   debounced DB or portfolio recompute. Bot Runtime and Order Manager read from the store.
 * - CANONICAL PROJECTION: DerivedPosition and portfolio recompute remain separate and
 *   debounced; this layer does not replace them.
 *
 * Usage: Subscribe to order.filled (or user WS fills), convert to NormalizedFillInput
 * (e.g. via normalizedFillFromOrderFilled), then applyFill(fill).
 */

export type RuntimeEventSource = "market_ws" | "user_ws" | "bot_runtime" | "order_manager" | "market_state" | "positions" | "risk_engine" | "health" | "system";

/** Normalized fill input (e.g. from order.filled or user WS). */
export interface NormalizedFillInput {
  funderAddress: string;
  assetId: string;
  marketId: string;
  outcome: string;
  side: "BUY" | "SELL";
  /** Filled size in display units. */
  size: number;
  /** Fill price (0–1). */
  price: number;
  filledAt: Date;
}

export interface RuntimePositionUpdaterOptions {
  store: RuntimePositionStore;
  eventBus: RuntimeEventBus;
  /** Funder to use when emitting (default: from fill). */
  eventSource?: RuntimeEventSource;
  /** Emit only when netShares or realizedPnl change exceeds this (default: emit every fill). */
  minNetSharesDelta?: number;
  minRealizedPnlDelta?: number;
}

export interface RuntimePositionUpdater {
  /** Apply a normalized fill: update store and optionally emit position.changed. */
  applyFill(fill: NormalizedFillInput): void;
  /** Update mark price for an asset and emit if position exists (for unrealized PnL). */
  updateMark(funderAddress: string, assetId: string, markPrice: number): void;
}

const DEFAULT_EVENT_SOURCE: RuntimeEventSource = "positions";

function buildPositionChangedPayload(state: RuntimePositionState): {
  funderAddress: string;
  assetId: string;
  marketId: string;
  outcome: string;
  side: "LONG" | "SHORT";
  netShares: number;
  marketValue: number;
  unrealizedPnl: number;
  updatedAt: Date;
} {
  const mark = state.markPrice ?? state.avgEntryPrice;
  const marketValue = state.netShares * mark;
  return {
    funderAddress: state.funderAddress,
    assetId: state.assetId,
    marketId: state.marketId,
    outcome: state.outcome,
    side: state.side,
    netShares: state.netShares,
    marketValue,
    unrealizedPnl: state.unrealizedPnlApprox,
    updatedAt: state.updatedAt,
  };
}

/**
 * Fill-driven position updater: applyFill updates inventory and emits position.changed.
 * Robust to partial/out-of-order: each fill is applied incrementally; avg entry and
 * realized PnL are computed conservatively.
 */
export class DefaultRuntimePositionUpdater implements RuntimePositionUpdater {
  private readonly options: RuntimePositionUpdaterOptions;

  constructor(options: RuntimePositionUpdaterOptions) {
    this.options = options;
  }

  applyFill(fill: NormalizedFillInput): void {
    const { store, eventBus, minNetSharesDelta = 0, minRealizedPnlDelta = 0 } = this.options;
    const prev = store.getPosition(fill.funderAddress, fill.assetId);
    const prevNet = prev?.netShares ?? 0;
    const prevRealized = prev?.realizedPnlApprox ?? 0;

    store.applyFill({
      funderAddress: fill.funderAddress,
      assetId: fill.assetId,
      marketId: fill.marketId,
      outcome: fill.outcome,
      side: fill.side,
      size: fill.size,
      price: fill.price,
      filledAt: fill.filledAt instanceof Date ? fill.filledAt : new Date(fill.filledAt),
    });

    const next = store.getPosition(fill.funderAddress, fill.assetId);
    if (!next) return;

    const netDelta = Math.abs(next.netShares - prevNet);
    const realizedDelta = Math.abs(next.realizedPnlApprox - prevRealized);
    const material = netDelta > minNetSharesDelta || realizedDelta > minRealizedPnlDelta;
    if (!material) return;

    const source = this.options.eventSource ?? DEFAULT_EVENT_SOURCE;
    const payload = buildPositionChangedPayload(next);
    eventBus.publish({
      id: createRuntimeEventId(),
      type: "position.changed",
      source,
      occurredAt: next.updatedAt,
      payload,
    } as PositionChangedEvent);
  }

  updateMark(funderAddress: string, assetId: string, markPrice: number): void {
    const { store, eventBus } = this.options;
    const prev = store.getPosition(funderAddress, assetId);
    if (!prev) return;
    const unrealized = (markPrice - prev.avgEntryPrice) * prev.netShares;
    store.patch(funderAddress, assetId, {
      markPrice,
      unrealizedPnlApprox: unrealized,
      exposureNotional: Math.abs(prev.netShares) * markPrice,
      updatedAt: new Date(),
    });
    const next = store.getPosition(funderAddress, assetId);
    if (!next) return;
    const source = this.options.eventSource ?? DEFAULT_EVENT_SOURCE;
    eventBus.publish({
      id: createRuntimeEventId(),
      type: "position.changed",
      source,
      occurredAt: next.updatedAt,
      payload: buildPositionChangedPayload(next),
    } as PositionChangedEvent);
  }
}

/** Build NormalizedFillInput from order.filled event payload (outcome default if missing). */
export function normalizedFillFromOrderFilled(payload: {
  funderAddress: string;
  assetId: string;
  marketId: string;
  side: "BUY" | "SELL";
  totalFilledSize: number;
  avgPrice: number;
  filledAt: Date;
  outcome?: string;
}): NormalizedFillInput {
  return {
    funderAddress: payload.funderAddress,
    assetId: payload.assetId,
    marketId: payload.marketId,
    outcome: payload.outcome ?? "",
    side: payload.side,
    size: payload.totalFilledSize,
    price: payload.avgPrice,
    filledAt: payload.filledAt instanceof Date ? payload.filledAt : new Date(payload.filledAt),
  };
}

/**
 * Build NormalizedFillInput for a partial-fill delta from order.partial_fill payload.
 * Requires order lookup for marketId and side. Use deltaSize to avoid double-counting
 * when applying cumulative partial fills incrementally.
 */
export function normalizedFillFromOrderPartialFill(
  payload: {
    funderAddress: string;
    assetId: string;
    filledSize: number;
    fillPrice: number;
    filledAt: Date;
  },
  order: { marketId: string; side: "BUY" | "SELL" },
  deltaSize: number
): NormalizedFillInput {
  return {
    funderAddress: payload.funderAddress,
    assetId: payload.assetId,
    marketId: order.marketId,
    outcome: "",
    side: order.side,
    size: deltaSize,
    price: payload.fillPrice,
    filledAt: payload.filledAt instanceof Date ? payload.filledAt : new Date(payload.filledAt),
  };
}
