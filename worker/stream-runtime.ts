/**
 * Streaming runtime worker: composes EventBus, MarketStateEngine, PositionStore,
 * Risk/KillSwitch, BotRuntime, OrderManager (paper), and wires existing market/user
 * WebSocket flows. Runs periodic maintenance ticks and exposes health. Graceful shutdown.
 */

import type {
  RuntimeHealth,
  RuntimeHealthStatus,
} from "@/lib/runtime/runtime-health";
import {
  createRuntimeHealth,
} from "@/lib/runtime/runtime-health";
import { InMemoryRuntimeEventBus } from "@/lib/runtime/events/runtime-event-bus";
import { InMemoryMarketStateStore } from "@/lib/runtime/market-state/market-state-store";
import { MarketStateEngine } from "@/lib/runtime/market-state/market-state-engine";
import { setMarketStateEngineForDebug } from "@/lib/runtime/market-state/market-state-engine-debug";
import { setBotRuntimeForDebug } from "@/lib/runtime/bot-runtime/bot-runtime-debug";
import { InMemoryRuntimePositionStore } from "@/lib/runtime/positions/runtime-position-store";
import { DefaultRuntimePositionUpdater } from "@/lib/runtime/positions/runtime-position-updater";
import {
  InMemoryRuntimeRiskEngine,
  createDefaultRuntimeRiskState,
} from "@/lib/runtime/risk/runtime-risk-engine";
import { InMemoryKillSwitch } from "@/lib/runtime/risk/kill-switch";
import { DefaultBotRuntimeContextProvider } from "@/lib/runtime/bot-runtime/bot-context";
import { DefaultBotRuntime } from "@/lib/runtime/bot-runtime/bot-runtime";
import { InMemoryOrderLifecycleStore } from "@/lib/runtime/order-manager/order-lifecycle-store";
import { DefaultOrderLifecycleHandler } from "@/lib/runtime/order-manager/order-lifecycle-handler";
import { DefaultOrderIntentReconciler } from "@/lib/runtime/order-manager/order-intent-reconciler";
import { PaperExchangeAdapter } from "@/lib/runtime/order-manager/order-exchange-adapter";
import { PaperOrderManager } from "@/lib/runtime/order-manager/paper-order-manager";
import { DefaultOrderStaleSweeper } from "@/lib/runtime/order-manager/order-stale-sweeper";
import { getRuntimeConfig } from "@/lib/runtime/runtime-config";
import {
  getTradingExecutionPolicy,
  isExecutionAllowed,
  getExecutionBlockedReasons,
} from "@/lib/runtime/trading-execution-policy";
import { getExposureFromStores, updateRiskExposureFromStores } from "@/lib/runtime/runtime-exposure";
import { DefaultRuntimeGuardrails } from "@/lib/runtime/risk/runtime-guardrails";
import { buildBotDecisionContext } from "@/lib/runtime/bot-runtime/bot-context";
import type { OrderIntent } from "@/lib/runtime/order-manager/order-manager";
import type { OrderIntentCreatedPayload } from "@/lib/runtime/events/runtime-events";
import type { BotDecisionOutput } from "@/lib/runtime/bot-runtime/bot-decision-types";
import {
  normalizedFillFromOrderFilled,
  normalizedFillFromOrderPartialFill,
} from "@/lib/runtime/positions/runtime-position-updater";
import type { RuntimeDiagnosticsCollector } from "@/lib/runtime/telemetry/runtime-diagnostics";
import { DefaultRuntimeDiagnosticsCollector } from "@/lib/runtime/telemetry/runtime-diagnostics";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";
import { computeDegraded } from "@/lib/runtime/runtime-degraded";
import { startWebsocketsWithRuntime, stopWebsockets, getStreamRuntimeStatus } from "./websockets";

const MARKET_STATE_TICK_MS = 10_000;
const STALE_SWEEP_MS = 60_000;

export interface StreamRuntimeOptions {
  /** Paper mode only (default true). No live exchange submission. */
  paperMode?: boolean;
  /** Global automation disabled by default when true (kill switch off). */
  globalAutomationDisabledByDefault?: boolean;
  /** Funder address (resolved async if not provided). */
  funderAddress?: string | null;
}

