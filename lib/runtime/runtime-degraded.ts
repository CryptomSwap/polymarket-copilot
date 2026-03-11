/**
 * Runtime degraded status: single place for rules that determine when the runtime
 * is considered degraded. Used by health/dashboard/snapshot to report status and reasons.
 */

import type { StreamConnectionState } from "./stream-connection-state";
import type { RuntimeDiagnosticsSnapshot } from "./telemetry/runtime-diagnostics";

export interface DegradedInputs {
  /** Market WebSocket connection state (null if not started). */
  marketConnection: StreamConnectionState | null;
  /** User WebSocket connection state (null if not started). */
  userConnection: StreamConnectionState | null;
  /** Max age in ms for lastMessageAt before considering stream stale. */
  streamStaleThresholdMs?: number;
  /** Diagnostics snapshot (reconcile failures, etc.). */
  diagnostics: RuntimeDiagnosticsSnapshot | null;
  /** Reconcile failure count threshold to mark degraded. */
  reconcileFailureThreshold?: number;
  /** Scheduler backlog (queue size). */
  schedulerBacklog: number;
  /** Scheduler backlog threshold to mark degraded. */
  schedulerBacklogThreshold?: number;
  /** Count of assets with stale market state. */
  staleAssetCount: number;
  /** Count of assets with degraded market state. */
  degradedAssetCount: number;
  /** Total tracked assets (for ratio). */
  trackedAssetCount: number;
  /** Stale asset ratio threshold (e.g. 0.5 = 50%). */
  staleRatioThreshold?: number;
  /** Whether startup completed cleanly (e.g. streams opened). */
  startupCompleted?: boolean;
}

const DEFAULT_STREAM_STALE_MS = 120_000;
const DEFAULT_RECONCILE_FAILURE_THRESHOLD = 3;
const DEFAULT_SCHEDULER_BACKLOG_THRESHOLD = 100;
const DEFAULT_STALE_RATIO_THRESHOLD = 0.5;

export interface DegradedResult {
  degraded: boolean;
  reasons: string[];
}

/**
 * Compute whether the runtime is degraded and why. All rules in one place.
 */
export function computeDegraded(inputs: DegradedInputs): DegradedResult {
  const reasons: string[] = [];
  const streamStaleMs = inputs.streamStaleThresholdMs ?? DEFAULT_STREAM_STALE_MS;
  const reconcileThreshold = inputs.reconcileFailureThreshold ?? DEFAULT_RECONCILE_FAILURE_THRESHOLD;
  const backlogThreshold = inputs.schedulerBacklogThreshold ?? DEFAULT_SCHEDULER_BACKLOG_THRESHOLD;
  const staleRatioThreshold = inputs.staleRatioThreshold ?? DEFAULT_STALE_RATIO_THRESHOLD;

  // WebSocket disconnected or stale too long
  const now = Date.now();
  if (inputs.marketConnection) {
    if (inputs.marketConnection.status !== "open") {
      reasons.push("market_ws_not_open");
    } else if (inputs.marketConnection.lastMessageAt) {
      const age = now - inputs.marketConnection.lastMessageAt.getTime();
      if (age > streamStaleMs) reasons.push("market_ws_stale");
    }
  }
  if (inputs.userConnection) {
    if (inputs.userConnection.status !== "open") {
      reasons.push("user_ws_not_open");
    } else if (inputs.userConnection.lastMessageAt) {
      const age = now - inputs.userConnection.lastMessageAt.getTime();
      if (age > streamStaleMs) reasons.push("user_ws_stale");
    }
  }

  // Repeated reconciliation failures
  if (inputs.diagnostics && inputs.diagnostics.reconcileFailureCount >= reconcileThreshold) {
    reasons.push("reconcile_failures");
  }

  // Scheduler backlog above threshold
  if (inputs.schedulerBacklog >= backlogThreshold) {
    reasons.push("scheduler_backlog_high");
  }

  // Stale/degraded asset counts (ratio of tracked)
  if (inputs.trackedAssetCount > 0) {
    const staleRatio = inputs.staleAssetCount / inputs.trackedAssetCount;
    if (staleRatio >= staleRatioThreshold) reasons.push("stale_asset_ratio_high");
    const degradedRatio = inputs.degradedAssetCount / inputs.trackedAssetCount;
    if (degradedRatio >= staleRatioThreshold) reasons.push("degraded_asset_ratio_high");
  }

  // Startup not completed cleanly (optional: e.g. if we had a flag for "streams never opened")
  if (inputs.startupCompleted === false) {
    reasons.push("startup_incomplete");
  }

  return {
    degraded: reasons.length > 0,
    reasons,
  };
}
