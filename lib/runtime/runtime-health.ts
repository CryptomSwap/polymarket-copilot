/**
 * Runtime health reporting: component readiness, stream connectivity, counts.
 * Read-only snapshot for ops/rollout; no side effects.
 * Lifecycle status vs stream connection status vs operational readiness are distinguished.
 *
 * Operator-facing payload: use `operatorHealth` for connected / heartbeat / data freshness /
 * reconciled / safe-to-automate. Legacy booleans on `streams` are kept for backward compat but
 * can look "green" while data is stale; prefer operatorHealth sections.
 */

import type { RuntimeMode } from "./runtime-config";
import { ROLLOUT_ALLOWED_MODES } from "./runtime-config";
import type { RuntimeDiagnosticsSnapshot } from "./telemetry/runtime-diagnostics";
import type { TradingExecutionPolicy } from "./trading-execution-policy";
import type { StreamConnectionState } from "./stream-connection-state";
import type { OperatingMode, OperatingModeSource } from "./operating-mode";
import type { TruthModelStatus } from "./truth/runtime-truth-model";

export type RuntimeHealthStatus = "starting" | "rebuilding" | "reconciling" | "ready" | "degraded" | "stopped";

/** Lifecycle / phase: explicit states so health can show not-ready truthfully. */
export type LifecycleStatus = "stopped" | "starting" | "rebuilding" | "reconciling" | "ready" | "degraded";

/** Socket status string for operator clarity. */
export type SocketStatus = "open" | "connecting" | "reconnecting" | "closed" | "unknown";

/** Operator health: separate sections so operators can tell connected vs heartbeat vs real data vs reconciled vs safe to automate. */
export interface OperatorHealth {
  /** Connection: socket open/closed. */
  connection: {
    market: { socketStatus: SocketStatus };
    user: { socketStatus: SocketStatus };
    bothConnected: boolean;
  };
  /** Heartbeat: PING/PONG recently seen. */
  heartbeat: {
    market: { lastHeartbeatAt: string | null; healthy: boolean };
    user: { lastHeartbeatAt: string | null; healthy: boolean };
    bothHealthy: boolean;
  };
  /** Data freshness: real exchange data (not just heartbeat). */
  dataFreshness: {
    market: { lastDataEventAt: string | null; dataFlowHealthy: boolean };
    user: { lastDataEventAt: string | null; dataFlowHealthy: boolean };
    bothHealthy: boolean;
  };
  /** Runtime vs exchange reconciliation. */
  reconciliation: {
    lastRunAt: string | null;
    lastSuccessAt: string | null;
    healthy: boolean;
    driftDetected: boolean;
    reconcileDurationMs: number;
  };
  /** Readiness: phase and whether automation is permitted. */
  readiness: {
    runtimePhase: RuntimeHealthStatus;
    operationalReadiness: boolean;
    automationPermitted: boolean;
    safeToAutomate: boolean;
  };
  /** Kill switch state. */
  killSwitch: {
    globalAutomationEnabled: boolean;
    tripped: boolean;
    reasons: string[];
  };
  /** Platform execution policy (when available). */
  executionPolicy: TradingExecutionPolicy | null;
  /** Exchange-truth authority: freshness and source by subsystem. */
  truthModel: TruthModelStatus | null;
  /** Execution failure containment: frozen assets and ambiguity counts (visible in health/diagnostics). */
  executionContainment?: {
    frozenAssetIds: string[];
    submitAmbiguousCount: number;
    cancelAmbiguousCount: number;
    replaceAmbiguousCount: number;
    executionVerificationRequiredCount: number;
    lastAmbiguityAt: string | null;
    shouldDegradeRuntime: boolean;
    shouldForceCancelOnlyOrFrozen: boolean;
  } | null;
}