export interface StreamRuntimeDeps {
  eventBus: InMemoryRuntimeEventBus;
  marketStateStore: InMemoryMarketStateStore;
  marketStateEngine: MarketStateEngine;
  positionStore: InMemoryRuntimePositionStore;
  positionUpdater: DefaultRuntimePositionUpdater;
  orderStore: InMemoryOrderLifecycleStore;
  orderLifecycleHandler: DefaultOrderLifecycleHandler;
  orderManager: PaperOrderManager;
  botRuntime: DefaultBotRuntime;
  riskEngine: InMemoryRuntimeRiskEngine;
  killSwitch: InMemoryKillSwitch;
  staleSweeper: DefaultOrderStaleSweeper;
  contextProvider: DefaultBotRuntimeContextProvider;
  guardrails: DefaultRuntimeGuardrails;
  diagnostics: RuntimeDiagnosticsCollector;
}

export class StreamRuntime {
  private readonly options: StreamRuntimeOptions;
  private deps: StreamRuntimeDeps | null = null;
  private startedAt: Date | null = null;
  private status: RuntimeHealthStatus = "stopped";
  private marketTickInterval: ReturnType<typeof setInterval> | null = null;
  private staleSweepInterval: ReturnType<typeof setInterval> | null = null;
  private intentAndFillUnsubscribes: (() => void)[] = [];

  constructor(options: StreamRuntimeOptions = {}) {
    this.options = {
      paperMode: true,
      globalAutomationDisabledByDefault: true,
      ...options,
    };
  }

