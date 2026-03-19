/**
 * Explicit operational runtime modes for health and behavior.
 * Maps onto execution policy and guardrails; mode transitions are visible in health endpoints.
 */

import type { RuntimeMode } from "./runtime-config";
import type { GuardrailVerdict } from "./risk/runtime-guardrails";

/** Operational mode: what the runtime is effectively allowed to do. */
export type OperatingMode =
  | "telemetry_only"  // Evaluate + observe; no intents admitted.
  | "frozen"          // No new action; no cancel unless explicitly requested (e.g. manual).
  | "cancel_only"     // Only cancel permitted.
  | "reduce_only"     // Only risk-reducing actions permitted (cancel, reduce, exit).
  | "paper_full"      // Full paper pipeline: intents, reconciliation, paper adapter.
  | "disabled";       // No automation; no bot evaluations or order flow.

/** Why this operating mode is in effect (for health visibility). */
export type OperatingModeSource =
  | "config"    // From runtime mode (disabled, observe_only, paper).
  | "phase"     // Runtime phase not ready (e.g. rebuilding) → frozen.
  | "guardrail"; // Guardrail verdict restricts to frozen / cancel_only / reduce_only.

export interface EffectiveOperatingModeResult {
  operatingMode: OperatingMode;
  source: OperatingModeSource;
  /** Underlying runtime mode from config. */
  runtimeMode: RuntimeMode;
}

/**
 * Compute effective operating mode from config, runtime phase, and optional guardrail verdict.
 * Used by health endpoints so operators see current mode and why.
 */
export function getEffectiveOperatingMode(params: {
  runtimeMode: RuntimeMode;
  runtimePhase: string;
  guardrailVerdict?: GuardrailVerdict | null;
}): EffectiveOperatingModeResult {
  const { runtimeMode, runtimePhase, guardrailVerdict } = params;

  if (runtimeMode === "disabled") {
    return { operatingMode: "disabled", source: "config", runtimeMode };
  }
  if (runtimeMode === "observe_only") {
    return { operatingMode: "telemetry_only", source: "config", runtimeMode };
  }

  // paper or live_stub: phase and guardrails can restrict
  if (runtimePhase !== "ready") {
    return { operatingMode: "frozen", source: "phase", runtimeMode };
  }
  if (guardrailVerdict === "frozen") {
    return { operatingMode: "frozen", source: "guardrail", runtimeMode };
  }
  if (guardrailVerdict === "cancel_only") {
    return { operatingMode: "cancel_only", source: "guardrail", runtimeMode };
  }
  if (guardrailVerdict === "requires_reduction") {
    return { operatingMode: "reduce_only", source: "guardrail", runtimeMode };
  }
  if (guardrailVerdict === "blocked") {
    return { operatingMode: "paper_full", source: "guardrail", runtimeMode };
  }

  return { operatingMode: "paper_full", source: "config", runtimeMode };
}

/** True when no intents are admitted (telemetry_only, disabled, frozen). */
export function isNoIntentAdmitted(mode: OperatingMode): boolean {
  return mode === "disabled" || mode === "telemetry_only" || mode === "frozen";
}

/** True when only cancel is permitted. */
export function isCancelOnly(mode: OperatingMode): boolean {
  return mode === "cancel_only";
}

/** True when only risk-reducing actions (cancel, reduce, exit) are permitted. */
export function isReduceOnly(mode: OperatingMode): boolean {
  return mode === "reduce_only";
}

/** True when full paper pipeline is allowed. */
export function isPaperFull(mode: OperatingMode): boolean {
  return mode === "paper_full";
}
