/**
 * Central configuration and rollout safeguards for the automated runtime.
 * Runtime mode gates what the system is allowed to do; only safe modes are enabled for rollout.
 */

/** Runtime mode: what the automated runtime is allowed to do. */
export type RuntimeMode =
  | "disabled"      // No automation; no bot evaluations or order flow.
  | "observe_only"  // Bot evaluates and emits telemetry only; no order intents, no reconciliation.
  | "paper"         // Full pipeline in paper mode: intents, reconciliation, paper adapter only.
  | "live_stub"     // Reserved for future: live adapter stub (no real orders).
  | "live";         // Live order placement (must be explicitly enabled; not in initial rollout).

/** Modes allowed in rollout; live order placement is never enabled by config alone. */
export const ROLLOUT_ALLOWED_MODES: readonly RuntimeMode[] = [
  "disabled",
  "observe_only",
  "paper",
] as const;

export type RolloutAllowedMode = (typeof ROLLOUT_ALLOWED_MODES)[number];

/** Default mode when env is unset: safe default. */
export const DEFAULT_RUNTIME_MODE: RolloutAllowedMode = "paper";

export interface RuntimeConfig {
  /** Current runtime mode. Only ROLLOUT_ALLOWED_MODES are valid at startup. */
  mode: RuntimeMode;
  /** Modes that are allowed by this deployment (rollout safeguard). */
  allowedModes: readonly RuntimeMode[];
  /** Human-readable source of config (e.g. "env", "default"). */
  source: string;
}

const ENV_KEY = "RUNTIME_MODE";

/**
 * Resolve runtime mode from environment.
 * Only values in ROLLOUT_ALLOWED_MODES are accepted; otherwise falls back to DEFAULT_RUNTIME_MODE.
 */
function modeFromEnv(): RuntimeMode {
  const raw = typeof process !== "undefined" ? process.env[ENV_KEY]?.trim().toLowerCase() : "";
  if (raw === "disabled" || raw === "observe_only" || raw === "paper") return raw;
  if (raw === "live_stub" || raw === "live") {
    // Explicitly not in rollout; treat as invalid and use default.
    return DEFAULT_RUNTIME_MODE;
  }
  return DEFAULT_RUNTIME_MODE;
}

/**
 * Get the current runtime configuration.
 * Mode is clamped to rollout-allowed modes so live cannot be turned on by env alone.
 */
export function getRuntimeConfig(): RuntimeConfig {
  const fromEnv = modeFromEnv();
  const mode: RuntimeMode = ROLLOUT_ALLOWED_MODES.includes(fromEnv as RolloutAllowedMode)
    ? fromEnv
    : DEFAULT_RUNTIME_MODE;
  return {
    mode,
    allowedModes: ROLLOUT_ALLOWED_MODES,
    source: typeof process !== "undefined" && process.env[ENV_KEY] ? "env" : "default",
  };
}

/**
 * True only when runtime is allowed to place orders on a live exchange.
 * False for disabled, observe_only, paper, live_stub.
 * Used by adapter layer to block accidental live submission.
 */
export function isLiveOrderPlacementAllowed(config?: RuntimeConfig): boolean {
  const c = config ?? getRuntimeConfig();
  return c.mode === "live";
}

/**
 * True when the bot may emit order intents and the order manager may reconcile (paper or live).
 * False for disabled and observe_only.
 */
export function isOrderIntentAndReconciliationAllowed(config?: RuntimeConfig): boolean {
  const c = config ?? getRuntimeConfig();
  return c.mode === "paper" || c.mode === "live";
}

/**
 * True when the bot may run evaluations (observe_only, paper, live_stub, live).
 * False only for disabled.
 */
export function isBotEvaluationAllowed(config?: RuntimeConfig): boolean {
  const c = config ?? getRuntimeConfig();
  return c.mode !== "disabled";
}

/**
 * True when the execution path may run order manager reconciliation (paper or live_stub only).
 * False for disabled, observe_only, and live (live remains blocked until real adapter + explicit enablement).
 * Use at intent-consumer boundary to gate reconcileIntents; fail-closed.
 */
export function isPaperOrLiveStubExecutionAllowed(config?: RuntimeConfig): boolean {
  const c = config ?? getRuntimeConfig();
  return c.mode === "paper" || c.mode === "live_stub";
}

/**
 * Assert that live order placement is not allowed; throw if it is.
 * Use at adapter or order-manager entry points to prevent accidental live orders.
 */
export function assertNoLiveOrderPlacement(config?: RuntimeConfig): void {
  if (isLiveOrderPlacementAllowed(config)) {
    throw new Error(
      "[runtime-config] Live order placement is not enabled. Current mode does not allow live exchange orders."
    );
  }
}
