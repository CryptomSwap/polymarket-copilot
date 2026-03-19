/**
 * Runtime safety evaluator: deterministic state machine.
 * Fail closed; explicit reasons only; no hidden heuristics.
 */

import type { RuntimeSafetyInput, RuntimeSafetyResult, RuntimeSafetyState } from "./types";

const DEFAULT_RECONCILE_THRESHOLD_MS = 120_000;
const DEFAULT_MARKET_STALENESS_MS = 60_000;
const DEFAULT_USER_STALENESS_MS = 90_000;
const DEFAULT_MARKET_BLOCK_MS = 300_000;
const DEFAULT_USER_BLOCK_MS = 300_000;
const DEFAULT_REPEATED_ERRORS_THRESHOLD = 5;
const DEFAULT_FILL_BACKLOG_THRESHOLD = 100;

function nowIso(): string {
  return new Date().toISOString();
}

function toMs(v: number | Date | null | undefined): number | null {
  if (v == null) return null;
  if (typeof v === "number") return v >= 0 ? v : null;
  const t = v instanceof Date ? v.getTime() : new Date(v as unknown as string).getTime();
  return Number.isFinite(t) ? Date.now() - t : null;
}

/**
 * Evaluate runtime safety. Deterministic: same input => same output.
 * Order: manualOverride (dev) → kill_switch → blocked → degraded → normal.
 */
export function evaluateRuntimeSafety(input: RuntimeSafetyInput): RuntimeSafetyResult {
  const blockingReasons: string[] = [];
  const warnings: string[] = [];

  if (input.manualOverride != null) {
    const state = input.manualOverride;
    const snapshot = {
      state,
      blockingReasons: [],
      warnings: ["manual_override_active"],
      evaluatedAt: nowIso(),
    };
    return {
      state,
      blockingReasons: [],
      warnings: snapshot.warnings,
      evaluatedAt: snapshot.evaluatedAt,
      snapshotJson: JSON.stringify(snapshot),
    };
  }

  if (input.killSwitchActive === true) {
    blockingReasons.push("kill_switch_active");
    const snapshot = {
      state: "kill_switch" as const,
      blockingReasons: [...blockingReasons],
      warnings,
      evaluatedAt: nowIso(),
    };
    return {
      state: "kill_switch",
      blockingReasons,
      warnings,
      evaluatedAt: snapshot.evaluatedAt,
      snapshotJson: JSON.stringify(snapshot),
    };
  }

  if (input.exchangeTruthAvailable === false) {
    blockingReasons.push("exchange_truth_unavailable");
  }

  const reconThreshold = input.reconciliationThresholdMs ?? DEFAULT_RECONCILE_THRESHOLD_MS;
  const reconLastOkAtMs =
    input.reconciliationLastOkAt != null
      ? input.reconciliationLastOkAt instanceof Date
        ? input.reconciliationLastOkAt.getTime()
        : typeof input.reconciliationLastOkAt === "number"
          ? input.reconciliationLastOkAt
          : null
      : null;
  const reconAgeMs = reconLastOkAtMs != null ? Date.now() - reconLastOkAtMs : null;
  if (input.reconciliationDrift === true) {
    blockingReasons.push("reconciliation_drift");
  } else if (reconAgeMs != null && reconAgeMs > reconThreshold) {
    blockingReasons.push("reconciliation_stale");
  }

  const marketStaleMs = input.marketFeedMaxStalenessMs ?? DEFAULT_MARKET_STALENESS_MS;
  const userStaleMs = input.userFeedMaxStalenessMs ?? DEFAULT_USER_STALENESS_MS;
  const marketBlockMs = input.marketFeedBlockStalenessMs ?? DEFAULT_MARKET_BLOCK_MS;
  const userBlockMs = input.userFeedBlockStalenessMs ?? DEFAULT_USER_BLOCK_MS;

  const marketAgeMs =
    input.marketFeedFreshnessMs != null
      ? typeof input.marketFeedFreshnessMs === "number"
        ? input.marketFeedFreshnessMs
        : input.marketFeedFreshnessMs instanceof Date
          ? Date.now() - input.marketFeedFreshnessMs.getTime()
          : toMs(input.marketFeedFreshnessMs as unknown as Date)
      : null;
  const userAgeMs =
    input.userFeedFreshnessMs != null
      ? typeof input.userFeedFreshnessMs === "number"
        ? input.userFeedFreshnessMs
        : input.userFeedFreshnessMs instanceof Date
          ? Date.now() - input.userFeedFreshnessMs.getTime()
          : toMs(input.userFeedFreshnessMs as unknown as Date)
      : null;

  if (marketAgeMs != null) {
    if (marketAgeMs >= marketBlockMs) {
      blockingReasons.push("market_feed_extremely_stale");
    } else if (marketAgeMs >= marketStaleMs) {
      warnings.push("market_feed_stale");
    }
  } else {
    blockingReasons.push("market_feed_freshness_unknown");
  }

  if (userAgeMs != null) {
    if (userAgeMs >= userBlockMs) {
      blockingReasons.push("user_feed_extremely_stale");
    } else if (userAgeMs >= userStaleMs) {
      warnings.push("user_feed_stale");
    }
  } else {
    warnings.push("user_feed_freshness_unknown");
  }

  const phase = input.runtimePhase ?? "unknown";
  if (phase === "rebuilding" || phase === "starting") {
    blockingReasons.push("runtime_not_ready");
  } else if (phase === "reconciling") {
    warnings.push("runtime_reconciling");
  }

  const repeatedErrors = input.repeatedRuntimeErrors ?? 0;
  const repeatedThreshold = input.repeatedRuntimeErrorsThreshold ?? DEFAULT_REPEATED_ERRORS_THRESHOLD;
  if (repeatedErrors >= repeatedThreshold) {
    blockingReasons.push("repeated_runtime_errors");
  } else if (repeatedErrors > 0) {
    warnings.push("repeated_runtime_errors_low");
  }

  if (input.workerHealth === "unhealthy") {
    blockingReasons.push("worker_unhealthy");
  } else if (input.workerHealth === "degraded") {
    warnings.push("worker_degraded");
  }

  const fillBacklog = input.fillReplayBacklog ?? 0;
  const fillThreshold = input.fillReplayBacklogThreshold ?? DEFAULT_FILL_BACKLOG_THRESHOLD;
  if (fillBacklog > fillThreshold) {
    warnings.push("fill_replay_backlog_high");
  }

  let state: RuntimeSafetyState = "normal";
  if (blockingReasons.length > 0) {
    const hardBlock = blockingReasons.some(
      (r) =>
        r === "kill_switch_active" ||
        r === "exchange_truth_unavailable" ||
        r === "market_feed_extremely_stale" ||
        r === "user_feed_extremely_stale" ||
        r === "runtime_not_ready" ||
        r === "worker_unhealthy"
    );
    state = hardBlock ? "blocked" : "blocked";
  } else if (warnings.length > 0) {
    state = "degraded";
  }

  const snapshot = {
    state,
    blockingReasons: [...blockingReasons],
    warnings: [...warnings],
    evaluatedAt: nowIso(),
  };

  return {
    state,
    blockingReasons,
    warnings,
    evaluatedAt: snapshot.evaluatedAt,
    snapshotJson: JSON.stringify(snapshot),
  };
}
