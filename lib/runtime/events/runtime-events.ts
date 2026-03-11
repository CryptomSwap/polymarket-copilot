/**
 * Core runtime event types for the internal event bus.
 *
 * DESIGN:
 * - Events are normalized and runtime-friendly; no raw Polymarket/CLOB payloads on the bus.
 * - All events include timestamps and identifiers (assetId, marketId, etc.) where relevant.
 * - Producer/consumer boundaries:
 *   - Producers: Market State Engine (market.*), Bot Runtime (order.intent.*), Order Manager (order.*),
 *     Position updater (position.*), Risk Engine (risk.*), Health checker (runtime.health.*), Scheduler (runtime.tick).
 *   - Consumers: Subscribers by type; bus is internal coordination only, not persistence.
 */

export type RuntimeEventSource =
  | "market_ws"
  | "user_ws"
  | "bot_runtime"
  | "order_manager"
  | "market_state"
  | "positions"
  | "risk_engine"
  | "health"
  | "system";

/** Normalized runtime event type strings. Dot notation for namespacing. */
export type RuntimeEventType =
  // --- Market (producer: Market State Engine / market WS feed)
  | "market.quote.changed"
  | "market.depth.changed"
  | "market.trade.printed"
  | "market.volatility.changed"
  | "market.liquidity.changed"
  | "market.stale"
  | "market.recovered"
  | "market.repaired"
  // --- Regime (producer: regime scanner / market state)
  | "regime.changed"
  // --- Position (producer: Runtime Position updater / user WS)
  | "position.changed"
  // --- Order intents and lifecycle (producer: Bot Runtime → Order Manager / user WS)
  | "order.intent.created"
  | "bot.decision.evaluated"
  | "order.submitted"
  | "order.ack"
  | "order.partial_fill"
  | "order.filled"
  | "order.canceled"
  | "order.rejected"
  | "order.stale"
  // --- Risk (producer: Risk Engine)
  | "risk.limit_hit"
  | "risk.kill_switch_changed"
  // --- Runtime health (producer: health checker)
  | "runtime.health.changed"
  // --- Scheduler / tick (producer: Bot Scheduler)
  | "runtime.tick";

/** Base envelope for every runtime event. */
export interface RuntimeEventBase<TType extends RuntimeEventType = RuntimeEventType, TPayload = unknown> {
  id: string;
  type: TType;
  source: RuntimeEventSource;
  occurredAt: Date;
  payload: TPayload;
}

// ---------- Market event payloads (normalized; no raw upstream payloads) ----------

export interface MarketQuotePayload {
  assetId: string;
  marketId: string;
  outcome: string;
  /** Best bid price (0–1 for probability markets). */
  bestBid: number | null;
  bestAsk: number | null;
  midPrice: number | null;
  lastTradePrice: number | null;
}

export interface MarketDepthPayload {
  assetId: string;
  marketId: string;
  outcome: string;
  /** Top-of-book bid/ask sizes (display units). */
  bestBidSize: number;
  bestAskSize: number;
  /** Optional depth levels; keep minimal for hot path. */
  bidDepth?: number;
  askDepth?: number;
}

export interface MarketTradePrintedPayload {
  assetId: string;
  marketId: string;
  outcome: string;
  price: number;
  size: number;
  side: "BUY" | "SELL";
}

export interface MarketVolatilityPayload {
  assetId: string;
  marketId: string;
  /** Short-horizon volatility metric (e.g. bps or probability change). */
  volatility: number;
  windowMs?: number;
}

export interface MarketLiquidityPayload {
  assetId: string;
  marketId: string;
  /** Combined top-of-book liquidity (notional). */
  topLiquidity: number;
  spreadBps?: number | null;
}

export interface MarketStalePayload {
  assetId: string;
  marketId: string;
  /** Last update timestamp before staleness. */
  lastUpdateAt: Date;
  staleAfterMs: number;
}

