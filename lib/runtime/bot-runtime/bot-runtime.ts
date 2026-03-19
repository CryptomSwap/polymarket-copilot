import type { RuntimeEventBus } from "../events/runtime-event-bus";
import {
  createRuntimeEventId,
  type RuntimeEventSource,
} from "../events/runtime-events";
import type { MarketStateStore } from "../market-state/market-state-store";
import type {
  BotDecisionEnvelope,
  BotDecisionOutput,
  BotAssetRuntimeState,
  BotDecisionContext,
} from "./bot-decision-types";
import type { BotRuntimeContextProvider } from "./bot-context";
import { buildBotDecisionContext } from "./bot-context";
import { EventDrivenBotScheduler, DEFAULT_SCHEDULER_OVERLOAD_CONFIG } from "./bot-scheduler";
import type { TriggerPriority, SchedulerOverloadConfig, SchedulerDiagnosticsCallback } from "./bot-scheduler";
import type { RuntimeEvent } from "../events/runtime-events";
import { evaluateLiveStrategyPlaceholder } from "./live-strategy-placeholder";
import type { LiveStrategyPlaceholderConfig } from "./live-strategy-placeholder";

const EVENT_SOURCE: RuntimeEventSource = "bot_runtime";

/** Per-asset state held by the runtime (read-only view for callers). */
function defaultAssetState(assetId: string): BotAssetRuntimeState {
  return {
    assetId,
    lastEvaluatedAt: null,
    lastDecisionAt: null,
    cooldownUntil: null,
    activeIntentId: null,
    lastSignal: null,
    mode: "idle",
  };
}

export interface BotRuntimeOptions {
  contextProvider: BotRuntimeContextProvider;
  eventBus: RuntimeEventBus;
  funderAddress: string;
  strategyId: string;
  /** Coalesce window in ms for the event-driven scheduler (e.g. 25–100). */
  coalesceMs: number;
  /** Optional: overload protection (max queue, thresholds). */
  schedulerOverloadConfig?: SchedulerOverloadConfig;
  /** Optional: record coalesced/dropped/latency/overload for diagnostics. */
  schedulerDiagnostics?: SchedulerDiagnosticsCallback;
  /** Optional: provide open orders for an asset (e.g. from OrderLifecycleStore). */
  getOpenOrdersForAsset?: (funderAddress: string, assetId: string) => import("../order-manager/order-manager").RuntimeOrderState[];
  /** Optional: market store for getTrackedAssetIds on risk/global events. */
  marketStateStore?: MarketStateStore;
  /** Optional: config for live strategy placeholder (thresholds, min spread/liquidity). */
  strategyConfig?: LiveStrategyPlaceholderConfig;
}

export interface BotRuntime {
  start(): void;
  stop(): void;
  /** Read-only per-asset state. */
  getAssetState(assetId: string): BotAssetRuntimeState | null;
  /** Current scheduler queue size (pending evaluations). For health/backlog reporting. */
  getSchedulerBacklog(): number;
  /** Number of assets currently being evaluated. */
  getSchedulerInFlight(): number;
}

/**
 * Event-driven bot runtime: subscribes to market/position/order/regime/risk events,
 * queues assets for evaluation, runs stub decision logic, emits intention events only.
 */
export class DefaultBotRuntime implements BotRuntime {
  private readonly options: BotRuntimeOptions;
  private readonly scheduler: EventDrivenBotScheduler;
  private readonly assetState = new Map<string, BotAssetRuntimeState>();
  private unsubscribes: (() => void)[] = [];
  private started = false;

  constructor(options: BotRuntimeOptions) {
    this.options = options;
    this.scheduler = new EventDrivenBotScheduler(
      {
        contextProvider: options.contextProvider,
        coalesceMs: options.coalesceMs,
        funderAddress: options.funderAddress,
        strategyId: options.strategyId,
        overloadConfig: options.schedulerOverloadConfig ?? DEFAULT_SCHEDULER_OVERLOAD_CONFIG,
        schedulerDiagnostics: options.schedulerDiagnostics,
      },
      (envelope) => this.handleDecision(envelope)
    );
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.scheduler.start();
    this.subscribeToEvents();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    for (const unsub of this.unsubscribes) unsub();
    this.unsubscribes = [];
    this.scheduler.stop();
  }

  getAssetState(assetId: string): BotAssetRuntimeState | null {
    const s = this.assetState.get(assetId);
    return s ? { ...s } : null;
  }

  getSchedulerBacklog(): number {
    return this.scheduler.getQueueSize();
  }

  getSchedulerInFlight(): number {
    return this.scheduler.getInFlightCount();
  }

