/**
 * Platform-wide trading execution policy.
 * Single source of truth for which execution surfaces are allowed to place or cancel
 * real orders. Replaces fragmented checks with one central policy governing ALL
 * order-capable surfaces (StreamRuntime automated path + manual/API routes).
 *
 * Fail-closed: live and manual execution are blocked unless explicitly authorized
 * by this policy. Unsupported requested modes are surfaced via blocked reasons.
 */

import { getRuntimeConfig, type RuntimeConfig, type RuntimeMode } from "./runtime-config";

/** Execution surface: which code path is attempting to place or cancel an order. */
export type ExecutionSurface =
  | "runtime_automated"   // StreamRuntime intent → reconcileIntents (paper adapter only when allowed)
  | "manual_api"         // POST /api/orders/place
  | "approval_queue"     // POST /api/bot/approval-queue/[id]/execute
  | "position_exit";     // POST /api/positions/place-exit

/** Human-readable reason why a surface is blocked. */
export type BlockedReason =
  | "runtime_mode_disabled"
  | "runtime_mode_observe_only"
  | "runtime_mode_live_not_enabled"
  | "live_manual_not_authorized"
  | "requested_mode_not_in_rollout"
  | "policy_fail_closed";

export interface TradingExecutionPolicy {
  /** Mode requested from env (before clamp). For observability only. */
  requestedRuntimeMode: RuntimeMode | null;
  /** Effective runtime mode (after rollout clamp). Only ROLLOUT_ALLOWED_MODES. */
  effectiveRuntimeMode: RuntimeMode;
  /** Config source (e.g. "env", "default"). */
  configSource: string;
  /** Automated runtime (StreamRuntime) may execute: paper only when mode is paper or live_stub; never live. */
  automatedExecutionAllowed: boolean;
  /** Live/manual execution (manual_api, approval_queue, position_exit) may place/cancel real CLOB orders. */
  liveOrManualExecutionAllowed: boolean;
  /** Surfaces that are currently allowed to execute (paper for runtime_automated when allowed; none for live). */
  allowedSurfaces: ExecutionSurface[];
  /** Reasons (if any) why execution is blocked. Global and per-surface. */
  blockedReasons: BlockedReason[];
  /** Per-surface blocked reasons for observability. */
  blockedReasonsBySurface: Partial<Record<ExecutionSurface, BlockedReason[]>>;
}

const POLICY_ERROR_PREFIX = "[trading-execution-policy]";

/**
 * Build the platform-wide trading execution policy from runtime config.
 * Single source of truth; all order-capable code paths must use this.
 */
export function getTradingExecutionPolicy(config?: RuntimeConfig): TradingExecutionPolicy {
  const c = config ?? getRuntimeConfig();
  const effective = c.mode;
  const requested = getRequestedRuntimeModeFromEnv();

  const blockedReasons: BlockedReason[] = [];
  const blockedReasonsBySurface: Partial<Record<ExecutionSurface, BlockedReason[]>> = {};

  // Automated: allowed only when effective mode is paper or live_stub (never live in rollout).
  const automatedExecutionAllowed = effective === "paper" || effective === "live_stub";
  if (!automatedExecutionAllowed) {
    if (effective === "disabled") blockedReasons.push("runtime_mode_disabled");
    else if (effective === "observe_only") blockedReasons.push("runtime_mode_observe_only");
    else if (effective === "live") blockedReasons.push("runtime_mode_live_not_enabled");
    blockedReasonsBySurface.runtime_automated = [...blockedReasons];
  }

  // Live/manual: explicitly not enabled in current rollout (fail-closed).
  const liveOrManualExecutionAllowed = false;
  if (liveOrManualExecutionAllowed === false) {
    blockedReasons.push("live_manual_not_authorized");
    blockedReasonsBySurface.manual_api = ["live_manual_not_authorized"];
    blockedReasonsBySurface.approval_queue = ["live_manual_not_authorized"];
    blockedReasonsBySurface.position_exit = ["live_manual_not_authorized"];
  }

  // If user set RUNTIME_MODE=live or live_stub, surface that it was clamped.
  if (requested === "live" || requested === "live_stub") {
    blockedReasons.push("requested_mode_not_in_rollout");
  }

  const allowedSurfaces: ExecutionSurface[] = [];
  if (automatedExecutionAllowed) allowedSurfaces.push("runtime_automated");
  if (liveOrManualExecutionAllowed) {
    allowedSurfaces.push("manual_api", "approval_queue", "position_exit");
  }

  return {
    requestedRuntimeMode: requested,
    effectiveRuntimeMode: effective,
    configSource: c.source,
    automatedExecutionAllowed,
    liveOrManualExecutionAllowed,
    allowedSurfaces,
    blockedReasons,
    blockedReasonsBySurface,
  };
}

/** Read raw RUNTIME_MODE from env (for observability; may be clamped in effective mode). */
function getRequestedRuntimeModeFromEnv(): RuntimeMode | null {
  if (typeof process === "undefined") return null;
  const raw = process.env.RUNTIME_MODE?.trim().toLowerCase() ?? "";
  if (raw === "disabled" || raw === "observe_only" || raw === "paper") return raw;
  if (raw === "live_stub" || raw === "live") return raw;
  if (raw === "") return null;
  return null;
}

/**
 * Return whether the given execution surface is allowed to execute (place/cancel orders).
 * For runtime_automated: true only when automatedExecutionAllowed (paper/live_stub).
 * For manual_api, approval_queue, position_exit: true only when liveOrManualExecutionAllowed (false in current policy).
 */
export function isExecutionAllowed(surface: ExecutionSurface, config?: RuntimeConfig): boolean {
  const policy = getTradingExecutionPolicy(config);
  if (surface === "runtime_automated") return policy.automatedExecutionAllowed;
  return policy.liveOrManualExecutionAllowed;
}

/**
 * Return human-readable reasons why the given surface is blocked.
 * Empty array if surface is allowed.
 */
export function getExecutionBlockedReasons(
  surface: ExecutionSurface,
  config?: RuntimeConfig
): BlockedReason[] {
  const policy = getTradingExecutionPolicy(config);
  const bySurface = policy.blockedReasonsBySurface[surface];
  return bySurface ?? [];
}

/**
 * Assert that the given execution surface is allowed. Throw with a clear message if blocked.
 * Use at every order-capable entry point (StreamRuntime intent handler, API routes, trading.ts).
 */
export function assertExecutionAllowed(surface: ExecutionSurface, config?: RuntimeConfig): void {
  if (isExecutionAllowed(surface, config)) return;
  const reasons = getExecutionBlockedReasons(surface, config);
  const policy = getTradingExecutionPolicy(config);
  const reasonStr = reasons.length > 0 ? reasons.join(", ") : "policy_fail_closed";
  throw new Error(
    `${POLICY_ERROR_PREFIX} Execution not allowed for surface "${surface}". ` +
      `Effective mode: ${policy.effectiveRuntimeMode}. Blocked: ${reasonStr}. ` +
      "Live and manual execution are disabled by platform policy."
  );
}