export interface MarketRecoveredPayload {
  assetId: string;
  marketId: string;
  /** When recovery was detected. */
  recoveredAt: Date;
}

export interface MarketRepairedPayload {
  assetId: string;
  marketId: string;
  /** Brief reason (e.g. "resubscribed", "snapshot_applied"). */
  reason: string;
  repairedAt: Date;
}

// ---------- Regime ----------

export interface RegimeChangedPayload {
  assetId: string;
  marketId: string;
  previousRegime: string | null;
  currentRegime: string;
  changedAt: Date;
}

// ---------- Position ----------

export interface PositionChangedPayload {
  funderAddress: string;
  assetId: string;
  marketId: string;
  outcome: string;
  side: "LONG" | "SHORT";
  netShares: number;
  marketValue: number;
  unrealizedPnl: number;
  updatedAt: Date;
}

// ---------- Order intents and lifecycle ----------

export interface OrderIntentCreatedPayload {
  funderAddress: string;
  strategyId: string;
  assetId: string;
  marketId: string;
  side: "BUY" | "SELL";
  size: number;
  limitPrice: number;
  /** Optional idempotency key. */
  intentId?: string;
}

/** Read-only decision evaluation telemetry (no order placed). */
export interface BotDecisionEvaluatedPayload {
  funderAddress: string;
  strategyId: string;
  assetId: string;
  marketId?: string;
  action: string;
  reason: string;
  asOf: Date;
  metadata?: Record<string, unknown>;
}

export interface OrderSubmittedPayload {
  funderAddress: string;
  runtimeOrderId: string;
  externalOrderId: string | null;
  assetId: string;
  marketId: string;
  side: "BUY" | "SELL";
  size: number;
  limitPrice: number;
  submittedAt: Date;
}

export interface OrderAckPayload {
  funderAddress: string;
  runtimeOrderId: string;
  externalOrderId: string;
  assetId: string;
  acknowledgedAt: Date;
}

export interface OrderPartialFillPayload {
  funderAddress: string;
  runtimeOrderId: string;
  externalOrderId: string;
  assetId: string;
  filledSize: number;
  remainingSize: number;
  fillPrice: number;
  filledAt: Date;
}

export interface OrderFilledPayload {
  funderAddress: string;
  runtimeOrderId: string;
  externalOrderId: string;
  assetId: string;
  marketId: string;
  side: "BUY" | "SELL";
  totalFilledSize: number;
  avgPrice: number;
  filledAt: Date;
}

export interface OrderCanceledPayload {
  funderAddress: string;
  runtimeOrderId: string;
  externalOrderId: string;
  assetId: string;
  canceledAt: Date;
  reason?: string;
}

export interface OrderRejectedPayload {
  funderAddress: string;
  runtimeOrderId: string;
  assetId: string;
  rejectedAt: Date;
  reason: string;
}

export interface OrderStalePayload {
  funderAddress: string;
  runtimeOrderId: string;
  externalOrderId: string | null;
  assetId: string;
  staleAt: Date;
  reason: string;
}

// ---------- Risk ----------

export interface RiskLimitHitPayload {
  funderAddress: string;
  limitType: string;
  currentValue: number;
  limitValue: number;
  breachedAt: Date;
}

export interface RiskKillSwitchChangedPayload {
  enabled: boolean;
  reason: string | null;
  changedAt: Date;
}

// ---------- Runtime health ----------

export interface RuntimeHealthChangedPayload {
  status: "healthy" | "degraded" | "unhealthy";
  summary: string;
  reasons: string[];
  evaluatedAt: Date;
}

// ---------- Tick ----------

export interface RuntimeTickPayload {
  tickId: string;
  asOf: Date;
  /** Optional: which strategy or scheduler produced the tick. */
  strategyId?: string;
}

// ---------- Typed event unions ----------

