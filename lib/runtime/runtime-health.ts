/**
 * Runtime health reporting: component readiness, stream connectivity, counts.
 * Read-only snapshot for ops/rollout; no side effects.
 * Lifecycle status vs stream connection status vs operational readiness are distinguished.
 */

import type { RuntimeMode } from "./runtime-config";
import { ROLLOUT_ALLOWED_MODES } from "./runtime-config";
import type { RuntimeDiagnosticsSnapshot } from "./telemetry/runtime-diagnostics";
import type { TradingExecutionPolicy } from "./trading-execution-policy";
import type { StreamConnectionState } from "./stream-connection-state";

export type RuntimeHealthStatus = "starting" | "ready" | "degraded" | "stopped";

/** Lifecycle: has start() been called and completed (components up). */
export type LifecycleStatus = "stopped" | "starting" | "ready" | "degraded";

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
    /** True when both market and user streams are open. Trust signal for "can process orders". */
    operationalReadiness: boolean;
    trackedAssetCount: number;
  };
  /** When status is degraded, reasons from computeDegraded. */
  degradedReasons: string[];
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
  /** Platform-wide trading execution policy (when available). Replaces hardcoded liveTradingBlocked. */
  executionPolicy?: TradingExecutionPolicy | null;
  metadata?: Record<string, unknown>;
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
    operationalReadiness: false,
    trackedAssetCount: 0,
  },
  degradedReasons: [],
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
};

export function createRuntimeHealth(overrides: Partial<RuntimeHealth>): RuntimeHealth {
  return {
    ...DEFAULT_RUNTIME_HEALTH,
    asOf: new Date(),
    ...overrides,
  };
}