export interface RuntimeHealth {
  status: RuntimeHealthStatus;
  /** Same as status; explicit lifecycle for clarity. */
  lifecycleStatus: LifecycleStatus;
  startedAt: Date | null;
  asOf: Date;
  /** Runtime mode: disabled | observe_only | paper | live_stub | live. */
  runtimeMode: RuntimeMode;
  /** @deprecated Use runtimeMode. Kept for backward compatibility. */
  mode: "paper" | "live";
  /** Modes allowed in this deployment (rollout safeguard). */
  allowedModes: readonly RuntimeMode[];
  /** Global automation enabled (kill switch not tripped). */
  globalAutomationEnabled: boolean;
  components: {
    eventBus: boolean;
    marketStateEngine: boolean;
    positionStore: boolean;
    orderManager: boolean;
    botRuntime: boolean;
    riskEngine: boolean;
    killSwitch: boolean;
  };
  streams: {
    /** @deprecated Use marketConnection.status === 'open'. Kept for backward compatibility. */
    marketWsConnected: boolean;
    /** @deprecated Use userConnection.status === 'open'. Kept for backward compatibility. */
    userWsConnected: boolean;
    /** Real market WebSocket connection state (null if not started). */
    marketConnection: StreamConnectionState | null;
    /** Real user WebSocket connection state (null if not started). */
    userConnection: StreamConnectionState | null;
    /** True when both market and user sockets are open. */
    socketOpen: boolean;
    /** True when both streams have recent heartbeat (PING/PONG). */
    heartbeatHealthy: boolean;
    /** True when both streams have recent real data (lastDataEventAt within thresholds). */
    dataFlowHealthy: boolean;
    /** True when both market and user streams are open and data flow healthy. Trust signal for "can process orders". */
    operationalReadiness: boolean;
    trackedAssetCount: number;
    /** Market stream last real data event time (ISO). */
    marketLastDataEventAt: string | null;
    /** User stream last real data event time (ISO). */
    userLastDataEventAt: string | null;
    /** Market stream last heartbeat time (ISO). */
    marketLastHeartbeatAt: string | null;
    /** User stream last heartbeat time (ISO). */
    userLastHeartbeatAt: string | null;
  };
  /** When status is degraded, reasons from computeDegraded + watchdog. */
  degradedReasons: string[];
  /** Watchdog evaluation state: reasons from last run (data silence, churn, etc.). */
  watchdogReasons: string[];
  /** Human-readable watchdog state summary. */
  watchdogState: "ok" | "degraded" | "kill_switch";
  counts: {
    /** Assets with stale market state. */
    staleAssetCount: number;
    /** Assets with degraded market state. */
    degradedAssetCount: number;
    /** Open/working order count. */
    openOrderCount: number;
    /** Scheduler queue size (if available). */
    schedulerBacklog: number;
    /** Runtime position count (from position store). */
    positionCount?: number;
    /** Gross exposure from positions (sum of |exposureNotional|). */
    grossExposure?: number;
    /** Net exposure from positions (signed sum by side). */
    netExposure?: number;
  };
  /** Diagnostics counters (market updates, events, bot evaluations, etc.). */
  diagnostics?: RuntimeDiagnosticsSnapshot | null;
  /** Runtime vs exchange reconciliation: last run time and status. */
  reconciliation?: {
    lastAt: string | null;
    status: "ok" | "failure" | null;
    /** ok = recent success, stale = no recent success, never_run = no run yet. */
    freshness: "ok" | "stale" | "never_run";
    driftDetected: boolean;
    reconcileDurationMs: number;
  } | null;
  /** Platform-wide trading execution policy (when available). Replaces hardcoded liveTradingBlocked. */
  executionPolicy?: TradingExecutionPolicy | null;
  /** Operator-facing sections: connection, heartbeat, dataFreshness, reconciliation, readiness, killSwitch. Prefer over streams.* booleans. */
  operatorHealth?: OperatorHealth | null;
  /** Market WS subscription coverage: desired vs subscribed, pending, churn. Null when no market WS. */
  marketSubscriptionCoverage?: MarketSubscriptionCoverageSnapshot | null;
  /** Effective operational mode (telemetry_only, frozen, cancel_only, reduce_only, paper_full, disabled). Visible in health for mode transitions. */
  operatingMode?: OperatingMode | null;
  /** Why this operating mode is in effect (config, phase, guardrail). */
  operatingModeSource?: OperatingModeSource | null;
  /** Exchange-truth authority status: freshness, timestamps, truthSourceBySubsystem. */
  truthModelStatus?: TruthModelStatus | null;
  /** Latency and data-integrity monitoring: stream/processing latencies and integrity counters. */
  latencyAndIntegrity?: import("./telemetry/runtime-latency-monitor").RuntimeLatencyMonitorSnapshot | null;
  metadata?: Record<string, unknown>;
}

