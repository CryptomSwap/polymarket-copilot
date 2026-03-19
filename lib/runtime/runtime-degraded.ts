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
  /** Max age in ms for lastMessageAt before considering stream stale (legacy; prefer data thresholds). */
  streamStaleThresholdMs?: number;
  /** Max age in ms for lastDataEventAt (market) before considering market data stale. */
  marketDataStaleThresholdMs?: number;
  /** Max age in ms for lastDataEventAt (user) before considering user data stale. */
  userDataStaleThresholdMs?: number;
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
  /** Open/working order count (for user stream silence severity). */
  openOrderCount?: number;
  /** Stale asset ratio threshold (e.g. 0.5 = 50%). */
  staleRatioThreshold?: number;
  /**
   * Degraded asset ratio threshold. When degradedAssetCount/trackedAssetCount >= this, add degraded_asset_ratio_high.
   * Default 1.0 = effectively off (many tracked assets are inactive; per-asset guardrails still block). Set < 1 to re-enable.
   */
  degradedRatioThreshold?: number;
  /** Reconnect attempts threshold for churn (reconnect_attempts_high). */
  reconnectChurnAttemptsThreshold?: number;
  /** Runtime vs exchange reconciliation: failure count threshold to mark degraded. */
  runtimeReconciliationFailureThreshold?: number;
  /** Whether startup completed cleanly (e.g. streams opened). */
  startupCompleted?: boolean;
  /** Market subscription coverage (desired vs subscribed). When null, subscription reasons are skipped. */
  marketSubscriptionCoverage?: {
    inSync: boolean;
    desiredNotSubscribed: string[];
    subscribedButNotDesired: string[];
    subscriptionChurnCount: number;
    lastSuccessfulSubscriptionSyncAt: string | null;
    desiredTrackedAssetIds: string[];
  } | null;
  /** Subscription churn threshold: changes in window above this => subscription_churn. */
  subscriptionChurnThreshold?: number;
  /** Max age (ms) for lastSuccessfulSubscriptionSyncAt before considering resubscribe incomplete. */
  subscriptionSyncStaleMs?: number;
  /** Exchange truth: last successful orders snapshot time (null = never or unavailable). */
  lastExchangeOrdersSnapshotAt?: Date | null;
  /** Exchange truth: last successful fills snapshot time (null = never or unavailable). */
  lastExchangeFillsSnapshotAt?: Date | null;
  /** Max age (ms) for orders snapshot before exchange_truth_orders_stale. */
  exchangeOrdersStaleThresholdMs?: number;
  /** Max age (ms) for fills snapshot before exchange_truth_fills_stale. */
  exchangeFillsStaleThresholdMs?: number;
  /** If true, add exchange_truth_unavailable (e.g. no credentials or pull failed). */
  exchangeTruthUnavailable?: boolean;
  /** Last successful user_sync (orders+trades REST); aligns degraded rules with stream watchdog when WS is quiet. */
  lastSuccessfulUserTruthFetchAt?: Date | null;
  /** Execution failure containment: repeated ambiguities in window => degrade. */
  executionAmbiguityShouldDegrade?: boolean;
  /** Execution failure containment: count of assets with frozen execution (ambiguous outcome). */
  executionFrozenAssetCount?: number;
  /** Threshold: frozen asset count above this can add execution_frozen_assets to reasons. */
  executionFrozenAssetCountThreshold?: number;
  /** Latency/integrity: reasons from RuntimeLatencyMonitor.getDegradedReasons(). */
  latencyDegradedReasons?: string[];
}