  private subscribeToEvents(): void {
    const bus = this.options.eventBus;
    const scheduler = this.scheduler;
    const push = (assetId: string, priority: TriggerPriority = "normal") => scheduler.enqueue(assetId, priority);

    const marketAsset = (ev: RuntimeEvent) => {
      const p = ev.payload as { assetId?: string };
      if (p?.assetId) push(p.assetId, "normal");
    };

    const priorityAsset = (ev: RuntimeEvent) => {
      const p = ev.payload as { assetId?: string };
      if (p?.assetId) push(p.assetId, "high");
    };

    const riskGlobal = () => {
      const store = this.options.marketStateStore;
      if (store) scheduler.enqueueBatch(store.getTrackedAssetIds(), "priority");
    };

    this.unsubscribes = [
      bus.subscribe("market.quote.changed", marketAsset),
      bus.subscribe("market.depth.changed", marketAsset),
      bus.subscribe("market.trade.printed", marketAsset),
      bus.subscribe("market.volatility.changed", marketAsset),
      bus.subscribe("market.liquidity.changed", marketAsset),
      bus.subscribe("market.stale", priorityAsset),
      bus.subscribe("market.recovered", priorityAsset),
      bus.subscribe("position.changed", (ev: RuntimeEvent) => {
        const p = ev.payload as { assetId?: string };
        if (p?.assetId) push(p.assetId, "high");
      }),
      bus.subscribe("order.partial_fill", priorityAsset),
      bus.subscribe("order.filled", priorityAsset),
      bus.subscribe("order.stale", priorityAsset),
      bus.subscribe("regime.changed", marketAsset),
      bus.subscribe("risk.limit_hit", riskGlobal),
      bus.subscribe("risk.kill_switch_changed", riskGlobal),
    ];
  }

  /**
   * Called by the scheduler when an asset is due for evaluation. Builds context, runs stub, updates state, emits intents.
   */
  handleDecision(envelope: BotDecisionEnvelope): void {
    const assetId = envelope.context.assetId;
    if (!assetId) return;
    const now = new Date();
    const snapshot = this.options.contextProvider.createSnapshot();
    const deps = "getDeps" in this.options.contextProvider ? (this.options.contextProvider as { getDeps(): { getOpenOrdersForAsset?: (f: string, a: string) => import("../order-manager/order-manager").RuntimeOrderState[] } }).getDeps() : undefined;
    const getOpenOrders = this.options.getOpenOrdersForAsset ?? deps?.getOpenOrdersForAsset;
    const fullContext = buildBotDecisionContext(snapshot, {
      funderAddress: this.options.funderAddress,
      strategyId: this.options.strategyId,
      assetId,
      asOf: now,
      getOpenOrdersForAsset: getOpenOrders,
    });
    const output = evaluateLiveStrategyPlaceholder(fullContext, this.options.strategyConfig);
    this.upsertAssetState(assetId, { lastEvaluatedAt: now, lastDecisionAt: now, lastSignal: output.action });
    this.emitDecisionTelemetry(fullContext, output, now);
    if (output.action !== "NOOP") this.emitIntentIfNeeded(assetId, output, now);
  }

  /** Emit read-only decision telemetry (every evaluation). */
  private emitDecisionTelemetry(context: BotDecisionContext, output: BotDecisionOutput, now: Date): void {
    this.options.eventBus.publish({
      id: createRuntimeEventId(),
      type: "bot.decision.evaluated",
      source: EVENT_SOURCE,
      occurredAt: now,
      payload: {
        funderAddress: this.options.funderAddress,
        strategyId: this.options.strategyId,
        assetId: output.assetId,
        marketId: output.marketId,
        action: output.action,
        reason: output.reason ?? "unknown",
        asOf: context.asOf ?? now,
        metadata: {
          side: output.side,
          size: output.size,
          limitPrice: output.limitPrice,
          intentId: output.intentId,
        },
      },
    });
  }

  private upsertAssetState(assetId: string, patch: Partial<BotAssetRuntimeState>): void {
    const prev = this.assetState.get(assetId) ?? defaultAssetState(assetId);
    this.assetState.set(assetId, { ...prev, ...patch });
  }

  private emitIntentIfNeeded(assetId: string, output: BotDecisionOutput, now: Date): void {
    if (output.action !== "PLACE_ENTRY" && output.action !== "PLACE_EXIT" && output.action !== "UPDATE_QUOTES") return;
    if (output.side == null || output.size == null || output.limitPrice == null) return;
    this.options.eventBus.publish({
      id: createRuntimeEventId(),
      type: "order.intent.created",
      source: EVENT_SOURCE,
      occurredAt: now,
      payload: {
        funderAddress: this.options.funderAddress,
        strategyId: this.options.strategyId,
        assetId: output.assetId || assetId,
        marketId: output.marketId ?? "",
        side: output.side,
        size: output.size,
        limitPrice: output.limitPrice,
        intentId: output.intentId,
      },
    });
  }

}