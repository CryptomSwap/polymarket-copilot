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
  buildOperatorHealth,
  computeUserDataHealthy,
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
import { DEFAULT_SCHEDULER_OVERLOAD_CONFIG } from "@/lib/runtime/bot-runtime/bot-scheduler";
import { InMemoryOrderLifecycleStore } from "@/lib/runtime/order-manager/order-lifecycle-store";
import { DefaultOrderLifecycleHandler } from "@/lib/runtime/order-manager/order-lifecycle-handler";
import type { OrderLifecycleHandler } from "@/lib/runtime/order-manager/order-lifecycle-handler";
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
import { RUNTIME_EVENT_BUS_WILDCARD } from "@/lib/runtime/events/runtime-events";
import type { OrderIntentCreatedPayload } from "@/lib/runtime/events/runtime-events";
import type { BotDecisionOutput } from "@/lib/runtime/bot-runtime/bot-decision-types";
import {
  normalizedFillFromOrderFilled,
  normalizedFillFromOrderPartialFill,
} from "@/lib/runtime/positions/runtime-position-updater";
import type { DiagnosticsLogLevel, RuntimeDiagnosticsCollector } from "@/lib/runtime/telemetry/runtime-diagnostics";
import { DefaultRuntimeDiagnosticsCollector } from "@/lib/runtime/telemetry/runtime-diagnostics";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";
import { computeDegraded } from "@/lib/runtime/runtime-degraded";
import { evaluateStreamWatchdog, deriveWatchdogState } from "@/lib/runtime/stream-watchdog";
import { DEFAULT_STREAM_WATCHDOG_CONFIG } from "@/lib/runtime/stream-watchdog-config";
import { getLastSuccessfulUserTruthFetchAt } from "@/lib/live/user-truth-freshness";
import {
  clearRecordedExchangeSnapshots,
  getRecordedExchangeFillsSnapshotAt,
  getRecordedExchangeOrdersSnapshotAt,
  mergeExchangeSnapshotAt,
  recordExchangeFillsSnapshotSuccess,
  recordExchangeOrdersSnapshotSuccess,
} from "@/lib/live/exchange-truth-snapshots";
import { startWebsocketsWithRuntime, stopWebsockets, getStreamRuntimeStatus, getMarketSubscriptionCoverage } from "./websockets";
import {
  getFillByFunderAndExchangeFillId,
  getReplayableUnappliedFills,
  getAppliedFillsForRebuild,
  markFillAppliedSafely,
  createIntentWithEvent,
  persistExecutionPolicyPassed,
  appendIntentBlockedEvent,
  appendOrderIntentEventToLedger,
  createExecutedOrderForIntent,
  appendExecutedOrderEventForOrder,
  getExecutedOrderByVenueOrderId,
  createCancelRequestForOrder,
  markCancelRequestStatus,
  createReplaceRequestForOrder,
  markReplaceRequestStatus,
  markExecutedOrderStatus,
} from "@/lib/execution-ledger/service";
import { buildRuntimeIntentIdempotencyKey } from "@/lib/execution-ledger/idempotency";
import { resolveRuntimeIntentRecommendationLink } from "@/lib/runtime/intent-recommendation-link";
import type { CreateOrderIntentInput } from "@/lib/execution-ledger/types";
import { runRuntimeReconciliation } from "@/lib/runtime/reconciliation/runtime-reconciliation";
import type { RuntimeReconciliationResult } from "@/lib/runtime/reconciliation/runtime-reconciliation-types";
import {
  type GuardrailFreshnessInput,
  type GuardrailVerdict,
  GUARDRAIL_REASON_CODES,
} from "@/lib/runtime/risk/runtime-guardrails";
import { evaluateExecutionPolicy } from "@/lib/execution-policy/evaluate";
import type { ExecutionPolicyInput } from "@/lib/execution-policy/types";
import { evaluateExecutionQualityForRuntimeIntentRecord } from "@/lib/execution-quality";
import {
  evaluateRuntimeSafety,
  updateRuntimeSafetyState,
  getRuntimeSafetyState,
} from "@/lib/runtime-safety";
import { getPortfolioRiskSnapshot } from "@/lib/portfolio-risk";
import type { RuntimeSafetyInput } from "@/lib/runtime-safety/types";
import { getEffectiveOperatingMode } from "@/lib/runtime/operating-mode";
import {
  rebuildOrderStoreFromTruth,
  rebuildPositionStoreFromTruth,
  recomputeRiskExposure,
  parseExchangeOrderForRebuild,
} from "@/lib/runtime/startup/stream-runtime-rebuild";
import { getStoredCredentials } from "@/lib/polymarket/auth";
import { fetchOpenOrdersL2, validateCredentialsWithClobAuthoritative, GET_DATA_ORDERS } from "@/lib/polymarket/l2-readonly";
import {
  buildTruthModelStatus,
  DEFAULT_ORDERS_TRUTH_STALE_MS,
  DEFAULT_FILLS_TRUTH_STALE_MS,
} from "@/lib/runtime/truth/runtime-truth-model";
import { fetchExchangeOpenOrdersSnapshot, fetchExchangeRecentFillsSnapshot } from "@/lib/runtime/truth/exchange-truth-pull";
import { runWithAbortScope, CancelError, CANCEL_ERROR_CODES } from "@/lib/ops/cancellation";
import { retryWithBackoff } from "@/lib/ops/retry";
import { appendOrderLifecycleEvent, ORDER_LIFECYCLE_EVENT_TYPES } from "@/lib/runtime/journal/order-lifecycle-journal";
import { FailureContainmentStateManager } from "@/lib/runtime/execution/execution-failure-containment";
import { recordShadowCandidate } from "@/lib/shadow-telemetry";
import { RuntimeLatencyMonitor } from "@/lib/runtime/telemetry/runtime-latency-monitor";

const MARKET_STATE_TICK_MS = 10_000;
const STALE_SWEEP_MS = 60_000;
const RUNTIME_RECONCILE_INTERVAL_MS = 60_000;
/** Consider reconciliation "stale" if last success is older than this. */
const RECONCILE_FRESHNESS_MS = 120_000;

/**
 * Deterministic reco-thesis root keys for `decisionSnapshotJson` (paper/shadow pipeline).
 * Uses only runtime intent context — no ML. Returns `{}` on any failure so snapshots stay valid.
 */
function recoThesisFieldsForRuntimeDecisionSnapshot(input: {
  strategyId: string;
  side: "BUY" | "SELL";
  limitPrice: unknown;
  action: string;
  context: { assetLiveState?: unknown };
}): Record<string, string> {
  try {
    let quoteMid: number | null = null;
    try {
      const a = input.context?.assetLiveState as { quote?: { mid?: number | null } } | null | undefined;
      const m = a?.quote?.mid;
      if (typeof m === "number" && Number.isFinite(m)) quoteMid = m;
    } catch {
      /* ignore mid extraction */
    }

    const p =
      typeof input.limitPrice === "number" && Number.isFinite(input.limitPrice) ? input.limitPrice : NaN;
    const sid = String(input.strategyId ?? "").toLowerCase();

    let strategyVariant: "momentum" | "mean_reversion" | "event" | "other" = "other";
    if (sid.includes("momentum")) strategyVariant = "momentum";
    else if (sid.includes("revert") || sid.includes("mean_rev") || sid.includes("meanreversion")) {
      strategyVariant = "mean_reversion";
    } else if (sid.includes("event")) strategyVariant = "event";
    else if (!Number.isNaN(p) && quoteMid != null) {
      const payUp =
        (input.side === "BUY" && p >= quoteMid - 1e-9) || (input.side === "SELL" && p <= quoteMid + 1e-9);
      strategyVariant = payUp ? "momentum" : "mean_reversion";
    } else if (!Number.isNaN(p) && (p <= 0.2 || p >= 0.8)) {
      strategyVariant = "event";
    }

    let hypothesisType: "directional" | "probability_mispricing" | "extreme_tail" | "unknown" = "unknown";
    if (Number.isNaN(p)) hypothesisType = "unknown";
    else if (p <= 0.08 || p >= 0.92) hypothesisType = "extreme_tail";
    else if (quoteMid != null && Math.abs(p - quoteMid) >= 0.1) hypothesisType = "probability_mispricing";
    else hypothesisType = "directional";

    return {
      strategyFamily: "reco_thesis",
      strategyVariant,
      hypothesisType,
    };
  } catch {
    return {};
  }
}

export interface StreamRuntimeOptions {
  /** Paper mode only (default true). No live exchange submission. */
  paperMode?: boolean;
  /** Global automation disabled by default when true (kill switch off). */
  globalAutomationDisabledByDefault?: boolean;
  /** Funder address (resolved async if not provided). */
  funderAddress?: string | null;
  /** Optional override for startup fills snapshot (testing only). When provided, used instead of fetchExchangeRecentFillsSnapshot. */
  fetchExchangeRecentFillsSnapshotForStartup?: typeof fetchExchangeRecentFillsSnapshot;
  /** Optional override for websockets startup (testing only). When provided, called instead of startWebsocketsWithRuntime. */
  startWebsocketsForStartup?: (deps: import("./websockets").StreamRuntimeDepsForWs, funderOverride: string | null) => Promise<void>;
  /** Optional: called for each diagnostics.log(); use for worker stdout so phase logs appear in worker-live.log. */
  diagnosticsLogFn?: (level: DiagnosticsLogLevel, message: string, meta?: Record<string, unknown>) => void;
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
  failureContainment: FailureContainmentStateManager;
  latencyMonitor: RuntimeLatencyMonitor;
}

export class StreamRuntime {
  private readonly options: StreamRuntimeOptions;
  private deps: StreamRuntimeDeps | null = null;
  private startedAt: Date | null = null;
  private status: RuntimeHealthStatus = "stopped";
  private marketTickInterval: ReturnType<typeof setInterval> | null = null;
  private staleSweepInterval: ReturnType<typeof setInterval> | null = null;
  private watchdogInterval: ReturnType<typeof setInterval> | null = null;
  private lastWatchdogReasons: string[] = [];
  private lastWatchdogKillSwitchTriggered = false;
  private reconcileInterval: ReturnType<typeof setInterval> | null = null;
  private lastReconciliationResult: RuntimeReconciliationResult | null = null;
  /** Cached funder so reconciliation doesn't get permanently skipped if recompute funder resolution temporarily returns null. */
  private lastResolvedFunderAddress: string | null = null;
  private firstDriftDetectedAt: Date | null = null;
  private lastCredentialPreflightAt: Date | null = null;
  private lastCredentialPreflightStrongOk: boolean | null = null;
  private lastCredentialPreflightDetails: { apiKeysOk: boolean; tradesOk: boolean; dataOrdersOk: boolean } | null = null;
  private intentAndFillUnsubscribes: (() => void)[] = [];
  private lastGuardrailVerdict: GuardrailVerdict | null = null;
  /** Exchange truth: last successful authoritative pull timestamps. */
  private lastExchangeOrdersSnapshotAt: Date | null = null;
  private lastExchangeFillsSnapshotAt: Date | null = null;
  /** Set when credentials missing or pull failed (so we report exchange_truth_unavailable). */
  private exchangeTruthUnavailable = false;
  private reconcileTickInFlight = false;
  private lastExchangeTruthFailureAt: Date | null = null;
  private lastExchangeTruthFailureError: string | null = null;
  private lastExchangeTruthFailureDiagnostics: RuntimeReconciliationResult["exchangeOpenOrdersFetchDiagnostics"] = null;
  private lastExchangeFillsFetchDiagnostics: { attempts: number; perAttemptTimeoutMs?: number; lastErrorType?: string } | null =
    null;
  private lastExchangeTruthGraceApplied: boolean = false;
  private lastExchangeTruthGraceReason: string | null = null;
  private lastExchangeTruthReadValue = {
    orders: null as string | null,
    fills: null as string | null,
    unavailable: null as boolean | null,
  };
  private exchangeTruthWriteAudit: Array<{
    attemptedAt: string;
    caller: string;
    success: boolean;
    valuesWritten: {
      ordersSnapshotAt: string | null;
      fillsSnapshotAt: string | null;
      exchangeTruthUnavailable: boolean | null;
    };
    sourcePath: string;
    transactionContext: string | null;
    error?: string | null;
  }> = [];
  private exchangeTruthReadAudit: Array<{
    readAt: string;
    reader: string;
    source: "db" | "in_memory" | "cache" | "merged";
    values: {
      lastExchangeOrdersSnapshotAt: string | null;
      lastExchangeFillsSnapshotAt: string | null;
      exchangeTruthUnavailable: boolean;
    };
    changedSinceLastTick: boolean;
  }> = [];
  private lastUserTruthMarkerReadValue: string | null = null;
  private userTruthMarkerReadAudit: Array<{
    readAt: string;
    reader: string;
    source: "db" | "in_memory" | "cache";
    value: string | null;
    changedSinceLastTick: boolean;
  }> = [];

  constructor(options: StreamRuntimeOptions = {}) {
    this.options = {
      paperMode: true,
      globalAutomationDisabledByDefault: true,
      ...options,
    };
    this.options.diagnosticsLogFn?.("info", "StreamRuntime options (paperMode for guardrail relaxation)", {
      paperMode: this.options.paperMode,
      allowDegradedAndNotTradableForPaperWillBe: this.options.paperMode === true,
    });
  }

  /** Expose kill switch so the worker can apply operator requests (e.g. clear global stop for paper sessions). */
  getKillSwitch(): InMemoryKillSwitch | null {
    return this.deps?.killSwitch ?? null;
  }

  /** True only when runtime is ready; blocks automated order admission during starting/rebuilding/reconciling. */
  isAutomationAllowed(): boolean {
    return this.status === "ready";
  }

  /** Newest successful orders snapshot: in-process reconcile/startup vs scheduled user_sync (global). */
  private effectiveExchangeOrdersSnapshotAt(): Date | null {
    return mergeExchangeSnapshotAt(this.lastExchangeOrdersSnapshotAt, getRecordedExchangeOrdersSnapshotAt());
  }

  /** Newest successful fills snapshot: in-process vs global. */
  private effectiveExchangeFillsSnapshotAt(): Date | null {
    return mergeExchangeSnapshotAt(this.lastExchangeFillsSnapshotAt, getRecordedExchangeFillsSnapshotAt());
  }

  private recordExchangeTruthWriteAudit(entry: {
    caller: string;
    success: boolean;
    valuesWritten: {
      ordersSnapshotAt: string | null;
      fillsSnapshotAt: string | null;
      exchangeTruthUnavailable: boolean | null;
    };
    sourcePath: string;
    transactionContext: string | null;
    error?: string | null;
  }): void {
    this.exchangeTruthWriteAudit.push({
      attemptedAt: new Date().toISOString(),
      ...entry,
    });
    if (this.exchangeTruthWriteAudit.length > 200) this.exchangeTruthWriteAudit.shift();
  }