const DEFAULT_STREAM_STALE_MS = 120_000;
const DEFAULT_MARKET_DATA_STALE_MS = 60_000;
const DEFAULT_USER_DATA_STALE_MS = 90_000;
const DEFAULT_RECONCILE_FAILURE_THRESHOLD = 3;
const DEFAULT_SCHEDULER_BACKLOG_THRESHOLD = 100;
const DEFAULT_STALE_RATIO_THRESHOLD = 0.5;
/** 1.0 = do not mark runtime degraded for high degraded ratio (inactive assets are normal). */
const DEFAULT_DEGRADED_RATIO_THRESHOLD = 1.0;
const DEFAULT_RECONNECT_CHURN_ATTEMPTS = 5;
const DEFAULT_SUBSCRIPTION_CHURN_THRESHOLD = 8;
const DEFAULT_SUBSCRIPTION_SYNC_STALE_MS = 120_000; // 2 min
const DEFAULT_EXCHANGE_ORDERS_STALE_MS = 120_000; // 2 min
const DEFAULT_EXCHANGE_FILLS_STALE_MS = 180_000; // 3 min

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
  const marketDataStaleMs = inputs.marketDataStaleThresholdMs ?? DEFAULT_MARKET_DATA_STALE_MS;
  const userDataStaleMs = inputs.userDataStaleThresholdMs ?? DEFAULT_USER_DATA_STALE_MS;
  const reconcileThreshold = inputs.reconcileFailureThreshold ?? DEFAULT_RECONCILE_FAILURE_THRESHOLD;
  const backlogThreshold = inputs.schedulerBacklogThreshold ?? DEFAULT_SCHEDULER_BACKLOG_THRESHOLD;
  const staleRatioThreshold = inputs.staleRatioThreshold ?? DEFAULT_STALE_RATIO_THRESHOLD;
  const degradedRatioThreshold = inputs.degradedRatioThreshold ?? DEFAULT_DEGRADED_RATIO_THRESHOLD;
  const reconnectChurnThreshold = inputs.reconnectChurnAttemptsThreshold ?? DEFAULT_RECONNECT_CHURN_ATTEMPTS;
  const runtimeReconcileFailureThreshold = inputs.runtimeReconciliationFailureThreshold ?? 3;

  const now = Date.now();

  // WebSocket disconnected
  if (inputs.marketConnection && inputs.marketConnection.status !== "open") {
    reasons.push("market_ws_not_open");
  }
  if (inputs.userConnection && inputs.userConnection.status !== "open") {
    reasons.push("user_ws_not_open");
  }

  // Data freshness: lastDataEventAt = real data only; heartbeat must not count as data flow
  if (inputs.marketConnection?.status === "open") {
    if (inputs.trackedAssetCount > 0 && inputs.marketConnection.lastDataEventAt == null) {
      reasons.push("market_data_silence");
    } else {
      const dataAt = inputs.marketConnection.lastDataEventAt ?? inputs.marketConnection.lastMessageAt;
      if (dataAt) {
        const age = now - dataAt.getTime();
        if (inputs.marketConnection.lastDataEventAt != null) {
          if (age > marketDataStaleMs) reasons.push("market_data_stale");
        } else {
          if (age > streamStaleMs) reasons.push("market_ws_stale");
        }
      }
    }
  }
  if (inputs.userConnection?.status === "open") {
    const openOrders = inputs.openOrderCount ?? 0;
    const userTruthAt = inputs.lastSuccessfulUserTruthFetchAt ?? null;
    const userTruthFresh =
      userTruthAt != null && now - userTruthAt.getTime() <= userDataStaleMs;
    const effectiveUserDataAtForSilence =
      inputs.userConnection.lastDataEventAt ?? (userTruthFresh ? userTruthAt : null);
    if (openOrders > 0 && effectiveUserDataAtForSilence == null) {
      reasons.push("user_data_silence_with_orders");
    } else {
      const dataAt =
        inputs.userConnection.lastDataEventAt ??
        (userTruthFresh ? userTruthAt : null) ??
        inputs.userConnection.lastMessageAt;
      if (dataAt) {
        const age = now - dataAt.getTime();
        if (inputs.userConnection.lastDataEventAt != null) {
          if (age > userDataStaleMs) reasons.push("user_data_stale");
        } else {
          if (age > streamStaleMs) reasons.push("user_ws_stale");
        }
      }
    }
  }

  // Reconnect churn
  const marketAttempts = inputs.marketConnection?.reconnectAttempts ?? 0;
  const userAttempts = inputs.userConnection?.reconnectAttempts ?? 0;
  if (marketAttempts >= reconnectChurnThreshold || userAttempts >= reconnectChurnThreshold) {
    reasons.push("reconnect_churn");
  }

  // Intent reconciliation failures (reconcileIntents threw)
  if (inputs.diagnostics && inputs.diagnostics.reconcileFailureCount >= reconcileThreshold) {
    reasons.push("reconcile_failures");
  }

  // Runtime vs exchange reconciliation repeatedly failing
  if (
    inputs.diagnostics &&
    inputs.diagnostics.runtimeReconciliationRuns >= 1 &&
    inputs.diagnostics.runtimeReconciliationFailures >= runtimeReconcileFailureThreshold
  ) {
    reasons.push("runtime_reconciliation_repeated_failure");
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
    if (degradedRatio >= degradedRatioThreshold) reasons.push("degraded_asset_ratio_high");
  }

  // Startup not completed cleanly (optional: e.g. if we had a flag for "streams never opened")
  if (inputs.startupCompleted === false) {
    reasons.push("startup_incomplete");
  }

  // Exchange truth: authoritative pull freshness (only when not explicitly unavailable)
  if (inputs.exchangeTruthUnavailable) {
    reasons.push("exchange_truth_unavailable");
    reasons.push("exchange_truth_stale");
  } else {
    const ordersStaleMs = inputs.exchangeOrdersStaleThresholdMs ?? DEFAULT_EXCHANGE_ORDERS_STALE_MS;
    const fillsStaleMs = inputs.exchangeFillsStaleThresholdMs ?? DEFAULT_EXCHANGE_FILLS_STALE_MS;
    if (inputs.lastExchangeOrdersSnapshotAt != null) {
      const ordersAge = now - inputs.lastExchangeOrdersSnapshotAt.getTime();
      if (ordersAge > ordersStaleMs) reasons.push("exchange_truth_orders_stale");
    } else {
      reasons.push("exchange_truth_orders_stale");
    }
    if (inputs.lastExchangeFillsSnapshotAt != null) {
      const fillsAge = now - inputs.lastExchangeFillsSnapshotAt.getTime();
      if (fillsAge > fillsStaleMs) reasons.push("exchange_truth_fills_stale");
    } else {
      reasons.push("exchange_truth_fills_stale");
    }
    if (
      reasons.includes("exchange_truth_orders_stale") ||
      reasons.includes("exchange_truth_fills_stale")
    ) {
      reasons.push("exchange_truth_stale");
    }
  }

  // Execution failure containment: repeated ambiguity or many frozen assets
  if (inputs.executionAmbiguityShouldDegrade === true) {
    reasons.push("execution_ambiguity_repeated");
  }
  const frozenThreshold = inputs.executionFrozenAssetCountThreshold ?? 2;
  if (
    typeof inputs.executionFrozenAssetCount === "number" &&
    inputs.executionFrozenAssetCount >= frozenThreshold
  ) {
    reasons.push("execution_frozen_assets");
  }

  // Latency and data-integrity: severe processing latency or integrity rate
  if (inputs.latencyDegradedReasons?.length) {
    for (const r of inputs.latencyDegradedReasons) reasons.push(r);
  }

  // Market subscription coverage: mismatch, churn, incomplete resubscribe
  const coverage = inputs.marketSubscriptionCoverage;
  if (coverage && inputs.marketConnection?.status === "open") {
    const churnThreshold = inputs.subscriptionChurnThreshold ?? DEFAULT_SUBSCRIPTION_CHURN_THRESHOLD;
    const syncStaleMs = inputs.subscriptionSyncStaleMs ?? DEFAULT_SUBSCRIPTION_SYNC_STALE_MS;
    if (!coverage.inSync) {
      reasons.push("subscription_mismatch");
    }
    if (coverage.subscriptionChurnCount >= churnThreshold) {
      reasons.push("subscription_churn");
    }
    if (
      coverage.desiredNotSubscribed.length > 0 &&
      coverage.desiredTrackedAssetIds.length > 0
    ) {
      const lastSync = coverage.lastSuccessfulSubscriptionSyncAt
        ? now - new Date(coverage.lastSuccessfulSubscriptionSyncAt).getTime()
        : Infinity;
      if (lastSync > syncStaleMs) {
        reasons.push("incomplete_resubscribe");
      }
    }
  }

  return {
    degraded: reasons.length > 0,
    reasons,
  };
}