  /** Initialize and start the runtime; wires WS via websockets module. */
  async start(): Promise<void> {
    if (this.deps) {
      return;
    }
    this.status = "starting";
    const funder = this.options.funderAddress ?? (await getFunderForRecompute()) ?? "";
    const eventBus = new InMemoryRuntimeEventBus();
    const marketStateStore = new InMemoryMarketStateStore();
    const marketStateEngine = new MarketStateEngine({ store: marketStateStore, eventBus });
    setMarketStateEngineForDebug(marketStateEngine);

    const positionStore = new InMemoryRuntimePositionStore();
    const positionUpdater = new DefaultRuntimePositionUpdater({
      store: positionStore,
      eventBus,
      eventSource: "order_manager",
    });

    const riskState = createDefaultRuntimeRiskState({
      grossExposure: 0,
      netExposure: 0,
      globalAutomationEnabled: this.options.globalAutomationDisabledByDefault ? false : true,
    });
    const riskEngine = new InMemoryRuntimeRiskEngine(riskState);
    const killSwitch = new InMemoryKillSwitch({ eventBus });
    if (this.options.globalAutomationDisabledByDefault) {
      killSwitch.setGlobalStop("stream_runtime_default_safe");
    }

    const orderStore = new InMemoryOrderLifecycleStore();
    const orderLifecycleHandler = new DefaultOrderLifecycleHandler({ store: orderStore, eventBus });
    const exchangeAdapter = new PaperExchangeAdapter();
    const intentReconciler = new DefaultOrderIntentReconciler();
    const diagnostics = new DefaultRuntimeDiagnosticsCollector();
    const orderManager = new PaperOrderManager({
      store: orderStore,
      reconciler: intentReconciler,
      adapter: exchangeAdapter,
      eventBus,
      lifecycleHandler: orderLifecycleHandler,
      diagnostics,
    });
    const staleSweeper = new DefaultOrderStaleSweeper({
      store: orderStore,
      eventBus,
      lifecycleHandler: orderLifecycleHandler,
      config: { pendingSubmitAckThresholdMs: 30_000, workingStaleMs: 120_000 },
    });

    const guardrails = new DefaultRuntimeGuardrails({ eventBus });
    const contextProvider = new DefaultBotRuntimeContextProvider(
      { marketStateStore, positionStore, getOpenOrdersForAsset: (f, a) => orderStore.listOpenByAsset(f, a) },
      riskEngine.getState()
    );
    const botRuntime = new DefaultBotRuntime({
      contextProvider,
      eventBus,
      funderAddress: funder,
      strategyId: "default",
      coalesceMs: 50,
      marketStateStore,
      getOpenOrdersForAsset: (f, a) => orderStore.listOpenByAsset(f, a),
    });

    this.deps = {
      eventBus,
      marketStateStore,
      marketStateEngine,
      positionStore,
      positionUpdater,
      orderStore,
      orderLifecycleHandler,
      orderManager,
      botRuntime,
      riskEngine,
      killSwitch,
      staleSweeper,
      contextProvider,
      guardrails,
      diagnostics,
    };
    setBotRuntimeForDebug(botRuntime);

    this.intentAndFillUnsubscribes = this.wireIntentAndFillHandlers(
      eventBus,
      orderStore,
      orderManager,
      positionStore,
      positionUpdater,
      riskEngine,
      contextProvider,
      guardrails,
      diagnostics
    );

    this.marketTickInterval = setInterval(() => {
      try {
        if (this.deps?.marketStateEngine) this.deps.marketStateEngine.tick();
      } catch (err) {
        this.deps?.diagnostics.log("error", "Market state engine tick failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, MARKET_STATE_TICK_MS);

    this.staleSweepInterval = setInterval(() => {
      try {
        if (this.deps?.staleSweeper) this.deps.staleSweeper.sweep();
      } catch (err) {
        this.deps?.diagnostics.log("error", "Stale sweeper interval failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, STALE_SWEEP_MS);

    botRuntime.start();
    await startWebsocketsWithRuntime(
      {
        eventBus: this.deps.eventBus,
        marketStateStore: this.deps.marketStateStore,
        marketStateEngine: this.deps.marketStateEngine,
        positionStore: this.deps.positionStore,
        positionUpdater: this.deps.positionUpdater,
        orderStore: this.deps.orderStore,
        orderLifecycleHandler: this.deps.orderLifecycleHandler,
        botRuntime: this.deps.botRuntime,
      },
      funder || null
    );
    this.startedAt = new Date();
    this.status = "ready";
  }

  /** Graceful shutdown: stop ticks, stop WS, clear refs. */
  async stop(): Promise<void> {
    setBotRuntimeForDebug(null);
    for (const unsub of this.intentAndFillUnsubscribes) {
      unsub();
    }
    this.intentAndFillUnsubscribes = [];
    if (this.marketTickInterval) {
      clearInterval(this.marketTickInterval);
      this.marketTickInterval = null;
    }
    if (this.staleSweepInterval) {
      clearInterval(this.staleSweepInterval);
      this.staleSweepInterval = null;
    }
    if (this.deps?.botRuntime) {
      this.deps.botRuntime.stop();
    }
    stopWebsockets();
    this.deps = null;
    this.startedAt = null;
    this.status = "stopped";
  }

  /** Read-only health snapshot. Uses real stream state, scheduler backlog, and degraded rules. */
  getHealth(): RuntimeHealth {
    const d = this.deps;
    const streamStatus = getStreamRuntimeStatus();
    const asOf = new Date();
    const lifecycleStatus = this.status;
    const operationalReadiness =
      (streamStatus.marketConnection?.status === "open" && streamStatus.userConnection?.status === "open") ?? false;

    if (!d) {
      const executionPolicy = getTradingExecutionPolicy();
      return createRuntimeHealth({
        status: this.status,
        lifecycleStatus,
        startedAt: this.startedAt,
        asOf,
        mode: this.options.paperMode ? "paper" : "live",
        globalAutomationEnabled: !this.options.globalAutomationDisabledByDefault,
        executionPolicy,
        streams: {
          marketWsConnected: streamStatus.marketWsActive,
          userWsConnected: streamStatus.userWsActive,
          marketConnection: streamStatus.marketConnection,
          userConnection: streamStatus.userConnection,
          operationalReadiness,
          trackedAssetCount: 0,
        },
        degradedReasons: [],
      });
    }

    const riskState = d.riskEngine.getState();
    const staleCount = d.marketStateStore.getAssets().filter((a) => a.health?.isStale).length;
    const degradedCount = d.marketStateStore.getAssets().filter((a) => a.health?.isDegraded).length;
    const openOrders = d.orderStore.getAll().filter((o) =>
      ["pending_submit", "working", "partially_filled", "pending_cancel"].includes(o.status)
    );
    const trackedIds = d.marketStateStore.getTrackedAssetIds();
    const exposure = getExposureFromStores(d.positionStore, d.orderStore);
    const runtimeMode = getRuntimeConfig().mode;
    const executionPolicy = getTradingExecutionPolicy();
    const diagnosticsSnapshot = d.diagnostics.getSnapshot();
    const schedulerBacklog = d.botRuntime.getSchedulerBacklog();

    const degradedResult = computeDegraded({
      marketConnection: streamStatus.marketConnection,
      userConnection: streamStatus.userConnection,
      diagnostics: diagnosticsSnapshot,
      schedulerBacklog,
      staleAssetCount: staleCount,
      degradedAssetCount: degradedCount,
      trackedAssetCount: trackedIds.length,
    });
    const effectiveStatus: RuntimeHealthStatus = degradedResult.degraded ? "degraded" : this.status;

    return createRuntimeHealth({
      status: effectiveStatus,
      lifecycleStatus: effectiveStatus,
      startedAt: this.startedAt,
      asOf,
      runtimeMode,
      mode: this.options.paperMode ? "paper" : "live",
      globalAutomationEnabled: riskState.globalAutomationEnabled,
      executionPolicy,
      components: {
        eventBus: true,
        marketStateEngine: true,
        positionStore: true,
        orderManager: true,
        botRuntime: true,
        riskEngine: true,
        killSwitch: true,
      },
      streams: {
        marketWsConnected: streamStatus.marketWsActive,
        userWsConnected: streamStatus.userWsActive,
        marketConnection: streamStatus.marketConnection,
        userConnection: streamStatus.userConnection,
        operationalReadiness,
        trackedAssetCount: trackedIds.length,
      },
      degradedReasons: degradedResult.reasons,
      counts: {
        staleAssetCount: staleCount,
        degradedAssetCount: degradedCount,
        openOrderCount: openOrders.length,
        schedulerBacklog,
        positionCount: d.positionStore.getAll().length,
        grossExposure: exposure.grossExposure,
        netExposure: exposure.netExposure,
      },
      diagnostics: diagnosticsSnapshot,
    });
  }

  /** Expose deps for tests or internal reuse. Null after stop(). */
  getDeps(): StreamRuntimeDeps | null {
    return this.deps;
  }

  /**
   * Subscribe to order.intent.created (→ reconcileIntents with mode/guardrails),
   * order.partial_fill and order.filled (→ position updater with delta tracking).
   * Returns unsubscribe functions for cleanup.
   */
  private wireIntentAndFillHandlers(
    eventBus: InMemoryRuntimeEventBus,
    orderStore: InMemoryOrderLifecycleStore,
    orderManager: PaperOrderManager,
    positionStore: InMemoryRuntimePositionStore,
    positionUpdater: DefaultRuntimePositionUpdater,
    riskEngine: InMemoryRuntimeRiskEngine,
    contextProvider: DefaultBotRuntimeContextProvider,
    guardrails: DefaultRuntimeGuardrails,
    diagnostics: RuntimeDiagnosticsCollector
  ): (() => void)[] {
    const unsubs: (() => void)[] = [];

    const unsubIntent = eventBus.subscribe("order.intent.created", (event) => {
      diagnostics.recordEvent(event);
      const payload = event.payload as OrderIntentCreatedPayload;
      const policy = getTradingExecutionPolicy();
      if (!isExecutionAllowed("runtime_automated")) {
        diagnostics.recordIntentBlockedByMode(policy.effectiveRuntimeMode);
        const reasons = getExecutionBlockedReasons("runtime_automated");
        diagnostics.log("info", "Intent blocked by trading execution policy", {
          reason: "policy_gate",
          mode: policy.effectiveRuntimeMode,
          blockedReasons: reasons,
          assetId: payload.assetId,
        });
        return;
      }
      updateRiskExposureFromStores(riskEngine, positionStore, orderStore);
      diagnostics.recordExposureUpdate();
      contextProvider.updateRiskState(riskEngine.getState());
      const snapshot = contextProvider.createSnapshot();
      const asOf = new Date();
      const context = buildBotDecisionContext(snapshot, {
        funderAddress: payload.funderAddress,
        strategyId: payload.strategyId,
        assetId: payload.assetId,
        asOf,
        getOpenOrdersForAsset: (f, a) => orderStore.listOpenByAsset(f, a),
      });
      const proposedAction: BotDecisionOutput = {
        action: "UPDATE_QUOTES",
        assetId: payload.assetId,
        marketId: payload.marketId,
        side: payload.side,
        size: payload.size,
        limitPrice: payload.limitPrice,
        intentId: payload.intentId,
      };
      const result = guardrails.evaluate(context, riskEngine.getState(), proposedAction);
      if (result.verdict !== "allowed") {
        diagnostics.recordIntentBlockedByGuardrails();
        diagnostics.log("info", "Intent blocked by guardrails", {
          reason: "guardrail_blocked",
          verdict: result.verdict,
          reasonCodes: result.reasonCodes,
          assetId: payload.assetId,
        });
        return;
      }
      const intent: OrderIntent = {
        funderAddress: payload.funderAddress,
        strategyId: payload.strategyId,
        assetId: payload.assetId,
        marketId: payload.marketId,
        side: payload.side,
        size: payload.size,
        limitPrice: payload.limitPrice,
        intentId: payload.intentId,
      };
      Promise.resolve(orderManager.reconcileIntents([intent])).catch((err) => {
        const reason = err instanceof Error ? err.message : String(err);
        diagnostics.recordReconcileFailure(reason, payload.intentId ?? null);
        diagnostics.log("error", "Reconcile intents failed", {
          reason,
          intentId: payload.intentId,
          assetId: payload.assetId,
        });
      });
    });
    unsubs.push(unsubIntent);

    // Position updates are driven only by lifecycle events. Delta = eventFilledSize - order.appliedPositionFilledSize;
    // store.setAppliedPositionFilledSize caps to order.filledSize so appliedPositionFilledSize never exceeds filledSize.
    const unsubPartialFill = eventBus.subscribe("order.partial_fill", (event) => {
      const payload = event.payload as {
        funderAddress: string;
        runtimeOrderId: string;
        assetId: string;
        filledSize: number;
        fillPrice: number;
        filledAt: Date;
      };
      const order = orderStore.get(payload.runtimeOrderId);
      if (!order) return;
      const applied = order.appliedPositionFilledSize ?? 0;
      const delta = payload.filledSize - applied;
      if (delta <= 0) return;
      const fill = normalizedFillFromOrderPartialFill(payload, order, delta);
      positionUpdater.applyFill(fill);
      orderStore.setAppliedPositionFilledSize(payload.runtimeOrderId, payload.filledSize);
      diagnostics.recordPositionUpdate();
      diagnostics.recordPartialFillApplied();
    });
    unsubs.push(unsubPartialFill);

    const unsubFilled = eventBus.subscribe("order.filled", (event) => {
      const payload = event.payload as {
        funderAddress: string;
        runtimeOrderId: string;
        assetId: string;
        marketId: string;
        side: "BUY" | "SELL";
        totalFilledSize: number;
        avgPrice: number;
        filledAt: Date;
        outcome?: string;
      };
      const order = orderStore.get(payload.runtimeOrderId);
      if (!order) return;
      const applied = order.appliedPositionFilledSize ?? 0;
      const delta = payload.totalFilledSize - applied;
      if (delta > 0) {
        const fill = normalizedFillFromOrderFilled({
          ...payload,
          totalFilledSize: delta,
          avgPrice: payload.avgPrice,
        });
        positionUpdater.applyFill(fill);
        orderStore.setAppliedPositionFilledSize(payload.runtimeOrderId, payload.totalFilledSize);
        diagnostics.recordPositionUpdate();
      }
      diagnostics.recordFullFillApplied();
    });
    unsubs.push(unsubFilled);

    return unsubs;
  }
}
