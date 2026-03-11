/**
 * Runtime event bus and normalized event types.
 * Internal coordination only; not wired into production flows yet.
 */

export {
  RUNTIME_EVENT_BUS_WILDCARD,
  createRuntimeEventId,
  type RuntimeEvent,
  type RuntimeEventBase,
  type RuntimeEventSource,
  type RuntimeEventType,
  type RuntimeEventTypeOrWildcard,
  type MarketQuotePayload,
  type MarketDepthPayload,
  type MarketTradePrintedPayload,
  type MarketVolatilityPayload,
  type MarketLiquidityPayload,
  type MarketStalePayload,
  type MarketRecoveredPayload,
  type MarketRepairedPayload,
  type RegimeChangedPayload,
  type PositionChangedPayload,
  type OrderIntentCreatedPayload,
  type OrderSubmittedPayload,
  type OrderAckPayload,
  type OrderPartialFillPayload,
  type OrderFilledPayload,
  type OrderCanceledPayload,
  type OrderRejectedPayload,
  type OrderStalePayload,
  type RiskLimitHitPayload,
  type RiskKillSwitchChangedPayload,
  type RuntimeHealthChangedPayload,
  type RuntimeTickPayload,
} from "./runtime-events";

export {
  InMemoryRuntimeEventBus,
  type RuntimeEventBus,
  type RuntimeEventHandler,
  type RuntimeEventBusSubscribeOptions,
} from "./runtime-event-bus";
