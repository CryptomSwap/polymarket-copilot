/**
 * Runtime safety state store: single source of truth for current safety state.
 * Safe to read from runtime execution path, execution policy, APIs, and UI.
 */

import type { RuntimeSafetyResult, RuntimeSafetyState } from "./types";

let currentSafetyState: RuntimeSafetyState = "normal";
let lastEvaluation: RuntimeSafetyResult | null = null;

/**
 * Update the current runtime safety state. Call after each evaluateRuntimeSafety.
 */
export function updateRuntimeSafetyState(result: RuntimeSafetyResult): void {
  currentSafetyState = result.state;
  lastEvaluation = result;
}

/**
 * Get the current runtime safety state and last evaluation.
 * Safe to call from any context (runtime, execution policy, API, UI).
 */
export function getRuntimeSafetyState(): {
  state: RuntimeSafetyState;
  blockingReasons: string[];
  warnings: string[];
  evaluatedAt: string;
  lastEvaluation: RuntimeSafetyResult | null;
} {
  if (lastEvaluation) {
    return {
      state: currentSafetyState,
      blockingReasons: lastEvaluation.blockingReasons,
      warnings: lastEvaluation.warnings,
      evaluatedAt: lastEvaluation.evaluatedAt,
      lastEvaluation,
    };
  }
  return {
    state: currentSafetyState,
    blockingReasons: [],
    warnings: [],
    evaluatedAt: new Date().toISOString(),
    lastEvaluation: null,
  };
}

/**
 * Check if trading should be blocked based on runtime safety state.
 */
export function isTradingBlockedByRuntimeSafety(): boolean {
  return currentSafetyState === "blocked" || currentSafetyState === "kill_switch";
}
