/**
 * Single source of truth for reading worker heartbeat metadataJson fields.
 * All diagnostic reports should use this so runtimeSafety, drift, and alignment agree.
 *
 * Schema: worker/index.ts getMetadata() returns { runtimeHealth, runtimeSafety, liveReadiness, ... }.
 * reconciliation + drift live under runtimeHealth.reconciliation (not top-level meta.reconciliation).
 */

export type CanonicalWorkerHeartbeatRuntime = {
  /** meta.runtimeSafety.state */
  runtimeSafetyState: string | null;
  /** meta.runtimeHealth.reconciliation.driftDetected (post-repair truth from worker) */
  driftDetected: boolean | null;
  /** meta.runtimeHealth.metadata.reconciliationAlignmentReady */
  reconciliationAlignmentReady: boolean | null;
  reconciliationFreshness: string | null;
  reconciliationStatus: string | null;
  reconciliationLastAt: string | null;
};

export function parseHeartbeatMetadataJson(metadataJson: string | null | undefined): Record<string, unknown> | null {
  if (!metadataJson) return null;
  try {
    return JSON.parse(metadataJson) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Extract fields every report should show for apples-to-apples comparison.
 */
export function extractCanonicalWorkerRuntime(meta: Record<string, unknown> | null): CanonicalWorkerHeartbeatRuntime {
  if (!meta) {
    return {
      runtimeSafetyState: null,
      driftDetected: null,
      reconciliationAlignmentReady: null,
      reconciliationFreshness: null,
      reconciliationStatus: null,
      reconciliationLastAt: null,
    };
  }

  const rs = meta.runtimeSafety as Record<string, unknown> | undefined;
  const runtimeSafetyState = typeof rs?.state === "string" ? rs.state : null;

  const rh = meta.runtimeHealth as Record<string, unknown> | undefined;
  const rec = rh?.reconciliation as Record<string, unknown> | undefined;
  const driftRaw = rec?.driftDetected;
  let driftDetected: boolean | null = null;
  if (typeof driftRaw === "boolean") driftDetected = driftRaw;
  else if (typeof driftRaw === "string") driftDetected = driftRaw === "true";

  const md = rh?.metadata as Record<string, unknown> | undefined;
  const align = md?.reconciliationAlignmentReady;
  const reconciliationAlignmentReady = typeof align === "boolean" ? align : null;

  return {
    runtimeSafetyState,
    driftDetected,
    reconciliationAlignmentReady,
    reconciliationFreshness: typeof rec?.freshness === "string" ? rec.freshness : null,
    reconciliationStatus: typeof rec?.status === "string" ? rec.status : null,
    reconciliationLastAt: typeof rec?.lastAt === "string" ? rec.lastAt : null,
  };
}

export function heartbeatIsFresh(lastSeenAt: Date | null, nowMs: number, maxAgeMs: number): boolean {
  if (!lastSeenAt) return false;
  return nowMs - lastSeenAt.getTime() < maxAgeMs;
}

/** Reasons that indicate data/truth/runtime gate (not position limits). */
const RUNTIME_OR_TRUTH_BLOCKER =
  /operational:runtime|exchange_truth|reconciliation_stale|reconciliation_drift|market_data_stale|user_data_stale|kill_switch/i;

/** Execution / risk policy on the live path. */
const EXECUTION_POLICY_BLOCKER = /working_orders|exposure|concentration|liquidity|spread|slippage|notional|theme/i;

export function classifyShadowBlockingReason(reason: string): "runtime_or_truth" | "execution_policy" | "other" {
  if (RUNTIME_OR_TRUTH_BLOCKER.test(reason) || /kill_switch|runtime_safety/.test(reason)) {
    return "runtime_or_truth";
  }
  if (EXECUTION_POLICY_BLOCKER.test(reason)) {
    return "execution_policy";
  }
  return "other";
}

/**
 * Among top-N reason strings by occurrence count: share of counts classified runtime_or_truth.
 * High share => ShadowCandidate telemetry still dominated by truth/runtime gates.
 */
export function runtimeBlockerDominanceInTopReasons(
  topReasons: { reason: string; count: number }[],
  topN: number
): {
  topNRuntimeShare: number;
  runtimeDominates: boolean;
  executionPolicyShare: number;
} {
  const slice = topReasons.slice(0, topN);
  let runtimeSum = 0;
  let policySum = 0;
  let total = 0;
  for (const { reason, count } of slice) {
    total += count;
    const c = classifyShadowBlockingReason(reason);
    if (c === "runtime_or_truth") runtimeSum += count;
    else if (c === "execution_policy") policySum += count;
  }
  const topNRuntimeShare = total > 0 ? runtimeSum / total : 0;
  const executionPolicyShare = total > 0 ? policySum / total : 0;
  /** Dominate if runtime share > 55% of top-N mass (telemetry still mostly truth/runtime blocks). */
  const runtimeDominates = topNRuntimeShare > 0.55;
  return { topNRuntimeShare, runtimeDominates, executionPolicyShare };
}