  private setExchangeOrdersSnapshotAt(
    at: Date,
    caller: string,
    sourcePath: string,
    transactionContext: string | null = null
  ): void {
    this.lastExchangeOrdersSnapshotAt = at;
    recordExchangeOrdersSnapshotSuccess(at);
    this.recordExchangeTruthWriteAudit({
      caller,
      success: true,
      valuesWritten: {
        ordersSnapshotAt: at.toISOString(),
        fillsSnapshotAt: null,
        exchangeTruthUnavailable: this.exchangeTruthUnavailable,
      },
      sourcePath,
      transactionContext,
    });
  }

  private setExchangeFillsSnapshotAt(
    at: Date,
    caller: string,
    sourcePath: string,
    transactionContext: string | null = null
  ): void {
    this.lastExchangeFillsSnapshotAt = at;
    recordExchangeFillsSnapshotSuccess(at);
    this.recordExchangeTruthWriteAudit({
      caller,
      success: true,
      valuesWritten: {
        ordersSnapshotAt: null,
        fillsSnapshotAt: at.toISOString(),
        exchangeTruthUnavailable: this.exchangeTruthUnavailable,
      },
      sourcePath,
      transactionContext,
    });
  }

  private setExchangeTruthUnavailable(
    unavailable: boolean,
    caller: string,
    sourcePath: string,
    transactionContext: string | null = null
  ): void {
    this.exchangeTruthUnavailable = unavailable;
    this.recordExchangeTruthWriteAudit({
      caller,
      success: true,
      valuesWritten: {
        ordersSnapshotAt: this.lastExchangeOrdersSnapshotAt?.toISOString() ?? null,
        fillsSnapshotAt: this.lastExchangeFillsSnapshotAt?.toISOString() ?? null,
        exchangeTruthUnavailable: unavailable,
      },
      sourcePath,
      transactionContext,
    });
  }

  private readEffectiveExchangeTruth(
    reader: string,
    source: "db" | "in_memory" | "cache" | "merged" = "merged"
  ): {
    ordersAt: Date | null;
    fillsAt: Date | null;
    exchangeTruthUnavailable: boolean;
    changedSinceLastTick: boolean;
  } {
    const ordersAt = this.effectiveExchangeOrdersSnapshotAt();
    const fillsAt = this.effectiveExchangeFillsSnapshotAt();
    const values = {
      lastExchangeOrdersSnapshotAt: ordersAt?.toISOString() ?? null,
      lastExchangeFillsSnapshotAt: fillsAt?.toISOString() ?? null,
      exchangeTruthUnavailable: this.exchangeTruthUnavailable,
    };
    const changedSinceLastTick =
      values.lastExchangeOrdersSnapshotAt !== this.lastExchangeTruthReadValue.orders ||
      values.lastExchangeFillsSnapshotAt !== this.lastExchangeTruthReadValue.fills ||
      values.exchangeTruthUnavailable !== this.lastExchangeTruthReadValue.unavailable;
    this.lastExchangeTruthReadValue = {
      orders: values.lastExchangeOrdersSnapshotAt,
      fills: values.lastExchangeFillsSnapshotAt,
      unavailable: values.exchangeTruthUnavailable,
    };
    this.exchangeTruthReadAudit.push({
      readAt: new Date().toISOString(),
      reader,
      source,
      values,
      changedSinceLastTick,
    });
    if (this.exchangeTruthReadAudit.length > 200) this.exchangeTruthReadAudit.shift();
    return { ordersAt, fillsAt, exchangeTruthUnavailable: this.exchangeTruthUnavailable, changedSinceLastTick };
  }

  private readUserTruthMarker(
    reader: string,
    source: "db" | "in_memory" | "cache" = "in_memory"
  ): Date | null {
    const value = getLastSuccessfulUserTruthFetchAt();
    const valueIso = value?.toISOString() ?? null;
    const changedSinceLastTick = valueIso !== this.lastUserTruthMarkerReadValue;
    this.lastUserTruthMarkerReadValue = valueIso;
    this.userTruthMarkerReadAudit.push({
      readAt: new Date().toISOString(),
      reader,
      source,
      value: valueIso,
      changedSinceLastTick,
    });
    if (this.userTruthMarkerReadAudit.length > 120) this.userTruthMarkerReadAudit.shift();
    return value;
  }