/** Market subscription coverage for health/degraded. Same shape as MarketSubscriptionCoverage from ws-market. */
export interface MarketSubscriptionCoverageSnapshot {
  desiredTrackedAssetIds: string[];
  currentlySubscribedAssetIds: string[];
  pendingSubscribeIds: string[];
  pendingUnsubscribeIds: string[];
  lastSubscriptionRefreshAt: string | null;
  lastSuccessfulSubscriptionSyncAt: string | null;
  desiredNotSubscribed: string[];
  subscribedButNotDesired: string[];
  inSync: boolean;
  subscriptionChurnCount: number;
}

export const DEFAULT_RUNTIME_HEALTH: RuntimeHealth = {
  status: "stopped",
  lifecycleStatus: "stopped",
  startedAt: null,
  asOf: new Date(),
  runtimeMode: "paper",
  mode: "paper",
  allowedModes: ROLLOUT_ALLOWED_MODES,
  globalAutomationEnabled: false,
  components: {
    eventBus: false,
    marketStateEngine: false,
    positionStore: false,
    orderManager: false,
    botRuntime: false,
    riskEngine: false,
    killSwitch: false,
  },
  streams: {
    marketWsConnected: false,
    userWsConnected: false,
    marketConnection: null,
    userConnection: null,
    socketOpen: false,
    heartbeatHealthy: false,
    dataFlowHealthy: false,
    operationalReadiness: false,
    trackedAssetCount: 0,
    marketLastDataEventAt: null,
    userLastDataEventAt: null,
    marketLastHeartbeatAt: null,
    userLastHeartbeatAt: null,
  },
  degradedReasons: [],
  watchdogReasons: [],
  watchdogState: "ok",
  counts: {
    staleAssetCount: 0,
    degradedAssetCount: 0,
    openOrderCount: 0,
    schedulerBacklog: 0,
    positionCount: 0,
    grossExposure: 0,
    netExposure: 0,
  },
  diagnostics: null,
  reconciliation: null,
  operatorHealth: null,
};

/**
 * User stream data healthy: open connection and (recent lastDataEventAt or no open orders).
 * When there are no open orders, we do not require a user WS data event for health.
 * When there are open orders, a recent successful user_sync (REST) also counts as fresh user data
 * (same basis as stream watchdog), without treating heartbeats as data events.
 */
export function computeUserDataHealthy(
  userConnection: StreamConnectionState | null,
  nowMs: number,
  userDataDegradedThresholdMs: number,
  openOrderCount: number,
  lastSuccessfulUserTruthFetchAt?: Date | null
): boolean {
  if (!userConnection || userConnection.status !== "open") return false;
  const dataAt = userConnection.lastDataEventAt;
  const dataFresh =
    dataAt != null && nowMs - dataAt.getTime() <= userDataDegradedThresholdMs;
  const truthAt = lastSuccessfulUserTruthFetchAt ?? null;
  const truthFresh =
    truthAt != null && nowMs - truthAt.getTime() <= userDataDegradedThresholdMs;
  return dataFresh || openOrderCount === 0 || truthFresh;
}