export type MarketQuoteChangedEvent = RuntimeEventBase<"market.quote.changed", MarketQuotePayload>;
export type MarketDepthChangedEvent = RuntimeEventBase<"market.depth.changed", MarketDepthPayload>;
export type MarketTradePrintedEvent = RuntimeEventBase<"market.trade.printed", MarketTradePrintedPayload>;
export type MarketVolatilityChangedEvent = RuntimeEventBase<"market.volatility.changed", MarketVolatilityPayload>;
export type MarketLiquidityChangedEvent = RuntimeEventBase<"market.liquidity.changed", MarketLiquidityPayload>;
export type MarketStaleEvent = RuntimeEventBase<"market.stale", MarketStalePayload>;
export type MarketRecoveredEvent = RuntimeEventBase<"market.recovered", MarketRecoveredPayload>;
export type MarketRepairedEvent = RuntimeEventBase<"market.repaired", MarketRepairedPayload>;
export type RegimeChangedEvent = RuntimeEventBase<"regime.changed", RegimeChangedPayload>;
export type PositionChangedEvent = RuntimeEventBase<"position.changed", PositionChangedPayload>;
export type OrderIntentCreatedEvent = RuntimeEventBase<"order.intent.created", OrderIntentCreatedPayload>;
export type BotDecisionEvaluatedEvent = RuntimeEventBase<"bot.decision.evaluated", BotDecisionEvaluatedPayload>;
export type OrderSubmittedEvent = RuntimeEventBase<"order.submitted", OrderSubmittedPayload>;
export type OrderAckEvent = RuntimeEventBase<"order.ack", OrderAckPayload>;
export type OrderPartialFillEvent = RuntimeEventBase<"order.partial_fill", OrderPartialFillPayload>;
export type OrderFilledEvent = RuntimeEventBase<"order.filled", OrderFilledPayload>;
export type OrderCanceledEvent = RuntimeEventBase<"order.canceled", OrderCanceledPayload>;
export type OrderRejectedEvent = RuntimeEventBase<"order.rejected", OrderRejectedPayload>;
export type OrderStaleEvent = RuntimeEventBase<"order.stale", OrderStalePayload>;
export type RiskLimitHitEvent = RuntimeEventBase<"risk.limit_hit", RiskLimitHitPayload>;
export type RiskKillSwitchChangedEvent = RuntimeEventBase<"risk.kill_switch_changed", RiskKillSwitchChangedPayload>;
export type RuntimeHealthChangedEvent = RuntimeEventBase<"runtime.health.changed", RuntimeHealthChangedPayload>;
export type RuntimeTickEvent = RuntimeEventBase<"runtime.tick", RuntimeTickPayload>;

export type RuntimeEvent =
  | MarketQuoteChangedEvent
  | MarketDepthChangedEvent
  | BotDecisionEvaluatedEvent
  | MarketTradePrintedEvent
  | MarketVolatilityChangedEvent
  | MarketLiquidityChangedEvent
  | MarketStaleEvent
  | MarketRecoveredEvent
  | MarketRepairedEvent
  | RegimeChangedEvent
  | PositionChangedEvent
  | OrderIntentCreatedEvent
  | OrderSubmittedEvent
  | OrderAckEvent
  | OrderPartialFillEvent
  | OrderFilledEvent
  | OrderCanceledEvent
  | OrderRejectedEvent
  | OrderStaleEvent
  | RiskLimitHitEvent
  | RiskKillSwitchChangedEvent
  | RuntimeHealthChangedEvent
  | RuntimeTickEvent;

/** Wildcard subscription key: subscribe to all event types. */
export const RUNTIME_EVENT_BUS_WILDCARD = "*" as const;
export type RuntimeEventTypeOrWildcard = RuntimeEventType | typeof RUNTIME_EVENT_BUS_WILDCARD;

/** Generate a simple unique id for events (caller can override). */
export function createRuntimeEventId(): string {
  return `evt_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}
