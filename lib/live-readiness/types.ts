/**
 * Live-readiness and rollout gate types.
 * Defines the exact conditions required before any live mode could be enabled.
 * Fail-closed: missing or false conditions block progression.
 */

/** Runtime safety state from runtime-safety state machine. */
export type RuntimeSafetyStateForReadiness = "normal" | "degraded" | "blocked" | "kill_switch";

/** Operator / rollout mode context. */
export type OperatorModeForReadiness = "paper_only" | "shadow" | "limited_review" | "review_requested";

/**
 * Input to the live-readiness evaluator.
 * All conditions are optional; missing or false is treated as not satisfied (fail-closed).
 */
export interface LiveReadinessInput {
  /** Current runtime safety state. blocked/kill_switch → not_ready. */
  runtimeSafetyState?: RuntimeSafetyStateForReadiness | null;
  /** Execution ledger is implemented and used for order intent/executed order persistence. */
  executionLedgerReady?: boolean | null;
  /** Fill replay and startup recovery are implemented and durable. */
  fillReplayRecoveryReady?: boolean | null;
  /** Order intent lifecycle is durably persisted (creation, policy, events). */
  orderIntentDurabilityReady?: boolean | null;
  /** Cancel/replace requests and lifecycle are durably persisted. */
  cancelReplaceDurabilityReady?: boolean | null;
  /** Reconciliation updates and aligns with durable ledger state. */
  reconciliationAlignmentReady?: boolean | null;
  /** Execution policy gate is in place and blocks unsafe orders. */
  executionPolicyReady?: boolean | null;
  /** Execution quality (spread, depth, slippage) guardrails are in place. */
  executionQualityReady?: boolean | null;
  /** Portfolio risk engine is integrated and used. */
  portfolioRiskReady?: boolean | null;
  /** Staged decision engine is the active path (no legacy blend). */
  decisionEngineReady?: boolean | null;
  /** Exchange credential validation is available and used. */
  exchangeCredentialValidationReady?: boolean | null;
  /** Exchange truth (orders/fills) is healthy and recent. */
  exchangeTruthHealthy?: boolean | null;
  /** Current operator/rollout mode (paper_only by default). */
  operatorMode?: OperatorModeForReadiness | null;
  /** Live placement guards (e.g. assertNoLiveOrderPlacement, adapter mode check) are present. */
  livePlacementGuardsPresent?: boolean | null;
  /** Required docs/runbooks exist (checklist, rollout gates). */
  requiredDocsPresent?: boolean | null;
  /** Explicit manual request to evaluate for live review (does not enable live). */
  manualLiveEnableRequested?: boolean | null;
  /** Environment: development | staging | production. */
  environment?: string | null;
  /** Optional: runtime phase (e.g. ready, degraded). */
  runtimePhase?: string | null;
}

export type LiveReadinessOverallState =
  | "paper_only"   // Default when no live request; paper-only operation.
  | "not_ready"    // Live requested or reviewed, but mandatory controls missing.
  | "shadow_ready" // Architecture sufficient for shadow/live-simulation validation only.
  | "limited_ready" // All core control-plane gates pass; still requires explicit human review.
  | "ready_for_review"; // All technical gates pass; still does NOT auto-enable live trading.

export interface LiveReadinessResult {
  overallState: LiveReadinessOverallState;
  /** Must remain false in this implementation. No path enables live trading. */
  allowLiveTrading: boolean;
  blockingReasons: string[];
  warnings: string[];
  passedChecks: string[];
  failedChecks: string[];
  evaluatedAt: string;
  snapshotJson: string;
}