/** Build operator health from stream state, reconciliation, readiness, and truth model. Used by StreamRuntime.getHealth(). */
export function buildOperatorHealth(params: {
  marketConnection: StreamConnectionState | null;
  userConnection: StreamConnectionState | null;
  marketDataHealthy: boolean;
  userDataHealthy: boolean;
  operationalReadiness: boolean;
  runtimePhase: RuntimeHealthStatus;
  globalAutomationEnabled: boolean;
  watchdogReasons: string[];
  reconciliationLastAt: string | null;
  reconciliationStatus: "ok" | "failure" | null;
  reconciliationDriftDetected: boolean;
  reconciliationDurationMs: number;
  executionPolicy: TradingExecutionPolicy | null;
  heartbeatMaxAgeMs?: number;
  /** Exchange-truth authority status (orders/fills freshness, truthSourceBySubsystem). */
  truthModelStatus?: TruthModelStatus | null;
  /** Execution failure containment: frozen assets and ambiguity (visible in health). */
  executionContainment?: OperatorHealth["executionContainment"];
}): OperatorHealth {
  const now = Date.now();
  const heartbeatMaxAge = params.heartbeatMaxAgeMs ?? 35_000;
  const market = params.marketConnection;
  const user = params.userConnection;
  const marketSocketStatus: SocketStatus = (market?.status as SocketStatus) ?? "closed";
  const userSocketStatus: SocketStatus = (user?.status as SocketStatus) ?? "closed";
  const marketHeartbeatAt = market?.lastHeartbeatAt?.toISOString() ?? null;
  const userHeartbeatAt = user?.lastHeartbeatAt?.toISOString() ?? null;
  const marketHeartbeatHealthy =
    market?.status === "open" &&
    market?.lastHeartbeatAt != null &&
    now - market.lastHeartbeatAt.getTime() <= heartbeatMaxAge;
  const userHeartbeatHealthy =
    user?.status === "open" &&
    user?.lastHeartbeatAt != null &&
    now - user.lastHeartbeatAt.getTime() <= heartbeatMaxAge;
  const lastSuccessAt =
    params.reconciliationStatus === "ok" && params.reconciliationLastAt ? params.reconciliationLastAt : null;
  const reconciliationHealthy =
    params.reconciliationStatus === "ok" &&
    params.reconciliationLastAt != null &&
    now - new Date(params.reconciliationLastAt).getTime() <= 120_000;
  const automationPermitted = params.runtimePhase === "ready" && params.globalAutomationEnabled;
  const safeToAutomate =
    params.operationalReadiness && params.globalAutomationEnabled && reconciliationHealthy;

  return {
    connection: {
      market: { socketStatus: marketSocketStatus },
      user: { socketStatus: userSocketStatus },
      bothConnected: market?.status === "open" && user?.status === "open",
    },
    heartbeat: {
      market: { lastHeartbeatAt: marketHeartbeatAt, healthy: !!marketHeartbeatHealthy },
      user: { lastHeartbeatAt: userHeartbeatAt, healthy: !!userHeartbeatHealthy },
      bothHealthy: !!marketHeartbeatHealthy && !!userHeartbeatHealthy,
    },
    dataFreshness: {
      market: {
        lastDataEventAt: market?.lastDataEventAt?.toISOString() ?? null,
        dataFlowHealthy: params.marketDataHealthy,
      },
      user: {
        lastDataEventAt: user?.lastDataEventAt?.toISOString() ?? null,
        dataFlowHealthy: params.userDataHealthy,
      },
      bothHealthy: params.marketDataHealthy && params.userDataHealthy,
    },
    reconciliation: {
      lastRunAt: params.reconciliationLastAt,
      lastSuccessAt,
      healthy: reconciliationHealthy,
      driftDetected: params.reconciliationDriftDetected,
      reconcileDurationMs: params.reconciliationDurationMs,
    },
    readiness: {
      runtimePhase: params.runtimePhase,
      operationalReadiness: params.operationalReadiness,
      automationPermitted,
      safeToAutomate,
    },
    killSwitch: {
      globalAutomationEnabled: params.globalAutomationEnabled,
      tripped: !params.globalAutomationEnabled,
      reasons: params.watchdogReasons,
    },
    executionContainment: params.executionContainment ?? null,
    executionPolicy: params.executionPolicy ?? null,
    truthModel: params.truthModelStatus ?? null,
  };
}

export function createRuntimeHealth(overrides: Partial<RuntimeHealth>): RuntimeHealth {
  return {
    ...DEFAULT_RUNTIME_HEALTH,
    asOf: new Date(),
    ...overrides,
  };
}
