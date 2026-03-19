/**
 * Live-readiness state store: current evaluation result.
 * Safe to read from APIs and worker heartbeat. Updated after each evaluateLiveReadiness.
 */

import type { LiveReadinessResult } from "./types";

let currentResult: LiveReadinessResult | null = null;

/**
 * Update the current live-readiness state. Call after each evaluateLiveReadiness.
 */
export function updateLiveReadinessState(result: LiveReadinessResult): void {
  currentResult = result;
}

/**
 * Get the current live-readiness state and last evaluation.
 * Safe to call from any context (worker heartbeat, API, UI).
 */
export function getLiveReadinessState(): {
  overallState: LiveReadinessResult["overallState"];
  allowLiveTrading: boolean;
  blockingReasons: string[];
  warnings: string[];
  passedChecks: string[];
  failedChecks: string[];
  evaluatedAt: string;
  lastResult: LiveReadinessResult | null;
} {
  if (currentResult) {
    return {
      overallState: currentResult.overallState,
      allowLiveTrading: currentResult.allowLiveTrading,
      blockingReasons: currentResult.blockingReasons,
      warnings: currentResult.warnings,
      passedChecks: currentResult.passedChecks,
      failedChecks: currentResult.failedChecks,
      evaluatedAt: currentResult.evaluatedAt,
      lastResult: currentResult,
    };
  }
  return {
    overallState: "paper_only",
    allowLiveTrading: false,
    blockingReasons: [],
    warnings: [],
    passedChecks: [],
    failedChecks: [],
    evaluatedAt: new Date().toISOString(),
    lastResult: null,
  };
}

/**
 * Assert that live trading is not permitted unless readiness passes.
 * For this implementation, live trading is never permitted; this is a documentation and guard point.
 * Call at any code path that could theoretically lead to live placement.
 */
export function assertLiveTradingNotPermittedUnlessReadinessPassed(): void {
  const state = getLiveReadinessState();
  if (state.allowLiveTrading) {
    throw new Error(
      "[live-readiness] Live trading is not permitted. allowLiveTrading must remain false until explicit rollout gate is implemented."
    );
  }
}