  /**
   * Initialize and start the runtime; wires WS via websockets module.
   * Initialization order (do not reference a variable before its declaration):
   * eventBus → marketStateStore → marketStateEngine → positionStore/positionUpdater →
   * riskEngine → killSwitch (then apply kill switch to riskEngine only; contextProvider does not exist yet) →
   * orderStore → orderLifecycleHandler → orderManager → staleSweeper → guardrails →
   * contextProvider (receives riskEngine.getState(), which already reflects kill switch if set) →
   * botRuntime → deps → wireIntentAndFillHandlers → intervals → botRuntime.start() → startWebsocketsWithRuntime.
   */
  async start(): Promise<void> {
    if (this.deps) {
      return;
    }
    this.status = "starting";
    const funder = this.options.funderAddress ?? (await getFunderForRecompute()) ?? "";
    // Initialize cache from startup resolution (if present).
    this.lastResolvedFunderAddress = funder || null;
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
    });
    const riskEngine = new InMemoryRuntimeRiskEngine(riskState);
    const killSwitch = new InMemoryKillSwitch({
      eventBus,
      logTransition: (fromStopped, toStopped, reason) => {
        this.options.diagnosticsLogFn?.("info", "kill_switch transition", {
          globalAutomationEnabledFrom: !fromStopped,
          globalAutomationEnabledTo: !toStopped,
          reason: reason ?? undefined,
          module: reason?.startsWith("stream_watchdog:")
            ? "stream_watchdog"
            : reason === "stream_runtime_default_safe"
              ? "stream_runtime_startup"
              : reason === "exchange_unhealthy"
                ? "kill_switch.evaluate"
                : "operator",
        });
      },
    });
    if (this.options.globalAutomationDisabledByDefault) {
      killSwitch.setGlobalStop("stream_runtime_default_safe");
      // Apply initial kill-switch state into risk engine so globalAutomationEnabled reflects the stop.
      const base = { ...riskEngine.getState(), globalAutomationEnabled: true };
      const next = killSwitch.applyToRiskState(base);
      riskEngine.updateState(next);
      this.options.diagnosticsLogFn?.("info", "globalAutomationEnabled initial value", {
        globalAutomationEnabled: false,
        source: "globalAutomationDisabledByDefault",
        reason: "stream_runtime_default_safe",
      });
    } else {
      this.options.diagnosticsLogFn?.("info", "globalAutomationEnabled initial value", {
        globalAutomationEnabled: true,
        source: "default",
      });
    }

    const orderStore = new InMemoryOrderLifecycleStore();
    const journalAppend = (params: Parameters<typeof appendOrderLifecycleEvent>[0]) =>
      appendOrderLifecycleEvent(params).catch(() => {});
    const orderLifecycleHandler = new DefaultOrderLifecycleHandler({
      store: orderStore,
      eventBus,
      journalAppend,
    });
    // Paper-mode stale sweeper should cancel stale orders so risk working-order counts don't inflate indefinitely.
    // When stale sweeps cancel orders (reason is set), best-effort mark the corresponding executedOrder as canceled
    // to keep persisted execution ledger aligned with in-memory orderStore.
    const ledgerAwareOrderLifecycleHandler: OrderLifecycleHandler = {
      applyAck: (input) => orderLifecycleHandler.applyAck(input),
      applyPartialFill: (input) => orderLifecycleHandler.applyPartialFill(input),
      applyFullFill: (input) => orderLifecycleHandler.applyFullFill(input),
      applyCancelAck: (input) => {
        const before = orderStore.get(input.clientOrderId);
        orderLifecycleHandler.applyCancelAck(input);
        if (input.reason != null && before?.exchangeOrderId) {
          const venueOrderId = before.exchangeOrderId;
          void (async () => {
            try {
              const exec = await getExecutedOrderByVenueOrderId(venueOrderId);
              if (!exec) return;
              await markExecutedOrderStatus(exec.id, "canceled");
            } catch {
              // Best-effort: avoid impacting runtime safety on ledger failures.
            }
          })();
        }
      },
      applyRejection: (input) => orderLifecycleHandler.applyRejection(input),
    };
    const exchangeAdapter = new PaperExchangeAdapter();
    const intentReconciler = new DefaultOrderIntentReconciler();
    const diagnostics = new DefaultRuntimeDiagnosticsCollector();
    if (this.options.diagnosticsLogFn) {
      diagnostics.setLog(this.options.diagnosticsLogFn);
    }
    const failureContainment = new FailureContainmentStateManager();
    const latencyMonitor = new RuntimeLatencyMonitor();
    const orderManager = new PaperOrderManager({
      store: orderStore,
      reconciler: intentReconciler,
      adapter: exchangeAdapter,
      eventBus,
      lifecycleHandler: ledgerAwareOrderLifecycleHandler,
      diagnostics,
      journalAppend,
      failureContainment,
      onOrderPlaced: async (params) => {
        const { orderIntentId, exchangeOrderId, funderAddress, assetId, marketId, side, size, price, replaceContext } = params;
        const created = await createExecutedOrderForIntent(
          {
            funderAddress,
            marketId,
            assetId,
            side,
            orderType: "LIMIT",
            price: String(price),
            size: String(size),
            originalSize: String(size),
            remainingSize: String(size),
            status: "open",
            venue: "paper",
            polymarketOrderId: exchangeOrderId,
            venueOrderId: exchangeOrderId,
          },
          { linkToIntentId: orderIntentId }
        );
        await appendExecutedOrderEventForOrder({
          executedOrderId: created.executedOrderId,
          eventType: "SUBMITTED",
          payloadJson: JSON.stringify({ exchangeOrderId, at: new Date().toISOString() }),
        });
        if (replaceContext) {
          await appendExecutedOrderEventForOrder({
            executedOrderId: replaceContext.oldExecutedOrderId,
            eventType: "REPLACED",
            payloadJson: JSON.stringify({
              newExecutedOrderId: created.executedOrderId,
              replaceRequestId: replaceContext.replaceRequestId,
              at: new Date().toISOString(),
            }),
          });
          await markReplaceRequestStatus(replaceContext.replaceRequestId, "completed");
        }
      },
      onCancelStarted: async (params) => {
        const exec = await getExecutedOrderByVenueOrderId(params.exchangeOrderId);
        if (!exec) return null;
        const cancelRequestId = await createCancelRequestForOrder({
          executedOrderId: exec.id,
          status: "pending",
          reason: "runtime_cancel",
        });
        await appendExecutedOrderEventForOrder({
          executedOrderId: exec.id,
          eventType: "CANCEL_REQUESTED",
          payloadJson: JSON.stringify({ cancelRequestId, at: new Date().toISOString() }),
        });
        return { executedOrderId: exec.id, cancelRequestId };
      },
      onCancelCompleted: async (params) => {
        const { executedOrderId, cancelRequestId, success, ambiguous } = params;
        if (ambiguous) {
          await appendExecutedOrderEventForOrder({
            executedOrderId,
            eventType: "CANCEL_SUBMITTED",
            payloadJson: JSON.stringify({ cancelRequestId, ambiguous: true, at: new Date().toISOString() }),
          });
          await markCancelRequestStatus(cancelRequestId, "ambiguous");
        } else if (success) {
          await appendExecutedOrderEventForOrder({
            executedOrderId,
            eventType: "CANCELED",
            payloadJson: JSON.stringify({ cancelRequestId, at: new Date().toISOString() }),
          });
          await markCancelRequestStatus(cancelRequestId, "completed");
          await markExecutedOrderStatus(executedOrderId, "canceled");
        } else {
          await appendExecutedOrderEventForOrder({
            executedOrderId,
            eventType: "CANCEL_FAILED",
            payloadJson: JSON.stringify({ cancelRequestId, at: new Date().toISOString() }),
          });
          await markCancelRequestStatus(cancelRequestId, "failed");
        }
      },
      onReplaceStarted: async (params) => {
        const exec = await getExecutedOrderByVenueOrderId(params.exchangeOrderId);
        if (!exec) return null;
        const replaceRequestId = await createReplaceRequestForOrder({
          executedOrderId: exec.id,
          status: "pending",
          reason: "runtime_replace",
        });
        await appendExecutedOrderEventForOrder({
          executedOrderId: exec.id,
          eventType: "REPLACE_REQUESTED",
          payloadJson: JSON.stringify({ replaceRequestId, at: new Date().toISOString() }),
        });
        return { executedOrderId: exec.id, replaceRequestId };
      },
      onReplaceCancelCompleted: async (params) => {
        const { executedOrderId, replaceRequestId, cancelSuccess, ambiguous } = params;
        if (!cancelSuccess) {
          await appendExecutedOrderEventForOrder({
            executedOrderId,
            eventType: "REPLACE_FAILED",
            payloadJson: JSON.stringify({ replaceRequestId, reason: ambiguous ? "cancel_ambiguous" : "cancel_failed", at: new Date().toISOString() }),
          });
          await markReplaceRequestStatus(replaceRequestId, "failed");
        } else if (ambiguous) {
          await appendExecutedOrderEventForOrder({
            executedOrderId,
            eventType: "REPLACE_SUBMITTED",
            payloadJson: JSON.stringify({ replaceRequestId, ambiguous: true, at: new Date().toISOString() }),
          });
          await markReplaceRequestStatus(replaceRequestId, "ambiguous");
        }
        // If cancelSuccess && !ambiguous, replace continues to place; REPLACED is appended in onOrderPlaced when replaceContext is set.
      },
    });
    const staleSweeper = new DefaultOrderStaleSweeper({
      store: orderStore,
      eventBus,
      lifecycleHandler: ledgerAwareOrderLifecycleHandler,
      config: { pendingSubmitAckThresholdMs: 30_000, workingStaleMs: 120_000 },
      journalAppend,
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
      schedulerOverloadConfig: DEFAULT_SCHEDULER_OVERLOAD_CONFIG,
      schedulerDiagnostics: {
        recordCoalesced: () => {
          diagnostics.recordSchedulerCoalesced();
          latencyMonitor.recordCoalescedSchedulerEvent();
        },
        recordDropped: () => {
          diagnostics.recordSchedulerDropped();
          latencyMonitor.recordDroppedSchedulerEvent();
        },
        recordEvaluationLatency: (ms) => {
          diagnostics.recordSchedulerEvaluationLatency(ms);
          latencyMonitor.recordBotEvaluationMs(ms);
        },
        recordOverload: () => diagnostics.recordSchedulerOverload(),
        recordHighWaterMark: (mark) => diagnostics.recordSchedulerHighWaterMark(mark),
      },
      marketStateStore,
      getOpenOrdersForAsset: (f, a) => orderStore.listOpenByAsset(f, a),
      strategyConfig: {
          allowDegradedForPaper: this.options.paperMode ?? true,
          allowQuoteOnlyForPaper: this.options.paperMode ?? true,
        },
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
      failureContainment,
      latencyMonitor,
    };
    setBotRuntimeForDebug(botRuntime);

    this.status = "rebuilding";
    const rebuildStart = Date.now();
    let lastPhase = "startup_rebuild_begin";
    diagnostics.log("info", "startup_rebuild_begin", { funderAddress: funder });

    try {
      const credsResult = funder ? await getStoredCredentials() : null;
      const creds = credsResult?.credential ?? null;
      const diag = credsResult?.selectionDiagnostics ?? null;
      diagnostics.log("info", "startup_credentials_loaded", {
        funderAddress: funder,
        credentialsPresent: creds != null,
        credentialId: creds?.credentialId ?? null,
        polyAddressSource: creds?.polyAddressSource ?? null,
        selectionReason: diag?.selectionReason ?? null,
        validationSummary: diag?.validationSummary ?? null,
        credentialCount: diag?.credentialCount ?? null,
        chosenCredentialId: diag?.chosenCredentialId ?? null,
        hadFullyValidAlternatives: diag?.hadFullyValidAlternatives ?? null,
      });

      if (creds) {
        const l2Creds = {
          apiKey: creds.apiKey,
          secret: creds.secret,
          passphrase: creds.passphrase,
          funderAddress: creds.funderAddress,
          polyAddress: creds.polyAddress,
        };
        lastPhase = "startup_auth_preflight";
        const preflight = await validateCredentialsWithClobAuthoritative(l2Creds);
        this.lastCredentialPreflightAt = new Date();
        this.lastCredentialPreflightStrongOk = preflight.strongAuthOk;
        this.lastCredentialPreflightDetails = {
          apiKeysOk: preflight.apiKeysOk,
          tradesOk: preflight.tradesOk,
          dataOrdersOk: preflight.dataOrdersOk,
        };
        if (!preflight.strongAuthOk) {
          diagnostics.log("error", "auth_preflight_failed", {
            funderAddress: funder,
            credentialId: creds.credentialId,
            apiKeysOk: preflight.apiKeysOk,
            tradesOk: preflight.tradesOk,
            dataOrdersOk: preflight.dataOrdersOk,
            apiKeysStatus: preflight.diagnostics.apiKeysStatus,
            tradesStatus: preflight.diagnostics.tradesStatus,
            dataOrdersStatus: preflight.diagnostics.dataOrdersStatus,
          });
          throw new Error(
            `L2 auth preflight failed: credentials rejected on one or more endpoints (apiKeys: ${preflight.diagnostics.apiKeysStatus}, trades: ${preflight.diagnostics.tradesStatus}, dataOrders: ${preflight.diagnostics.dataOrdersStatus}). Re-initialize via Settings → Polymarket.`
          );
        }
        if (!preflight.dataOrdersOk) {
          diagnostics.log("warn", "auth_preflight_orders_warning", {
            funderAddress: funder,
            credentialId: creds.credentialId,
            apiKeysOk: preflight.apiKeysOk,
            tradesOk: preflight.tradesOk,
            dataOrdersOk: preflight.dataOrdersOk,
            dataOrdersStatus: preflight.diagnostics.dataOrdersStatus,
          });
        }
        diagnostics.log("info", "auth_preflight_ok", {
          funderAddress: funder,
          credentialId: creds.credentialId,
        });
      }

      lastPhase = "startup_rebuild_fetch_exchange_orders_begin";
      diagnostics.log("info", "startup_rebuild_fetch_exchange_orders_begin", {
        funderAddress: funder,
        endpoint: GET_DATA_ORDERS,
      });
      const exchangeOrders: Array<{ id: string; market: string; asset_id: string; side: string; original_size: string; size_matched: string; price: string; status: string }> = [];
      if (creds) {
        const l2Creds = {
          apiKey: creds.apiKey,
          secret: creds.secret,
          passphrase: creds.passphrase,
          funderAddress: creds.funderAddress,
          polyAddress: creds.polyAddress,
        };
        const rawOrders = await fetchOpenOrdersL2(l2Creds);
        for (const row of Array.isArray(rawOrders) ? rawOrders : []) {
          const o = parseExchangeOrderForRebuild(row);
          if (o) exchangeOrders.push(o);
        }
        const ordersAt = new Date();
        this.setExchangeOrdersSnapshotAt(
          ordersAt,
          "startup_rebuild_exchange_orders_success",
          "worker/stream-runtime.ts:start",
          "startup_rebuild"
        );
        this.setExchangeTruthUnavailable(
          false,
          "startup_rebuild_exchange_orders_success",
          "worker/stream-runtime.ts:start",
          "startup_rebuild"
        );
        lastPhase = "startup_rebuild_exchange_orders_success";
        diagnostics.log("info", "startup_rebuild_exchange_orders_success", {
          orderCount: exchangeOrders.length,
          funderAddress: funder,
        });
      }
      rebuildOrderStoreFromTruth(orderStore, exchangeOrders, funder, journalAppend);

      lastPhase = "startup_rebuild_fetch_ledger_fills_begin";
      diagnostics.log("info", "startup_rebuild_fetch_ledger_fills_begin", { funderAddress: funder });

      const appliedFills = funder ? await getAppliedFillsForRebuild(funder) : [];

      lastPhase = "startup_rebuild_fetch_ledger_fills_success";
      diagnostics.log("info", "startup_rebuild_fetch_ledger_fills_success", {
        appliedFillCount: appliedFills.length,
        funderAddress: funder,
      });

      lastPhase = "startup_rebuild_position_store_rebuild_begin";
      diagnostics.log("info", "startup_rebuild_position_store_rebuild_begin", { funderAddress: funder });

      rebuildPositionStoreFromTruth(positionStore, positionUpdater, appliedFills);

      lastPhase = "startup_rebuild_position_store_rebuild_success";
      diagnostics.log("info", "startup_rebuild_position_store_rebuild_success", { funderAddress: funder });

      if (funder) {
        lastPhase = "startup_replay_unapplied_fills_begin";
        diagnostics.log("info", "startup_replay_unapplied_fills_begin", { funderAddress: funder });
        await this.replayUnappliedFills(funder);
        lastPhase = "startup_replay_unapplied_fills_success";
        diagnostics.log("info", "startup_replay_unapplied_fills_success", { funderAddress: funder });
      }

      lastPhase = "startup_rebuild_exposure_recompute_begin";
      diagnostics.log("info", "startup_rebuild_exposure_recompute_begin", { funderAddress: funder });

      recomputeRiskExposure(riskEngine, positionStore, orderStore);

      lastPhase = "startup_rebuild_exposure_recompute_success";
      diagnostics.log("info", "startup_rebuild_exposure_recompute_success", { funderAddress: funder });
      diagnostics.log("info", "Required rebuild steps succeeded", { funderAddress: funder });
    } catch (err) {
      this.status = "degraded";
      this.lastWatchdogReasons = ["startup_rebuild_failed"];
      const errorMessage = err instanceof Error ? err.message : String(err);
      const is405 = /405|Method Not Allowed/i.test(errorMessage);
      const isAuthFailure = /401|403|Unauthorized|Invalid api key/i.test(errorMessage);
      diagnostics.log("error", "Startup rebuild failed", {
        phase: lastPhase,
        errorMessage,
        errorStack: err instanceof Error ? err.stack : null,
        endpoint: GET_DATA_ORDERS,
        classification: is405 ? "method_mismatch" : isAuthFailure ? "auth" : "other",
      });
      if (is405) {
        diagnostics.log("warn", "Orders endpoint returned 405 (method not allowed); runtime uses GET /data/orders.", {
          phase: lastPhase,
          apiCall: `GET ${GET_DATA_ORDERS}`,
        });
      } else if (isAuthFailure) {
        diagnostics.log("error", "L2 credential rejected by CLOB (invalid or expired); re-initialize via Settings → Polymarket.", {
          phase: lastPhase,
          apiCall: `GET ${GET_DATA_ORDERS}`,
        });
      }
      throw err;
    }

    const fetchFillsSnapshot = this.options.fetchExchangeRecentFillsSnapshotForStartup ?? fetchExchangeRecentFillsSnapshot;
    try {
      diagnostics.log("info", "startup_rebuild_exchange_fills_snapshot_begin", { funderAddress: funder });
      const fillsSnapshot = await fetchFillsSnapshot();
      if (fillsSnapshot) {
        this.setExchangeFillsSnapshotAt(
          fillsSnapshot.fetchedAt,
          "startup_rebuild_exchange_fills_snapshot_success",
          "worker/stream-runtime.ts:start",
          "startup_rebuild"
        );
        diagnostics.log("info", "startup_rebuild_exchange_fills_snapshot_success", {
          fillCount: fillsSnapshot.fills.length,
          funderAddress: funder,
        });
      } else {
        diagnostics.log("info", "startup_rebuild_exchange_fills_snapshot_null", { funderAddress: funder });
      }
    } catch (fillsErr) {
      diagnostics.log("warn", "Exchange fills snapshot failed during startup; continuing with degraded fills truth", {
        error: fillsErr instanceof Error ? fillsErr.message : String(fillsErr),
        funderAddress: funder,
      });
    }

    latencyMonitor.recordRebuildDurationMs(Date.now() - rebuildStart);

    this.status = "reconciling";
    this.status = "ready";
    this.startedAt = new Date();
    diagnostics.log("info", "Websockets startup begins", { funderAddress: funder });

    this.intentAndFillUnsubscribes = this.wireIntentAndFillHandlers(
      eventBus,
      orderStore,
      orderManager,
      positionStore,
      positionUpdater,
      riskEngine,
      contextProvider,
      guardrails,
      diagnostics,
      journalAppend
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
        if (this.deps?.staleSweeper) {
          // In paper mode, stale orders must be actively canceled; otherwise the in-memory "working" count
          // can stay inflated and repeatedly trip working_orders_breach.
          if (this.options.paperMode ?? true) this.deps.staleSweeper.sweepAndApply();
          else this.deps.staleSweeper.sweep();
        }
      } catch (err) {
        this.deps?.diagnostics.log("error", "Stale sweeper interval failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, STALE_SWEEP_MS);

    const config = DEFAULT_STREAM_WATCHDOG_CONFIG;
    this.watchdogInterval = setInterval(() => {
      try {
        const streamStatus = getStreamRuntimeStatus();
        const market = streamStatus.marketConnection;
        const user = streamStatus.userConnection;
        const trackedIds = this.deps?.marketStateStore.getTrackedAssetIds() ?? [];
        const openOrders = this.deps?.orderStore.getAll().filter((o) =>
          ["pending_submit", "working", "partially_filled", "pending_cancel"].includes(o.status)
        ) ?? [];
        const result = evaluateStreamWatchdog({
          marketConnection: market,
          userConnection: user,
          trackedAssetCount: trackedIds.length,
          openOrderCount: openOrders.length,
          config,
          lastSuccessfulUserTruthFetchAt: this.readUserTruthMarker("watchdog.evaluateStreamWatchdog"),
        });
        this.lastWatchdogReasons = result.reasons;
        if (result.reasons.some((r) => r.includes("silence"))) {
          this.deps?.latencyMonitor?.recordStreamSilencePeriod();
        }
        const paperRuntime = getRuntimeConfig().mode === "paper";
        const skipKillForPaperUserSilence =
          paperRuntime && result.killSwitchReason === "user_data_silence_with_working_orders";
        if (
          result.triggerKillSwitch &&
          result.killSwitchReason &&
          this.deps?.killSwitch &&
          !skipKillForPaperUserSilence
        ) {
          this.deps.killSwitch.setGlobalStop(`stream_watchdog: ${result.killSwitchReason}`);
          this.lastWatchdogKillSwitchTriggered = true;
          this.deps.diagnostics.log("warn", "Stream watchdog triggered kill switch", {
            reason: result.killSwitchReason,
            reasons: result.reasons,
          });
        } else if (skipKillForPaperUserSilence) {
          this.deps.diagnostics.log("warn", "Stream watchdog skipped kill switch (paper mode: user_data_silence_with_working_orders)", {
            reason: result.killSwitchReason,
            reasons: result.reasons,
          });
        }

        const prevSafety = getRuntimeSafetyState();
        const diag = this.deps?.diagnostics.getSnapshot();
        const lastUserTruthAt = this.readUserTruthMarker("watchdog.runtimeSafetyInput");
        const userDataAgeFromTruth =
          lastUserTruthAt != null ? Date.now() - lastUserTruthAt.getTime() : null;
        const userDataAgeFromWs =
          user?.lastDataEventAt != null ? Date.now() - user.lastDataEventAt.getTime() : null;
        const effectiveUserDataAge =
          userDataAgeFromWs != null && userDataAgeFromTruth != null
            ? Math.min(userDataAgeFromWs, userDataAgeFromTruth)
            : userDataAgeFromWs ?? userDataAgeFromTruth ?? null;
        const safetyInput: RuntimeSafetyInput = {
          killSwitchActive: !this.deps?.riskEngine.getState().globalAutomationEnabled,
          reconciliationDrift: this.lastReconciliationResult?.driftDetected ?? false,
          reconciliationThresholdMs: RECONCILE_FRESHNESS_MS,
          reconciliationLastOkAt:
            diag?.lastRuntimeReconciliationStatus === "ok" && diag?.lastRuntimeReconciliationAt
              ? new Date(diag.lastRuntimeReconciliationAt)
              : null,
          marketFeedFreshnessMs:
            market?.lastDataEventAt != null ? Date.now() - market.lastDataEventAt.getTime() : null,
          userFeedFreshnessMs:
            effectiveUserDataAge,
          marketFeedMaxStalenessMs: config.marketDataDegradedThresholdMs,
          userFeedMaxStalenessMs: config.userDataDegradedThresholdMs,
          marketFeedBlockStalenessMs: config.marketDataKillSwitchThresholdMs || 300_000,
          userFeedBlockStalenessMs: config.userDataKillSwitchWithOrdersThresholdMs || 300_000,
          runtimePhase: this.status,
          exchangeTruthAvailable: (() => {
            // Treat "unavailable" as a hard block only when we have no recent successful snapshots.
            // This prevents a transient fetch error from blocking when we still have fresh exchange truth.
            const now = Date.now();
            const truthRead = this.readEffectiveExchangeTruth("watchdog.runtimeSafetyInput");
            const ordersAt = truthRead.ordersAt;
            const fillsAt = truthRead.fillsAt;
            const ordersAge = ordersAt != null ? now - ordersAt.getTime() : Infinity;
            const fillsAge = fillsAt != null ? now - fillsAt.getTime() : Infinity;
            const graceMs = Number(process.env.EXCHANGE_TRUTH_TRANSIENT_GRACE_MS ?? "60000") || 60_000;
            const haveRecent = ordersAge <= graceMs || fillsAge <= graceMs;
            this.lastExchangeTruthGraceApplied = truthRead.exchangeTruthUnavailable && haveRecent;
            this.lastExchangeTruthGraceReason = this.lastExchangeTruthGraceApplied
              ? `within_grace:ordersAgeMs=${ordersAge} fillsAgeMs=${fillsAge} graceMs=${graceMs}`
              : null;
            return !truthRead.exchangeTruthUnavailable || haveRecent;
          })(),
          repeatedRuntimeErrors: diag?.runtimeReconciliationFailures ?? 0,
          repeatedRuntimeErrorsThreshold: 5,
          workerHealth: this.status === "degraded" ? "degraded" : "ok",
        };
        const safetyResult = evaluateRuntimeSafety(safetyInput);
        updateRuntimeSafetyState(safetyResult);
        if (prevSafety.state !== safetyResult.state) {
          this.deps?.diagnostics.log("info", "runtime_safety_state_changed", {
            previousState: prevSafety.state,
            newState: safetyResult.state,
            blockingReasons: safetyResult.blockingReasons,
            warnings: safetyResult.warnings,
          });
        }
      } catch (err) {
        this.deps?.diagnostics.log("error", "Stream watchdog tick failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, config.watchdogIntervalMs);

    this.reconcileInterval = setInterval(() => {
      void (async () => {
        if (this.reconcileTickInFlight) {
          this.deps?.diagnostics.log("warn", "Runtime reconciliation skipped (in_flight)", {});
          return;
        }
        this.reconcileTickInFlight = true;
        const deps = this.deps;
        let funderAddr = funder || this.options.funderAddress || this.lastResolvedFunderAddress || "";
        if (!funderAddr) {
          const resolved = await getFunderForRecompute().catch(() => null);
          if (resolved) {
            this.lastResolvedFunderAddress = resolved;
            funderAddr = resolved;
          }
        }
        deps?.diagnostics.log("info", "Runtime reconciliation tick", {
          hasDeps: !!deps,
          hasFunderAddress: !!funderAddr,
        });
        if (!deps || !funderAddr) {
          deps?.diagnostics.log("warn", "Runtime reconciliation skipped", {
            reason: !deps ? "no_deps" : "no_funder_address",
          });
          this.reconcileTickInFlight = false;
          return;
        }
        try {
          // Hard deadline for the entire tick. Aborts inner fetches (open orders + fills snapshot + auth preflight).
          await runWithAbortScope({
            label: "runtime_reconcile_tick",
            timeoutMs: Number(process.env.RUNTIME_RECONCILE_TICK_TIMEOUT_MS ?? "45000") || 45_000,
            fn: async (signal) => {
          // Refresh credential readiness periodically so liveReadiness can transition after credential init
          // without requiring a full worker restart. Uses authoritative read-only validation.
          const shouldRefreshCreds =
            this.lastCredentialPreflightAt == null ||
            Date.now() - this.lastCredentialPreflightAt.getTime() > 5 * 60 * 1000;
          if (shouldRefreshCreds) {
            try {
              const credsRes = await getStoredCredentials();
              const c = credsRes.credential;
              if (c) {
                const preflightTimeoutMs =
                  Number(process.env.RUNTIME_AUTH_PREFLIGHT_TIMEOUT_MS ?? "15000") || 15_000;
                const retriesBudget = Math.min(
                  2,
                  Number(process.env.EXCHANGE_TRUTH_REQUEST_RETRIES ?? "2") || 2
                );
                const preflight = await retryWithBackoff({
                  label: "runtime_auth_preflight",
                  signal,
                  retries: retriesBudget,
                  retryOnTimeout: true,
                  baseDelayMs: 200,
                  maxDelayMs: 1500,
                  decide: (err, attempt) => {
                    const msg = err instanceof Error ? err.message : String(err);
                    if (/aborted:/i.test(msg) || /AbortError/i.test(msg)) {
                      return { retry: false, reason: "parent_aborted" };
                    }
                    return { retry: true, backoffMs: Math.min(1500, 200 * Math.pow(2, attempt)) };
                  },
                  fn: async () => {
                    return await runWithAbortScope({
                      label: "runtime_auth_preflight_attempt",
                      parentSignal: signal,
                      timeoutMs: preflightTimeoutMs,
                      fn: async (sig) =>
                        await validateCredentialsWithClobAuthoritative(
                          {
                            apiKey: c.apiKey,
                            secret: c.secret,
                            passphrase: c.passphrase,
                            funderAddress: c.funderAddress,
                            polyAddress: c.polyAddress,
                          },
                          { signal: sig }
                        ),
                    });
                  },
                }).then((r) => r.value);
                this.lastCredentialPreflightAt = new Date();
                this.lastCredentialPreflightStrongOk = preflight.strongAuthOk;
                this.lastCredentialPreflightDetails = {
                  apiKeysOk: preflight.apiKeysOk,
                  tradesOk: preflight.tradesOk,
                  dataOrdersOk: preflight.dataOrdersOk,
                };
              }
            } catch {
              // Non-fatal; readiness remains conservative.
            }
          }

          const result = await runRuntimeReconciliation({
            funderAddress: funderAddr,
            orderStore: deps.orderStore,
            applyRepairs: this.options.paperMode === true,
            journalAppend,
            signal,
            exchangeFetchTimeoutMs: Number(process.env.RUNTIME_EXCHANGE_ORDERS_FETCH_TIMEOUT_MS ?? "15000") || 15_000,
            onRepairApplied: async (params) => {
              if (params.repairKind !== "mark_local_canceled") return;
              const exec = await getExecutedOrderByVenueOrderId(params.exchangeOrderId);
              if (!exec) return;
              await appendExecutedOrderEventForOrder({
                executedOrderId: exec.id,
                eventType: "CANCELED",
                payloadJson: JSON.stringify({ source: "reconciliation_repair", at: new Date().toISOString() }),
              });
              await markExecutedOrderStatus(exec.id, "canceled");
            },
          });
          this.lastReconciliationResult = result;
          if (result.success) {
            const oAt = new Date();
            this.setExchangeOrdersSnapshotAt(
              oAt,
              "reconciliation_success_orders_snapshot",
              "worker/stream-runtime.ts:reconcileTick",
              "reconciliation_tick"
            );
            this.setExchangeTruthUnavailable(
              false,
              "reconciliation_success",
              "worker/stream-runtime.ts:reconcileTick",
              "reconciliation_tick"
            );
            this.lastExchangeTruthFailureAt = null;
            this.lastExchangeTruthFailureError = null;
            this.lastExchangeTruthFailureDiagnostics = null;
            deps.diagnostics.recordRuntimeReconciliationRun();
            deps.diagnostics.log("info", "Runtime reconciliation success", {
              recordedRun: true,
              reconcileDurationMs: result.reconcileDurationMs,
              driftDetected: result.driftDetected,
            });
            deps.latencyMonitor.recordReconcileDurationMs(result.reconcileDurationMs);
            if (result.driftDetected) {
              deps.diagnostics.recordDriftDetected();
              if (!this.firstDriftDetectedAt) this.firstDriftDetectedAt = new Date();
            } else {
              this.firstDriftDetectedAt = null;
            }
            if (result.repairedOrders.length > 0) {
              deps.diagnostics.recordRepairAttempted(result.repairedOrders.length);
              deps.diagnostics.recordRepairApplied(result.repairedOrders.length);
            }
            if (result.missingExchangeOrders.length > 0 || result.missingLocalOrders.length > 0) {
              deps.diagnostics.log("warn", "Reconciliation drift detected", {
                missingLocal: result.missingLocalOrders.length,
                missingExchange: result.missingExchangeOrders.length,
                missingFills: result.missingFills.length,
              });
            }
          } else {
            this.setExchangeTruthUnavailable(
              true,
              "reconciliation_result_failure",
              "worker/stream-runtime.ts:reconcileTick",
              "reconciliation_tick"
            );
            this.lastExchangeTruthFailureAt = new Date();
            this.lastExchangeTruthFailureError = result.error ?? "reconciliation_failed";
            this.lastExchangeTruthFailureDiagnostics = result.exchangeOpenOrdersFetchDiagnostics ?? null;
            deps.diagnostics.recordRuntimeReconciliationFailure();
            deps.diagnostics.log("warn", "Runtime reconciliation failed", {
              error: result.error,
              recordedFailure: true,
              lastRuntimeReconciliationStatusAfter: "failure",
            });
          }
          const fillsSnapshot = await fetchExchangeRecentFillsSnapshot({ signal, timeoutMs: Number(process.env.RUNTIME_EXCHANGE_FILLS_FETCH_TIMEOUT_MS ?? "15000") || 15_000 });
          if (fillsSnapshot) {
            this.setExchangeFillsSnapshotAt(
              fillsSnapshot.fetchedAt,
              "reconciliation_fills_snapshot_success",
              "worker/stream-runtime.ts:reconcileTick",
              "reconciliation_tick"
            );
            this.lastExchangeFillsFetchDiagnostics = fillsSnapshot.fetchDiagnostics ?? null;
            if (this.exchangeTruthUnavailable) {
              this.setExchangeTruthUnavailable(
                false,
                "reconciliation_fills_snapshot_success_clear_unavailable",
                "worker/stream-runtime.ts:reconcileTick",
                "reconciliation_tick"
              );
            }
            this.lastExchangeTruthFailureAt = null;
            this.lastExchangeTruthFailureError = null;
            this.lastExchangeTruthFailureDiagnostics = null;
          }
            },
          });
        } catch (err) {
          const isTimeout = err instanceof CancelError && err.code === CANCEL_ERROR_CODES.TIMEOUT;
          this.lastReconciliationResult = {
            success: false,
            error: err instanceof Error ? err.message : String(err),
            asOf: new Date(),
            reconcileDurationMs: 0,
            missingLocalOrders: [],
            missingExchangeOrders: [],
            staleWorkingOrders: [],
            missingFills: [],
            repairedOrders: [],
            repairedPositions: [],
            driftDetected: false,
            repairRecommendations: [],
          };
          this.setExchangeTruthUnavailable(
            true,
            "reconciliation_throw_failure",
            "worker/stream-runtime.ts:reconcileTick",
            "reconciliation_tick"
          );
          this.lastExchangeTruthFailureAt = new Date();
          this.lastExchangeTruthFailureError = err instanceof Error ? err.message : String(err);
          this.lastExchangeTruthFailureDiagnostics = {
            attempts: 1,
            lastErrorType: isTimeout ? "timeout" : "aborted",
          };
          deps.diagnostics.recordRuntimeReconciliationFailure();
          deps.diagnostics.log("error", "Runtime reconciliation threw", {
            error: err instanceof Error ? err.message : String(err),
            recordedFailure: true,
            lastRuntimeReconciliationStatusAfter: "failure",
            classification: isTimeout ? "timeout_abort" : "error",
          });
        } finally {
          this.reconcileTickInFlight = false;
        }
      })();
    }, RUNTIME_RECONCILE_INTERVAL_MS);

    botRuntime.start();
    const wsDeps = {
      eventBus: this.deps.eventBus,
      marketStateStore: this.deps.marketStateStore,
      marketStateEngine: this.deps.marketStateEngine,
      positionStore: this.deps.positionStore,
      positionUpdater: this.deps.positionUpdater,
      orderStore: this.deps.orderStore,
      orderLifecycleHandler: this.deps.orderLifecycleHandler,
      botRuntime: this.deps.botRuntime,
      onMarketUpdatesApplied: (n: number) => this.deps?.diagnostics.recordMarketUpdatesApplied(n),
      latencyMonitor: this.deps.latencyMonitor,
    };
    if (this.options.startWebsocketsForStartup) {
      await this.options.startWebsocketsForStartup(wsDeps, funder || null);
    } else {
      await startWebsocketsWithRuntime(wsDeps, funder || null);
    }
    diagnostics.log("info", "Runtime marked ready", { funderAddress: funder });
  }

  /**
   * Cold-start replay: apply durable unapplied fills to runtime position and mark applied.
   * Safe to run after position store rebuild; each fill applied exactly once via execution-ledger.
   */
  private async replayUnappliedFills(funderAddress: string): Promise<void> {
    if (!this.deps) return;
    const { positionUpdater, diagnostics } = this.deps;
    try {
      const unapplied = await getReplayableUnappliedFills(funderAddress);
      for (const entry of unapplied) {
        try {
          diagnostics.log("info", "replaying_unapplied_fill", {
            ledgerId: entry.id,
            exchangeFillId: entry.exchangeFillId,
            assetId: entry.assetId,
            filledAt: entry.filledAt?.toISOString?.(),
          });
          const filledAt = entry.filledAt instanceof Date ? entry.filledAt : new Date(entry.filledAt as unknown as string | number);
          positionUpdater.applyFill({
            funderAddress: entry.funderAddress,
            assetId: entry.assetId,
            marketId: entry.marketId,
            outcome: entry.outcome ?? "",
            side: entry.side as "BUY" | "SELL",
            size: entry.size,
            price: entry.price,
            filledAt,
          });
          const marked = await markFillAppliedSafely({ id: entry.id });
          if (marked) {
            diagnostics.log("debug", "fill_marked_applied", { ledgerId: entry.id });
          } else {
            diagnostics.log("warn", "replay_fill_mark_failed", { ledgerId: entry.id });
          }
          diagnostics.recordPositionUpdate();
        } catch (err) {
          diagnostics.log("error", "replay_failed", {
            ledgerId: entry.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (unapplied.length > 0) {
        diagnostics.log("info", "startup_replay_unapplied_fills_done", { count: unapplied.length, funderAddress });
      }
    } catch (err) {
      diagnostics.log("error", "Fill ledger replay failed", {
        error: err instanceof Error ? err.message : String(err),
        funderAddress,
      });
    }
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
    if (this.watchdogInterval) {
      clearInterval(this.watchdogInterval);
      this.watchdogInterval = null;
    }
    if (this.reconcileInterval) {
      clearInterval(this.reconcileInterval);
      this.reconcileInterval = null;
    }
    this.lastReconciliationResult = null;
    this.lastExchangeOrdersSnapshotAt = null;
    this.lastExchangeFillsSnapshotAt = null;
    clearRecordedExchangeSnapshots();
    this.setExchangeTruthUnavailable(
      false,
      "runtime_stop_reset",
      "worker/stream-runtime.ts:stop",
      "stop"
    );
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
    const config = DEFAULT_STREAM_WATCHDOG_CONFIG;
    const now = asOf.getTime();
    const market = streamStatus.marketConnection;
    const user = streamStatus.userConnection;
    const socketOpen = (market?.status === "open" && user?.status === "open") ?? false;
    const heartbeatMaxAge = 35_000;
    const heartbeatHealthy: boolean =
      !!(
        (market?.status !== "open" || (market?.lastHeartbeatAt && now - market.lastHeartbeatAt.getTime() <= heartbeatMaxAge)) &&
        (user?.status !== "open" || (user?.lastHeartbeatAt && now - user.lastHeartbeatAt.getTime() <= heartbeatMaxAge))
      );
    const marketDataHealthy =
      market?.status === "open" &&
      market?.lastDataEventAt != null &&
      now - market.lastDataEventAt.getTime() <= config.marketDataDegradedThresholdMs;
    const openOrders = d?.orderStore
      ? d.orderStore.getAll().filter((o) =>
          ["pending_submit", "working", "partially_filled", "pending_cancel"].includes(o.status)
        )
      : [];
    const userDataHealthy = computeUserDataHealthy(
      user,
      now,
      config.userDataDegradedThresholdMs,
      openOrders.length,
      this.readUserTruthMarker("getHealth.computeUserDataHealthy")
    );
    const dataFlowHealthy = marketDataHealthy && userDataHealthy;
    const operationalReadiness: boolean = this.status === "ready" && socketOpen && dataFlowHealthy;

    if (!d) {
      const executionPolicy = getTradingExecutionPolicy();
      const runtimeModeNoDeps = getRuntimeConfig().mode;
      const effectiveModeNoDeps = getEffectiveOperatingMode({
        runtimeMode: runtimeModeNoDeps,
        runtimePhase: this.status,
        guardrailVerdict: this.lastGuardrailVerdict ?? undefined,
      });
      const truthReadNoDeps = this.readEffectiveExchangeTruth("getHealth.truthModelStatus.noDeps");
      const truthModelStatus = buildTruthModelStatus({
        lastExchangeOrdersSnapshotAt: truthReadNoDeps.ordersAt,
        lastExchangeFillsSnapshotAt: truthReadNoDeps.fillsAt,
        exchangeTruthUnavailable: truthReadNoDeps.exchangeTruthUnavailable,
      });
      const operatorHealth = buildOperatorHealth({
        marketConnection: streamStatus.marketConnection,
        userConnection: streamStatus.userConnection,
        marketDataHealthy: marketDataHealthy,
        userDataHealthy: userDataHealthy,
        operationalReadiness,
        runtimePhase: this.status,
        globalAutomationEnabled: !this.options.globalAutomationDisabledByDefault,
        watchdogReasons: this.lastWatchdogReasons,
        reconciliationLastAt: null,
        reconciliationStatus: null,
        reconciliationDriftDetected: false,
        reconciliationDurationMs: 0,
        executionPolicy,
        truthModelStatus,
      });
      return createRuntimeHealth({
        status: this.status,
        lifecycleStatus,
        startedAt: this.startedAt,
        asOf,
        mode: this.options.paperMode ? "paper" : "live",
        globalAutomationEnabled: !this.options.globalAutomationDisabledByDefault,
        executionPolicy,
        operatorHealth,
        truthModelStatus,
        streams: {
          marketWsConnected: streamStatus.marketWsActive,
          userWsConnected: streamStatus.userWsActive,
          marketConnection: streamStatus.marketConnection,
          userConnection: streamStatus.userConnection,
          socketOpen,
          heartbeatHealthy,
          dataFlowHealthy,
          operationalReadiness,
          trackedAssetCount: 0,
          marketLastDataEventAt: market?.lastDataEventAt?.toISOString() ?? null,
          userLastDataEventAt: user?.lastDataEventAt?.toISOString() ?? null,
          marketLastHeartbeatAt: market?.lastHeartbeatAt?.toISOString() ?? null,
          userLastHeartbeatAt: user?.lastHeartbeatAt?.toISOString() ?? null,
        },
        degradedReasons: [],
        watchdogReasons: this.lastWatchdogReasons,
        watchdogState: deriveWatchdogState(
          this.lastWatchdogKillSwitchTriggered,
          this.lastWatchdogKillSwitchTriggered,
          this.lastWatchdogReasons.length
        ),
        operatingMode: effectiveModeNoDeps.operatingMode,
        operatingModeSource: effectiveModeNoDeps.source,
      });
    }

    let riskState = d.riskEngine.getState();
    const ksState = d.killSwitch.getState();
    const killSwitchReasonActual: string | null = ksState.globalReason;
    const defaultSafeReason = "stream_runtime_default_safe";
    const reasonIsExactDefaultSafe =
      typeof killSwitchReasonActual === "string" && killSwitchReasonActual === defaultSafeReason;

    const statusReady = this.status === "ready";
    const marketSocketOpen = (market?.status === "open") ?? false;
    const userSocketOpen = (user?.status === "open") ?? false;
    const marketSubscriptionCoverageForClear = getMarketSubscriptionCoverage();
    const marketSubscriptionCoverageInSync = marketSubscriptionCoverageForClear?.inSync === true;

    const underlyingReadiness: boolean =
      statusReady && socketOpen && dataFlowHealthy;
    const streamReadinessForDefaultSafeClear: boolean =
      statusReady && marketSocketOpen && userSocketOpen && marketSubscriptionCoverageInSync;

    const autoClearReadiness = streamReadinessForDefaultSafeClear;

    if (
      this.options.paperMode &&
      !riskState.globalAutomationEnabled &&
      ksState.globalEnabled &&
      reasonIsExactDefaultSafe &&
      autoClearReadiness
    ) {
      d.killSwitch.clearGlobalStop();
      this.syncKillSwitchIntoRiskEngine();
      riskState = d.riskEngine.getState();
      d.diagnostics.log("info", "globalAutomationEnabled auto-cleared (paper mode, stream ready, default_safe)", {
        reason: "paper_stream_ready_default_safe",
        killSwitchReasonActual,
        streamReadinessForDefaultSafeClear: true,
        autoClearConditionMatched: true,
        clearGlobalStopCalled: true,
        globalAutomationEnabledAfter: riskState.globalAutomationEnabled,
      });
    } else if (
      this.options.paperMode &&
      !riskState.globalAutomationEnabled &&
      ksState.globalEnabled &&
      reasonIsExactDefaultSafe
    ) {
      d.diagnostics.log("info", "paper default_safe auto-clear check (did not clear)", {
        killSwitchReasonActual,
        reasonIsExactDefaultSafe: true,
        underlyingReadiness,
        streamReadinessForDefaultSafeClear,
        autoClearConditionMatched: false,
        clearGlobalStopCalled: false,
        underlyingReadinessComponents: {
          statusReady,
          runtimeStatus: this.status,
          socketOpen,
          marketSocketOpen,
          userSocketOpen,
          dataFlowHealthy,
          marketDataHealthy,
          userDataHealthy,
          marketSubscriptionCoverageInSync,
        },
      });
    }

    const staleCount = d.marketStateStore.getAssets().filter((a) => a.health?.isStale).length;
    const degradedCount = d.marketStateStore.getAssets().filter((a) => a.health?.isDegraded).length;
    const trackedIds = d.marketStateStore.getTrackedAssetIds();
    const exposure = getExposureFromStores(d.positionStore, d.orderStore);
    const runtimeMode = getRuntimeConfig().mode;
    const executionPolicy = getTradingExecutionPolicy();
    const diagnosticsSnapshot = d.diagnostics.getSnapshot();
    const schedulerBacklog = d.botRuntime.getSchedulerBacklog();
    const marketSubscriptionCoverage = getMarketSubscriptionCoverage();

    const containmentState = d.failureContainment.getState();
    const latencyDegradedReasons = d.latencyMonitor.getDegradedReasons();
    const truthReadHealth = this.readEffectiveExchangeTruth("getHealth.computeDegraded.truth");
    const ordersSnapAt = truthReadHealth.ordersAt;
    const fillsSnapAt = truthReadHealth.fillsAt;
    const degradedResult = computeDegraded({
      marketConnection: market,
      userConnection: user,
      marketDataStaleThresholdMs: config.marketDataDegradedThresholdMs,
      userDataStaleThresholdMs: config.userDataDegradedThresholdMs,
      openOrderCount: openOrders.length,
      reconnectChurnAttemptsThreshold: config.reconnectChurnAttemptsThreshold,
      runtimeReconciliationFailureThreshold: 3,
      diagnostics: diagnosticsSnapshot,
      executionAmbiguityShouldDegrade: d.failureContainment.shouldDegradeRuntime(),
      executionFrozenAssetCount: containmentState.frozenAssetIds.size,
      latencyDegradedReasons: latencyDegradedReasons.length > 0 ? latencyDegradedReasons : undefined,
      schedulerBacklog,
      staleAssetCount: staleCount,
      degradedAssetCount: degradedCount,
      trackedAssetCount: trackedIds.length,
      marketSubscriptionCoverage: marketSubscriptionCoverage ?? undefined,
      lastExchangeOrdersSnapshotAt: ordersSnapAt,
      lastExchangeFillsSnapshotAt: fillsSnapAt,
      exchangeOrdersStaleThresholdMs: DEFAULT_ORDERS_TRUTH_STALE_MS,
      exchangeFillsStaleThresholdMs: DEFAULT_FILLS_TRUTH_STALE_MS,
      exchangeTruthUnavailable: truthReadHealth.exchangeTruthUnavailable,
      lastSuccessfulUserTruthFetchAt: this.readUserTruthMarker("getHealth.computeDegraded"),
    });
    const allReasons = [...new Set([...degradedResult.reasons, ...this.lastWatchdogReasons])];
    const effectiveStatus: RuntimeHealthStatus = allReasons.length > 0 ? "degraded" : this.status;
    const killSwitchActive = !riskState.globalAutomationEnabled;
    const watchdogState = deriveWatchdogState(
      this.lastWatchdogKillSwitchTriggered,
      killSwitchActive,
      this.lastWatchdogReasons.length
    );

    const lastRec = this.lastReconciliationResult;
    const lastRecAt = diagnosticsSnapshot.lastRuntimeReconciliationAt;
    const lastRecStatus = diagnosticsSnapshot.lastRuntimeReconciliationStatus;
    let reconciliationFreshness: "ok" | "stale" | "never_run" = "never_run";
    if (lastRecAt && lastRecStatus === "ok") {
      const age = asOf.getTime() - new Date(lastRecAt).getTime();
      reconciliationFreshness = age <= RECONCILE_FRESHNESS_MS ? "ok" : "stale";
    } else if (lastRecStatus === "failure") {
      reconciliationFreshness = "stale";
    }
    const reconciliation = {
      lastAt: lastRecAt,
      status: lastRecStatus,
      freshness: reconciliationFreshness,
      driftDetected: lastRec?.driftDetected ?? false,
      reconcileDurationMs: lastRec?.reconcileDurationMs ?? 0,
    };

    const exchangeCredentialValidationReady = !!(
      this.lastCredentialPreflightStrongOk === true &&
      this.lastCredentialPreflightAt != null &&
      Date.now() - this.lastCredentialPreflightAt.getTime() <= 10 * 60 * 1000
    );

    const effectiveMode = getEffectiveOperatingMode({
      runtimeMode,
      runtimePhase: effectiveStatus,
      guardrailVerdict: this.lastGuardrailVerdict ?? undefined,
    });
    const truthModelStatus = buildTruthModelStatus({
      lastExchangeOrdersSnapshotAt: ordersSnapAt,
      lastExchangeFillsSnapshotAt: fillsSnapAt,
      exchangeTruthUnavailable: truthReadHealth.exchangeTruthUnavailable,
      ordersStaleThresholdMs: DEFAULT_ORDERS_TRUTH_STALE_MS,
      fillsStaleThresholdMs: DEFAULT_FILLS_TRUTH_STALE_MS,
    });
    const operatorHealth = buildOperatorHealth({
      marketConnection: market,
      userConnection: user,
      marketDataHealthy: marketDataHealthy,
      userDataHealthy: userDataHealthy,
      operationalReadiness,
      runtimePhase: effectiveStatus,
      globalAutomationEnabled: riskState.globalAutomationEnabled,
      watchdogReasons: this.lastWatchdogReasons,
      reconciliationLastAt: lastRecAt,
      reconciliationStatus: lastRecStatus,
      reconciliationDriftDetected: lastRec?.driftDetected ?? false,
      reconciliationDurationMs: lastRec?.reconcileDurationMs ?? 0,
      executionPolicy: executionPolicy ?? null,
      truthModelStatus,
      executionContainment: {
        frozenAssetIds: Array.from(containmentState.frozenAssetIds),
        submitAmbiguousCount: containmentState.submitAmbiguousCount,
        cancelAmbiguousCount: containmentState.cancelAmbiguousCount,
        replaceAmbiguousCount: containmentState.replaceAmbiguousCount,
        executionVerificationRequiredCount: containmentState.executionVerificationRequiredCount,
        lastAmbiguityAt: containmentState.lastAmbiguityAt?.toISOString() ?? null,
        shouldDegradeRuntime: d.failureContainment.shouldDegradeRuntime(),
        shouldForceCancelOnlyOrFrozen: d.failureContainment.shouldForceCancelOnlyOrFrozen(),
      },
    });

    return createRuntimeHealth({
      status: effectiveStatus,
      lifecycleStatus: effectiveStatus,
      startedAt: this.startedAt,
      asOf,
      runtimeMode,
      mode: this.options.paperMode ? "paper" : "live",
      globalAutomationEnabled: riskState.globalAutomationEnabled,
      executionPolicy,
      truthModelStatus,
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
        marketConnection: market,
        userConnection: user,
        socketOpen,
        heartbeatHealthy,
        dataFlowHealthy,
        operationalReadiness,
        trackedAssetCount: trackedIds.length,
        marketLastDataEventAt: market?.lastDataEventAt?.toISOString() ?? null,
        userLastDataEventAt: user?.lastDataEventAt?.toISOString() ?? null,
        marketLastHeartbeatAt: market?.lastHeartbeatAt?.toISOString() ?? null,
        userLastHeartbeatAt: user?.lastHeartbeatAt?.toISOString() ?? null,
      },
      degradedReasons: allReasons,
      watchdogReasons: this.lastWatchdogReasons,
      watchdogState,
      reconciliation,
      operatorHealth,
      marketSubscriptionCoverage: marketSubscriptionCoverage ?? null,
      operatingMode: effectiveMode.operatingMode,
      operatingModeSource: effectiveMode.source,
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
      latencyAndIntegrity: d.latencyMonitor.getSnapshot(),
      metadata: {
        exchangeCredentialValidationReady,
        exchangeCredentialLastValidatedAt: this.lastCredentialPreflightAt?.toISOString() ?? null,
        exchangeCredentialPreflight: this.lastCredentialPreflightDetails,
        exchangeTruthUnavailable: truthReadHealth.exchangeTruthUnavailable,
        exchangeTruthTransientGraceApplied: this.lastExchangeTruthGraceApplied,
        exchangeTruthTransientGraceReason: this.lastExchangeTruthGraceReason,
        lastExchangeOrdersSnapshotAt: ordersSnapAt?.toISOString() ?? null,
        lastExchangeFillsSnapshotAt: fillsSnapAt?.toISOString() ?? null,
        lastExchangeTruthFailureAt: this.lastExchangeTruthFailureAt?.toISOString() ?? null,
        lastExchangeTruthFailureError: this.lastExchangeTruthFailureError,
        lastExchangeTruthFailureDiagnostics: this.lastExchangeTruthFailureDiagnostics,
        lastExchangeFillsFetchDiagnostics: this.lastExchangeFillsFetchDiagnostics,
        exchangeTruthReadSource: "merged",
        exchangeTruthChangedSinceLastTick:
          this.exchangeTruthReadAudit[this.exchangeTruthReadAudit.length - 1]?.changedSinceLastTick ?? null,
        exchangeTruthReadAuditRecent: this.exchangeTruthReadAudit.slice(-12),
        exchangeTruthWriteAuditRecent: this.exchangeTruthWriteAudit.slice(-20),
        lastSuccessfulUserTruthFetchAt:
          this.readUserTruthMarker("getHealth.metadata.lastSuccessfulUserTruthFetchAt")?.toISOString() ?? null,
        userTruthMarkerReadSource: "in_memory",
        userTruthMarkerChangedSinceLastTick:
          this.userTruthMarkerReadAudit[this.userTruthMarkerReadAudit.length - 1]?.changedSinceLastTick ?? null,
        userTruthMarkerReadAuditRecent: this.userTruthMarkerReadAudit.slice(-12),
        reconciliationAlignmentReady:
          reconciliationFreshness === "ok" && (lastRec?.driftDetected ?? false) === false,
        reconciliationDriftFirstDetectedAt: this.firstDriftDetectedAt?.toISOString() ?? null,
        reconciliationDetail: lastRec
          ? {
              missingLocalOrdersCount: lastRec.missingLocalOrders.length,
              missingLocalOrdersSample: lastRec.missingLocalOrders.slice(0, 10),
              missingExchangeOrdersCount: lastRec.missingExchangeOrders.length,
              missingExchangeOrdersSample: lastRec.missingExchangeOrders
                .slice(0, 10)
                .map((o) => ({
                  clientOrderId: o.clientOrderId,
                  exchangeOrderId: o.exchangeOrderId,
                  assetId: o.assetId,
                  marketId: o.marketId,
                  side: o.side,
                  status: o.status,
                  price: o.price,
                  size: o.size,
                  filledSize: o.filledSize,
                  remainingSize: o.remainingSize,
                })),
              missingFillsCount: lastRec.missingFills.length,
              missingFillsSample: lastRec.missingFills.slice(0, 10),
              repairedOrdersCount: lastRec.repairedOrders.length,
              repairedOrdersSample: lastRec.repairedOrders.slice(0, 10),
            }
          : null,
      },
    });
  }

  /** Expose deps for tests or internal reuse. Null after stop(). */
  getDeps(): StreamRuntimeDeps | null {
    return this.deps;
  }

  /**
   * Re-apply kill switch state into the risk engine so globalAutomationEnabled
   * reflects the latest global stop/clear. Safe to call repeatedly.
   */
  syncKillSwitchIntoRiskEngine(): void {
    if (!this.deps) return;
    const { riskEngine, killSwitch, contextProvider } = this.deps;
    const current = riskEngine.getState();
    const base = { ...current, globalAutomationEnabled: true };
    const next = killSwitch.applyToRiskState(base);
    riskEngine.updateState(next);
    contextProvider.updateRiskState(next);
    this.deps.diagnostics.log("info", "syncKillSwitchIntoRiskEngine applied", {
      globalAutomationEnabledBefore: current.globalAutomationEnabled,
      globalAutomationEnabledAfter: next.globalAutomationEnabled,
      killSwitchStopped: killSwitch.isGlobalStopped(),
    });
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
    diagnostics: RuntimeDiagnosticsCollector,
    journalAppend: (params: Parameters<typeof appendOrderLifecycleEvent>[0]) => void | Promise<void>
  ): (() => void)[] {
    const unsubs: (() => void)[] = [];
    let intentHandlerPaperModeLogged = false;
    let guardrailDiagnosticLogCount = 0;
    // Serialize intent handling so the working-order cap check/trip is consistent.
    // Without this, concurrent `order.intent.created` handlers can temporarily allow too many
    // working orders before the in-memory riskState updates, inflating `openOrderCount`
    // and repeatedly tripping `working_orders_breach`.
    let intentQueue: Promise<void> = Promise.resolve();

    // Record all bus events to diagnostics so materialEventsEmitted, botEvaluations, orderIntentsGenerated reflect reality.
    unsubs.push(
      eventBus.subscribe(RUNTIME_EVENT_BUS_WILDCARD, (event) => {
        diagnostics.recordEvent(event);
      })
    );

    const unsubIntent = eventBus.subscribe("order.intent.created", (event) => {
      intentQueue = intentQueue.then(async () => {
      const payload = event.payload as OrderIntentCreatedPayload;
      journalAppend({
        funderAddress: payload.funderAddress,
        intentId: payload.intentId ?? null,
        assetId: payload.assetId,
        marketId: payload.marketId,
        side: payload.side,
        eventType: ORDER_LIFECYCLE_EVENT_TYPES.INTENT_CREATED,
        payloadJson: JSON.stringify({
          strategyId: payload.strategyId,
          size: payload.size,
          limitPrice: payload.limitPrice,
        }),
        occurredAt: event.occurredAt instanceof Date ? event.occurredAt : new Date(),
      });
      if (!this.isAutomationAllowed()) {
        diagnostics.recordIntentBlockedByMode("rebuilding");
        return;
      }
      const policy = getTradingExecutionPolicy();
      if (!isExecutionAllowed("runtime_automated")) {
        diagnostics.recordIntentBlockedByMode(policy.effectiveRuntimeMode);
        const reasons = getExecutionBlockedReasons("runtime_automated");
        diagnostics.log("debug", "Intent blocked by trading execution policy", {
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
      const streamStatus = getStreamRuntimeStatus();
      const config = DEFAULT_STREAM_WATCHDOG_CONFIG;
      const now = Date.now();
      const market = streamStatus.marketConnection;
      const user = streamStatus.userConnection;
      const marketDataAgeMs =
        market?.lastDataEventAt != null ? now - market.lastDataEventAt.getTime() : null;
      const lastSuccessfulUserTruthFetchAt = this.readUserTruthMarker("intent.guardrailFreshness");
      const userDataAgeFromWsMs =
        user?.lastDataEventAt != null ? now - user.lastDataEventAt.getTime() : null;
      const userDataAgeFromTruthMs =
        lastSuccessfulUserTruthFetchAt != null ? now - lastSuccessfulUserTruthFetchAt.getTime() : null;
      const userDataAgeMs =
        userDataAgeFromWsMs != null && userDataAgeFromTruthMs != null
          ? Math.min(userDataAgeFromWsMs, userDataAgeFromTruthMs)
          : userDataAgeFromWsMs ?? userDataAgeFromTruthMs ?? null;
      const marketDataFresh =
        market?.status !== "open" ||
        (market?.lastDataEventAt != null &&
          now - market.lastDataEventAt.getTime() <= config.marketDataDegradedThresholdMs);
      const lastRecAt = diagnostics.getSnapshot().lastRuntimeReconciliationAt;
      const lastRecOk = diagnostics.getSnapshot().lastRuntimeReconciliationStatus === "ok";
      const reconciliationAgeMs = lastRecAt != null ? now - new Date(lastRecAt).getTime() : null;
      const reconciliationFresh =
        !!lastRecAt && lastRecOk && now - new Date(lastRecAt).getTime() <= RECONCILE_FRESHNESS_MS;
      const openOrders = orderStore.getAll().filter((o) =>
        ["pending_submit", "working", "partially_filled", "pending_cancel"].includes(o.status)
      );
      // Keep intent guardrail user freshness source aligned with operator health/watchdog:
      // WS user data + recent successful REST user truth (fail-closed when neither is fresh with open orders).
      const userDataFresh = computeUserDataHealthy(
        user,
        now,
        config.userDataDegradedThresholdMs,
        openOrders.length,
        lastSuccessfulUserTruthFetchAt
      );
      const truthReadIntent = this.readEffectiveExchangeTruth("intent.guardrailFreshness.truth");
      const truthStatus = buildTruthModelStatus({
        lastExchangeOrdersSnapshotAt: truthReadIntent.ordersAt,
        lastExchangeFillsSnapshotAt: truthReadIntent.fillsAt,
        exchangeTruthUnavailable: truthReadIntent.exchangeTruthUnavailable,
        ordersStaleThresholdMs: DEFAULT_ORDERS_TRUTH_STALE_MS,
        fillsStaleThresholdMs: DEFAULT_FILLS_TRUTH_STALE_MS,
      });
      const containment = this.deps?.failureContainment;

      const paperMode = this.options.paperMode === true;
      if (!intentHandlerPaperModeLogged) {
        intentHandlerPaperModeLogged = true;
        diagnostics.log("info", "Intent handler paperMode (first intent)", {
          paperModeFromOptions: this.options.paperMode,
          paperMode,
          allowDegradedAndNotTradableForPaper: paperMode,
        });
      }
      const marketDataFreshForGuardrails =
        paperMode
          ? (market?.status === "open") ?? false
          : marketDataFresh;
      const userDataFreshForGuardrails = userDataFresh;
      const reconciliationFreshForGuardrails =
        paperMode
          ? (!!lastRecAt && lastRecOk) || openOrders.length === 0
          : reconciliationFresh;

      const riskState = riskEngine.getState();
      const runtimeSafetyNow = getRuntimeSafetyState();
      const portfolioRiskNow = getPortfolioRiskSnapshot(payload.funderAddress);
      const concentrationCurrentSingleMarketPct = portfolioRiskNow?.maxSingleMarketConcentrationPct ?? null;
      const concentrationCurrentSingleThemePct = portfolioRiskNow?.maxSingleThemeConcentrationPct ?? null;
      const concentrationLimitSingleMarketPct = riskState.limits.perMarketNotionalLimitPct * 100;
      const concentrationLimitSingleThemePct = riskState.limits.perThemeNotionalLimitPct * 100;
      const automationPermittedDecision = this.status === "ready" && riskState.globalAutomationEnabled;
      const safeToAutomateDecision =
        automationPermittedDecision &&
        marketDataFreshForGuardrails &&
        userDataFreshForGuardrails &&
        reconciliationFreshForGuardrails;

      const buildDecisionContextSnapshot = (params: {
        wasBlocked: boolean;
        wasSubmitted: boolean;
        conciseBlockingReasons: string[];
        terminalStage: string;
        terminalModule: string;
        terminalFunction: string;
      }): string => {
        const recoThesis = recoThesisFieldsForRuntimeDecisionSnapshot({
          strategyId: payload.strategyId,
          side: payload.side,
          limitPrice: payload.limitPrice,
          action: proposedAction.action,
          context,
        });
        return JSON.stringify({
          decidedAt: new Date().toISOString(),
          candidateId: null,
          marketId: payload.marketId ?? null,
          assetId: payload.assetId,
          wasBlocked: params.wasBlocked,
          wasSubmitted: params.wasSubmitted,
          conciseBlockingReasons: params.conciseBlockingReasons,
          terminalAttribution: {
            stage: params.terminalStage,
            module: params.terminalModule,
            function: params.terminalFunction,
          },
          runtime: {
            runtimeStatus: this.status,
            lifecycleStatus: this.status,
            operatingMode: getEffectiveOperatingMode({
              runtimeMode: getRuntimeConfig().mode,
              runtimePhase: this.status,
              guardrailVerdict: this.lastGuardrailVerdict ?? undefined,
            }).operatingMode,
            globalAutomationEnabled: riskState.globalAutomationEnabled,
            automationPermitted: automationPermittedDecision,
            safeToAutomate: safeToAutomateDecision,
            runtimeSafetyState: runtimeSafetyNow.state,
            degradedReasons: this.getHealth().degradedReasons,
          },
          userFreshnessInputs: {
            userLastDataEventAt: user?.lastDataEventAt?.toISOString() ?? null,
            lastSuccessfulUserTruthFetchAt: lastSuccessfulUserTruthFetchAt?.toISOString() ?? null,
            effectiveUserFreshnessResult: userDataFreshForGuardrails,
          },
          exchangeFreshnessInputs: {
            lastExchangeOrdersSnapshotAt: truthReadIntent.ordersAt?.toISOString() ?? null,
            lastExchangeFillsSnapshotAt: truthReadIntent.fillsAt?.toISOString() ?? null,
            exchangeTruthUnavailable: truthReadIntent.exchangeTruthUnavailable,
            effectiveExchangeTruthHealthResult: truthStatus.exchangeTruthHealthy,
          },
          workingOrderInputs: {
            workingOrderCount: openOrders.length,
            maxConcurrentWorkingOrders: riskState.limits.maxConcurrentWorkingOrders,
          },
          concentrationInputs: {
            maxSingleMarketConcentrationPct: concentrationCurrentSingleMarketPct,
            maxSingleThemeConcentrationPct: concentrationCurrentSingleThemePct,
            effectiveSingleMarketLimit: concentrationLimitSingleMarketPct,
            effectiveSingleThemeLimit: concentrationLimitSingleThemePct,
          },
          ...recoThesis,
        });
      };

      const freshness: GuardrailFreshnessInput = {
        runtimePhase: this.status,
        marketDataFresh: marketDataFreshForGuardrails,
        userDataFresh: userDataFreshForGuardrails,
        reconciliationFresh: reconciliationFreshForGuardrails,
        watchdogKillSwitch: !riskState.globalAutomationEnabled && this.lastWatchdogReasons.length > 0,
        openOrderCount: openOrders.length,
        exchangeTruthHealthy: truthStatus.exchangeTruthHealthy,
        exchangeTruthUnavailable: truthReadIntent.exchangeTruthUnavailable,
        blockOnStaleExchangeTruthWithWorkingOrders: true,
        executionFrozenAssetIds: containment?.getFrozenAssetIds(),
        executionContainmentForceCancelOnlyOrFrozen: containment?.shouldForceCancelOnlyOrFrozen() ?? false,
      };
      const guardrailStart = Date.now();
      const result = guardrails.evaluate(context, riskState, proposedAction, {
        freshness,
        allowDegradedAndNotTradableForPaper: paperMode,
        guardrailDiagnosticLog:
          guardrailDiagnosticLogCount < 5
            ? (data) => {
                guardrailDiagnosticLogCount++;
                this.options.diagnosticsLogFn?.("info", "guardrail market-health option (from guardrails)", {
                  ...data,
                  callCount: guardrailDiagnosticLogCount,
                });
              }
            : undefined,
      });
      this.deps?.latencyMonitor?.recordGuardrailEvaluationMs(Date.now() - guardrailStart);
      this.lastGuardrailVerdict = result.verdict;
      const allowReduceOnly =
        result.verdict === "requires_reduction" &&
        (proposedAction.action === "CANCEL_ORDERS" ||
          proposedAction.action === "REDUCE_RISK" ||
          proposedAction.action === "PLACE_EXIT");
      const allowed =
        result.verdict === "allowed" ||
        (result.verdict === "cancel_only" && proposedAction.action === "CANCEL_ORDERS") ||
        allowReduceOnly;

      const funder = payload.funderAddress.toLowerCase().trim();
      const outcome = payload.side === "BUY" ? "YES" : "NO";
      const payloadRecId =
        (payload as { recommendationId?: string | null }).recommendationId?.trim() || null;
      let runtimeIntentLink: Awaited<ReturnType<typeof resolveRuntimeIntentRecommendationLink>> = null;
      if (!payloadRecId && payload.marketId) {
        runtimeIntentLink = await resolveRuntimeIntentRecommendationLink({
          funderAddress: funder,
          marketId: payload.marketId,
          outcome,
        });
      }
      const resolvedRecommendationId = payloadRecId ?? runtimeIntentLink?.recommendationId ?? null;
      const runtimeIntentMetadataJson =
        runtimeIntentLink && !payloadRecId
          ? JSON.stringify({
              linkage: {
                source: "resolveRuntimeIntentRecommendationLink",
                theme: runtimeIntentLink.theme || undefined,
                category: runtimeIntentLink.category || undefined,
                marketTitle: runtimeIntentLink.marketTitle || undefined,
              },
            })
          : undefined;

      if (!allowed) {
        diagnostics.recordIntentBlockedByGuardrails();
        const freshnessCodes = result.reasonCodes.filter(
          (c) =>
            c === GUARDRAIL_REASON_CODES.MARKET_DATA_STALE ||
            c === GUARDRAIL_REASON_CODES.USER_DATA_STALE ||
            c === GUARDRAIL_REASON_CODES.RECONCILIATION_STALE ||
            c === GUARDRAIL_REASON_CODES.RUNTIME_REBUILDING ||
            c === GUARDRAIL_REASON_CODES.RUNTIME_RECONCILING ||
            c === GUARDRAIL_REASON_CODES.WATCHDOG_KILL_SWITCH ||
            c === GUARDRAIL_REASON_CODES.EXCHANGE_TRUTH_UNVERIFIED ||
            c === GUARDRAIL_REASON_CODES.EXCHANGE_TRUTH_STALE ||
            c === GUARDRAIL_REASON_CODES.EXCHANGE_TRUTH_UNAVAILABLE ||
            c === GUARDRAIL_REASON_CODES.ASSET_EXECUTION_FROZEN ||
            c === GUARDRAIL_REASON_CODES.EXECUTION_VERIFICATION_REQUIRED
        );
        if (freshnessCodes.length > 0) {
          diagnostics.recordIntentBlockedByFreshness(freshnessCodes);
        }
        const blockingReasons = result.reasonCodes?.length ? result.reasonCodes : [result.verdict];
        const freshnessBlockers: string[] = [];
        if (!marketDataFresh) freshnessBlockers.push("marketDataFresh");
        if (!userDataFresh) freshnessBlockers.push("userDataFresh");
        if (!reconciliationFresh) freshnessBlockers.push("reconciliationFresh");
        const asset = context?.assetLiveState as {
          health?: { isDegraded?: boolean; isStale?: boolean; lastMarketEventAt?: Date };
          liquidity?: { isTradable?: boolean; qualityScore?: number | null };
          quote?: { bestBid?: number | null; bestAsk?: number | null; mid?: number | null; spreadBps?: number | null };
          depth?: { bidTopSize?: number | null; askTopSize?: number | null };
        } | null | undefined;
        const healthLastMarketEventAt = asset?.health?.lastMarketEventAt;
        const eqRecordGuardrails = evaluateExecutionQualityForRuntimeIntentRecord({
          assetId: payload.assetId,
          marketId: payload.marketId,
          side: payload.side,
          intendedPrice: payload.limitPrice,
          intendedSize: payload.size,
          assetLiveState: context.assetLiveState,
        });
        diagnostics.log("debug", "ShadowCandidate blocked (diagnostics)", {
          guardrailVerdict: result.verdict,
          blockingReasonCodes: blockingReasons,
          marketHealthAndLiquidity: asset
            ? {
                assetId: payload.assetId,
                healthIsDegraded: asset.health?.isDegraded,
                healthIsStale: asset.health?.isStale,
                healthLastMarketEventAt:
                  healthLastMarketEventAt != null
                    ? healthLastMarketEventAt instanceof Date
                      ? healthLastMarketEventAt.toISOString()
                      : String(healthLastMarketEventAt)
                    : undefined,
                liquidityIsTradable: asset.liquidity?.isTradable,
                liquidityQualityScore: asset.liquidity?.qualityScore ?? undefined,
                quoteBestBid: asset.quote?.bestBid ?? undefined,
                quoteBestAsk: asset.quote?.bestAsk ?? undefined,
                quoteMid: asset.quote?.mid ?? undefined,
                quoteSpreadBps: asset.quote?.spreadBps ?? undefined,
                depthBidTopSize: asset.depth?.bidTopSize ?? undefined,
                depthAskTopSize: asset.depth?.askTopSize ?? undefined,
              }
            : undefined,
          hadFreshnessCodes: freshnessCodes.length > 0,
          freshnessReasonCodes: freshnessCodes.length > 0 ? freshnessCodes : undefined,
          freshnessInputSummary: {
            marketDataFresh,
            userDataFresh,
            reconciliationFresh,
            lastRuntimeReconciliationAt: lastRecAt ?? undefined,
            lastRuntimeReconciliationOk: lastRecOk,
          },
          freshnessAgesMs: {
            marketDataAgeMs,
            userDataAgeMs,
            reconciliationAgeMs,
            marketDataDegradedThresholdMs: config.marketDataDegradedThresholdMs,
            userDataDegradedThresholdMs: config.userDataDegradedThresholdMs,
            reconcileFreshnessMs: RECONCILE_FRESHNESS_MS,
          },
          dominantFreshnessBlocker: freshnessBlockers.length > 0 ? freshnessBlockers : undefined,
          paperModeRelaxationApplied: paperMode,
          allowDegradedAndNotTradableForPaper: paperMode,
          executionPolicyAllowed: true,
          assetId: payload.assetId,
        });
        void recordShadowCandidate({
          funderAddress: payload.funderAddress,
          recommendationId: resolvedRecommendationId,
          orderIntentId: payload.intentId ?? null,
          assetId: payload.assetId,
          marketId: payload.marketId,
          side: payload.side,
          intendedPrice: payload.limitPrice,
          intendedSize: payload.size,
          candidateSource: "runtime_automated",
          decisionSnapshotJson: buildDecisionContextSnapshot({
            wasBlocked: true,
            wasSubmitted: false,
            conciseBlockingReasons: blockingReasons,
            terminalStage: "runtime_guardrails",
            terminalModule: "lib/runtime/risk/runtime-guardrails.ts",
            terminalFunction: "DefaultRuntimeGuardrails.evaluate",
          }),
          executionQualitySnapshotJson: eqRecordGuardrails.snapshotJson,
          runtimeSafetySnapshotJson: JSON.stringify({
            state: runtimeSafetyNow.state,
            blockingReasons: runtimeSafetyNow.blockingReasons,
            warnings: runtimeSafetyNow.warnings,
            evaluatedAt: runtimeSafetyNow.evaluatedAt,
          }),
          wasBlocked: true,
          blockingReasons,
          wasSubmitted: false,
        }).catch(() => {});
        diagnostics.log("debug", "Intent blocked by guardrails", {
          reason: "guardrail_blocked",
          verdict: result.verdict,
          reasonCodes: result.reasonCodes,
          blockingReasonCodes: blockingReasons,
          paperMode,
          allowDegradedAndNotTradableForPaper: paperMode,
          assetId: payload.assetId,
        });
        return;
      }

      const idempotencyKey = buildRuntimeIntentIdempotencyKey({
        funderAddress: funder,
        source: "runtime_automated",
        recommendationId: payloadRecId,
        assetId: payload.assetId,
        side: payload.side,
        orderType: "LIMIT",
        limitPrice: payload.limitPrice,
        requestedSize: payload.size,
        slotSeconds: 60,
      });
      const intentInput: CreateOrderIntentInput = {
        funderAddress: funder,
        recommendationId: resolvedRecommendationId,
        source: "runtime_automated",
        marketId: payload.marketId,
        assetId: payload.assetId,
        outcome,
        side: payload.side,
        orderType: "LIMIT",
        limitPrice: String(payload.limitPrice),
        requestedSize: String(payload.size),
        status: "created",
        idempotencyKey,
        metadataJson: runtimeIntentMetadataJson,
      };
      let ledgerIntent: { id: string };
      try {
        const created = await createIntentWithEvent(intentInput, { eventType: "CREATED", payloadJson: null });
        ledgerIntent = created.intent;
      } catch (err) {
        diagnostics.log("error", "Durable intent creation failed", {
          reason: err instanceof Error ? err.message : String(err),
          assetId: payload.assetId,
        });
        return;
      }

      const assetLiveState = context.assetLiveState as {
        health?: { isStale?: boolean; isDegraded?: boolean };
        liquidity?: { qualityScore?: number; isTradable?: boolean };
        quote?: { bestBid?: number | null; bestAsk?: number | null; spreadBps?: number | null; updatedAt?: Date | null };
        depth?: { bidTopSize?: number | null; askTopSize?: number | null };
      } | null | undefined;
      const eqRecord = evaluateExecutionQualityForRuntimeIntentRecord({
        assetId: payload.assetId,
        marketId: payload.marketId,
        side: payload.side,
        intendedPrice: payload.limitPrice,
        intendedSize: payload.size,
        assetLiveState,
      });
      const portfolioRisk = portfolioRiskNow;
      const exposureInput: ExecutionPolicyInput["exposure"] = {
        grossExposure: riskState.grossExposure,
        maxTotalExposure: riskState.limits.maxTotalExposure,
        workingOrderCount: riskState.workingOrderCount,
        maxWorkingOrders: riskState.limits.maxConcurrentWorkingOrders,
        perAssetNotional: (context.position as { exposureNotional?: number } | undefined)?.exposureNotional,
        maxNotionalPerAsset: riskState.limits.maxNotionalPerAsset,
      };
      if (portfolioRisk) {
        exposureInput.totalOpenExposure = portfolioRisk.totalOpenExposure;
        exposureInput.currentSingleMarketConcentrationPct = portfolioRisk.maxSingleMarketConcentrationPct;
        exposureInput.maxSingleMarketConcentrationPct = riskState.limits.perMarketNotionalLimitPct * 100;
        exposureInput.currentSingleThemeConcentrationPct = portfolioRisk.maxSingleThemeConcentrationPct;
        exposureInput.maxSingleThemeConcentrationPct = riskState.limits.perThemeNotionalLimitPct * 100;
        exposureInput.nearResolutionExposure = portfolioRisk.nearResolutionExposure;
      }
      const policyFreshness = paperMode
        ? {
            marketDataFresh: marketDataFreshForGuardrails,
            userDataFresh: userDataFreshForGuardrails,
            reconciliationFresh: reconciliationFreshForGuardrails,
            runtimePhase: this.status,
          }
        : {
            marketDataFresh,
            userDataFresh,
            reconciliationFresh,
            runtimePhase: this.status,
          };
      const policyLiquidity =
        assetLiveState != null
          ? paperMode
            ? {
                marketStale: false,
                marketDegraded: false,
                isTradable: true,
                liquidityQualityScore: assetLiveState.liquidity?.qualityScore,
                minLiquidityQualityScore: riskState.limits.minLiquidityQualityScore,
                spreadBps: assetLiveState.quote?.spreadBps,
                minSpreadBps: riskState.limits.minQuoteSpreadBps,
              }
            : {
                marketStale: assetLiveState.health?.isStale,
                marketDegraded: assetLiveState.health?.isDegraded,
                isTradable: assetLiveState.liquidity?.isTradable,
                liquidityQualityScore: assetLiveState.liquidity?.qualityScore,
                minLiquidityQualityScore: riskState.limits.minLiquidityQualityScore,
                spreadBps: assetLiveState.quote?.spreadBps,
                minSpreadBps: riskState.limits.minQuoteSpreadBps,
              }
          : undefined;
      const policyExecutionQuality =
        assetLiveState != null
          ? paperMode && eqRecord.qualityState === "block"
            ? { qualityState: "good" as const, blockingReasons: [] as string[], warnings: eqRecord.warnings ?? [] }
            : {
                qualityState: eqRecord.qualityState,
                blockingReasons: eqRecord.blockingReasons,
                warnings: eqRecord.warnings,
              }
          : undefined;
      let operationalReconciliationDriftRaw = !reconciliationFresh;
      let operationalReconciliationDriftForPolicy = paperMode ? !reconciliationFreshForGuardrails : operationalReconciliationDriftRaw;
      const policyInput: ExecutionPolicyInput = {
        order: {
          funderAddress: payload.funderAddress,
          assetId: payload.assetId,
          marketId: payload.marketId,
          side: payload.side,
          size: payload.size,
          limitPrice: payload.limitPrice,
        },
        freshness: policyFreshness,
        exposure: exposureInput,
        liquidity: policyLiquidity,
        operational: {
          killSwitchActive: !riskState.globalAutomationEnabled,
          runtimeSafetyState: getRuntimeSafetyState().state,
          runtimeDegraded: this.status === "degraded",
          reconciliationDrift: operationalReconciliationDriftForPolicy,
          exchangeTruthUnavailable: this.exchangeTruthUnavailable,
          executionFrozenAssetIds: containment?.getFrozenAssetIds(),
          assetId: payload.assetId,
        },
        priceBand: { min: 0, max: 1 },
        executionQuality: policyExecutionQuality,
      };
      const policyResult = evaluateExecutionPolicy(policyInput);
      const policyReasonTokens = policyResult.blockingReasons
        .flatMap((r) =>
          String(r)
            .split(";")
            .map((p) => p.trim())
            .filter(Boolean)
        )
        .map((t) => t.toLowerCase());
      const concentrationTokens = policyReasonTokens.filter(
        (t) =>
          t.includes("single_market_concentration_breach") || t.includes("single_theme_concentration_breach")
      );
      const hasConcentrationReasons = concentrationTokens.length > 0;
      const operationalHardBlock = policyReasonTokens.some(
        (t) =>
          t.startsWith("operational:") ||
          t.includes("kill_switch") ||
          t.includes("runtime_safety_blocked") ||
          t.includes("runtime_safety_kill_switch") ||
          t.includes("missing_credentials") ||
          t.includes("exchange_truth_unavailable") ||
          t.includes("missing_market_or_asset_resolution")
      );
      const nonConcentrationReasons = policyReasonTokens.filter(
        (t) =>
          !(
            t.includes("single_market_concentration_breach") || t.includes("single_theme_concentration_breach")
          )
      );
      const softenConcentrationInPaper =
        paperMode &&
        process.env.PAPER_EXECUTION_POLICY_SOFTEN_CONCENTRATION === "1" &&
        hasConcentrationReasons &&
        nonConcentrationReasons.length === 0 &&
        !operationalHardBlock;
      const policyDecisionMeta = {
        concentrationSoftened: softenConcentrationInPaper,
        softenedReasons: softenConcentrationInPaper ? concentrationTokens : [],
        originalWouldBlock: !policyResult.allow,
        operationalHardBlock,
      };
      const effectivePolicyAllow = policyResult.allow || softenConcentrationInPaper;
      const effectivePolicyState = effectivePolicyAllow
        ? softenConcentrationInPaper
          ? "warn"
          : policyResult.policyState
        : policyResult.policyState;
      const effectivePolicyWarnings = softenConcentrationInPaper
        ? [...policyResult.warnings, "paper_softened_concentration"]
        : policyResult.warnings;
      const effectivePolicySnapshotJson = (() => {
        try {
          const parsed = JSON.parse(policyResult.snapshotJson) as Record<string, unknown>;
          parsed.policyState = effectivePolicyState;
          parsed.allow = effectivePolicyAllow;
          parsed.warnings = effectivePolicyWarnings;
          parsed.decisionMeta = policyDecisionMeta;
          return JSON.stringify(parsed);
        } catch {
          return policyResult.snapshotJson;
        }
      })();
      const concentrationInputSnapshotJson = portfolioRisk
        ? JSON.stringify({
            computedAt: portfolioRisk.computedAt,
            totalOpenExposure: portfolioRisk.totalOpenExposure,
            maxSingleMarketConcentrationPct: portfolioRisk.maxSingleMarketConcentrationPct,
            maxSingleThemeConcentrationPct: portfolioRisk.maxSingleThemeConcentrationPct,
            nearResolutionExposure: portfolioRisk.nearResolutionExposure,
            appliedLimits: {
              maxSingleMarketConcentrationPct: exposureInput.maxSingleMarketConcentrationPct ?? null,
              maxSingleThemeConcentrationPct: exposureInput.maxSingleThemeConcentrationPct ?? null,
            },
          })
        : null;
      if (!effectivePolicyAllow) {
        diagnostics.log("debug", "ShadowCandidate blocked by execution policy (diagnostics)", {
          source: "execution_policy",
          runtimeGuardrailsAllowed: true,
          policyBlockingReasons: policyResult.blockingReasons,
          policyState: policyResult.policyState,
          ...policyDecisionMeta,
          paperMode,
          paperModeRelaxationAppliedToPolicyInput: paperMode,
          operationalReconciliationDriftRaw,
          operationalReconciliationDriftForPolicy,
          operationalReconciliationDriftRelaxedForPaper: paperMode && operationalReconciliationDriftRaw !== operationalReconciliationDriftForPolicy,
          assetId: payload.assetId,
          intentId: ledgerIntent.id,
        });
        void recordShadowCandidate({
          funderAddress: payload.funderAddress,
          recommendationId: resolvedRecommendationId,
          orderIntentId: ledgerIntent.id,
          assetId: payload.assetId,
          marketId: payload.marketId,
          side: payload.side,
          intendedPrice: payload.limitPrice,
          intendedSize: payload.size,
          candidateSource: "runtime_automated",
          decisionSnapshotJson: buildDecisionContextSnapshot({
            wasBlocked: true,
            wasSubmitted: false,
            conciseBlockingReasons: policyResult.blockingReasons,
            terminalStage: "execution_policy",
            terminalModule: "lib/execution-policy/evaluate.ts",
            terminalFunction: "evaluateExecutionPolicy",
          }),
          executionPolicySnapshotJson: effectivePolicySnapshotJson,
          executionQualitySnapshotJson: eqRecord.snapshotJson,
          portfolioRiskSnapshotJson: concentrationInputSnapshotJson,
          runtimeSafetySnapshotJson: JSON.stringify({
            state: runtimeSafetyNow.state,
            blockingReasons: runtimeSafetyNow.blockingReasons,
            warnings: runtimeSafetyNow.warnings,
            evaluatedAt: runtimeSafetyNow.evaluatedAt,
          }),
          wasBlocked: true,
          blockingReasons: policyResult.blockingReasons,
          wasSubmitted: false,
        }).catch(() => {});
        void appendIntentBlockedEvent(
          ledgerIntent.id,
          "EXECUTION_POLICY_BLOCKED",
          JSON.stringify({ blockingReasons: policyResult.blockingReasons, ...policyDecisionMeta }),
          "blocked"
        ).catch(() => {});
        diagnostics.log("debug", "Intent blocked by execution policy", {
          reason: "execution_policy_blocked",
          blockingReasons: policyResult.blockingReasons,
          assetId: payload.assetId,
          intentId: ledgerIntent.id,
        });
        return;
      }
      if (effectivePolicyWarnings.length > 0) {
        diagnostics.log("debug", "Execution policy warnings", {
          warnings: effectivePolicyWarnings,
          ...policyDecisionMeta,
          assetId: payload.assetId,
        });
      }
      try {
        await persistExecutionPolicyPassed(ledgerIntent.id, effectivePolicySnapshotJson);
        await appendOrderIntentEventToLedger({
          orderIntentId: ledgerIntent.id,
          eventType: "READY_FOR_RECONCILIATION",
          payloadJson: JSON.stringify(policyDecisionMeta),
        });
      } catch (err) {
        diagnostics.log("error", "Persist policy passed failed", {
          reason: err instanceof Error ? err.message : String(err),
          assetId: payload.assetId,
        });
        return;
      }
      if (journalAppend) {
        void Promise.resolve(
          journalAppend({
            funderAddress: payload.funderAddress,
            assetId: payload.assetId,
            marketId: payload.marketId,
            side: payload.side,
            intentId: ledgerIntent.id,
            eventType: ORDER_LIFECYCLE_EVENT_TYPES.EXECUTION_POLICY_PASSED,
            payloadJson: policyResult.snapshotJson,
            occurredAt: new Date(),
          })
        ).catch((err) => {
          // Temporary: log stack so "handler promise rejected" can be traced to this call.
          console.error("[order.intent.created] journalAppend(EXECUTION_POLICY_PASSED) failed", err instanceof Error ? err.stack : String(err));
        });
      }
      diagnostics.log("debug", "Execution policy allow", {
        policyState: effectivePolicyState,
        ...policyDecisionMeta,
        assetId: payload.assetId,
      });

      void recordShadowCandidate({
        funderAddress: payload.funderAddress,
        recommendationId: resolvedRecommendationId,
        orderIntentId: ledgerIntent.id,
        assetId: payload.assetId,
        marketId: payload.marketId,
        side: payload.side,
        intendedPrice: payload.limitPrice,
        intendedSize: payload.size,
        candidateSource: "runtime_automated",
        decisionSnapshotJson: buildDecisionContextSnapshot({
          wasBlocked: false,
          wasSubmitted: true,
            conciseBlockingReasons: softenConcentrationInPaper ? concentrationTokens : [],
          terminalStage: "execution_policy_allow",
          terminalModule: "lib/execution-policy/evaluate.ts",
          terminalFunction: "evaluateExecutionPolicy",
        }),
          executionPolicySnapshotJson: effectivePolicySnapshotJson,
        executionQualitySnapshotJson: eqRecord.snapshotJson,
        portfolioRiskSnapshotJson: concentrationInputSnapshotJson,
        runtimeSafetySnapshotJson: JSON.stringify({
          state: runtimeSafetyNow.state,
          blockingReasons: runtimeSafetyNow.blockingReasons,
          warnings: runtimeSafetyNow.warnings,
          evaluatedAt: runtimeSafetyNow.evaluatedAt,
        }),
        wasBlocked: false,
        wasSubmitted: true,
        wasFilled: null,
      }).catch(() => {});

      const intent: OrderIntent = {
        funderAddress: payload.funderAddress,
        strategyId: payload.strategyId,
        assetId: payload.assetId,
        marketId: payload.marketId,
        side: payload.side,
        size: payload.size,
        limitPrice: payload.limitPrice,
        intentId: ledgerIntent.id,
      };
      Promise.resolve(orderManager.reconcileIntents([intent])).catch((err) => {
        const reason = err instanceof Error ? err.message : String(err);
        diagnostics.recordReconcileFailure(reason, ledgerIntent.id);
        diagnostics.log("error", "Reconcile intents failed", {
          reason,
          intentId: ledgerIntent.id,
          assetId: payload.assetId,
        });
      });
    });
    });
    unsubs.push(unsubIntent);

    // Position updates gated by execution-ledger: apply only if ledger row exists and is unapplied; then mark applied.
    const unsubPartialFill = eventBus.subscribe("order.partial_fill", (event) => {
      const payload = event.payload as {
        funderAddress: string;
        runtimeOrderId: string;
        assetId: string;
        filledSize: number;
        fillPrice: number;
        filledAt: Date;
        exchangeFillId?: string | null;
      };
      const order = orderStore.get(payload.runtimeOrderId);
      if (!order) return;
      const applied = order.appliedPositionFilledSize ?? 0;
      const delta = payload.filledSize - applied;
      if (delta <= 0) return;

      if (!payload.exchangeFillId) {
        diagnostics.log("warn", "fill_skip_no_ledger_id", { runtimeOrderId: payload.runtimeOrderId, kind: "partial_fill" });
        return;
      }
      void (async () => {
        const ledgerRow = await getFillByFunderAndExchangeFillId(payload.funderAddress, payload.exchangeFillId!);
        if (!ledgerRow) {
          diagnostics.log("warn", "fill_skip_no_ledger_row", { exchangeFillId: payload.exchangeFillId, kind: "partial_fill" });
          return;
        }
        if (ledgerRow.appliedToRuntimePosition) {
          diagnostics.log("debug", "fill_skip_already_applied", { ledgerId: ledgerRow.id, exchangeFillId: payload.exchangeFillId });
          return;
        }
        diagnostics.log("debug", "fill_mutation_started", { ledgerId: ledgerRow.id, kind: "partial_fill" });
        const fill = normalizedFillFromOrderPartialFill(payload, order, delta);
        positionUpdater.applyFill(fill);
        orderStore.setAppliedPositionFilledSize(payload.runtimeOrderId, payload.filledSize);
        const marked = await markFillAppliedSafely({ id: ledgerRow.id });
        if (marked) {
          diagnostics.log("debug", "fill_marked_applied", { ledgerId: ledgerRow.id });
        } else {
          diagnostics.log("warn", "fill_mark_applied_failed_after_mutation", { ledgerId: ledgerRow.id });
        }
        diagnostics.recordPositionUpdate();
        diagnostics.recordPartialFillApplied();
        diagnostics.log("debug", "fill_mutation_succeeded", { ledgerId: ledgerRow.id, kind: "partial_fill" });
      })();
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
        exchangeFillId?: string | null;
      };
      const order = orderStore.get(payload.runtimeOrderId);
      if (!order) return;
      const applied = order.appliedPositionFilledSize ?? 0;
      const delta = payload.totalFilledSize - applied;
      if (delta <= 0) {
        diagnostics.recordFullFillApplied();
        return;
      }
      if (!payload.exchangeFillId) {
        diagnostics.log("warn", "fill_skip_no_ledger_id", { runtimeOrderId: payload.runtimeOrderId, kind: "fill" });
        return;
      }
      void (async () => {
        const ledgerRow = await getFillByFunderAndExchangeFillId(payload.funderAddress, payload.exchangeFillId!);
        if (!ledgerRow) {
          diagnostics.log("warn", "fill_skip_no_ledger_row", { exchangeFillId: payload.exchangeFillId, kind: "fill" });
          return;
        }
        if (ledgerRow.appliedToRuntimePosition) {
          diagnostics.log("debug", "fill_skip_already_applied", { ledgerId: ledgerRow.id, exchangeFillId: payload.exchangeFillId });
          return;
        }
        diagnostics.log("debug", "fill_mutation_started", { ledgerId: ledgerRow.id, kind: "fill" });
        const fill = normalizedFillFromOrderFilled({
          ...payload,
          totalFilledSize: delta,
          avgPrice: payload.avgPrice,
        });
        positionUpdater.applyFill(fill);
        orderStore.setAppliedPositionFilledSize(payload.runtimeOrderId, payload.totalFilledSize);
        const marked = await markFillAppliedSafely({ id: ledgerRow.id });
        if (marked) {
          diagnostics.log("debug", "fill_marked_applied", { ledgerId: ledgerRow.id });
        } else {
          diagnostics.log("warn", "fill_mark_applied_failed_after_mutation", { ledgerId: ledgerRow.id });
        }
        diagnostics.recordPositionUpdate();
        diagnostics.recordFullFillApplied();
        diagnostics.log("debug", "fill_mutation_succeeded", { ledgerId: ledgerRow.id, kind: "fill" });
      })();
    });
    unsubs.push(unsubFilled);

    return unsubs;
  }
}
