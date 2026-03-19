/**
 * Runtime safety state machine: types for deterministic operational mode.
 * Central state controls whether trading is allowed, degraded, blocked, or halted.
 */

export type RuntimeSafetyState = "normal" | "degraded" | "blocked" | "kill_switch";

/** Input to the runtime safety evaluator. Missing critical signals => fail closed. */
export interface RuntimeSafetyInput {
  /** Global kill switch active (manual or watchdog). */
  killSwitchActive?: boolean;
  /** Reconciliation drift detected (e.g. last run had drift or failed). */
  reconciliationDrift?: boolean;
  /** Max age (ms) for reconciliation to be considered fresh. */
  reconciliationThresholdMs?: number;
  /** Last successful reconciliation at (ms since epoch or Date). */
  reconciliationLastOkAt?: number | Date | null;
  /** Market feed: age in ms since last data event (or pass lastEventAt for evaluator to compute age). */
  marketFeedFreshnessMs?: number | Date | null;
  /** User feed: age in ms since last data event (or pass lastEventAt for evaluator to compute age). */
  userFeedFreshnessMs?: number | Date | null;
  /** Market feed: max staleness (ms) before degraded. */
  marketFeedMaxStalenessMs?: number;
  /** User feed: max staleness (ms) before degraded. */
  userFeedMaxStalenessMs?: number;
  /** Market feed: max staleness (ms) before blocked (extreme). */
  marketFeedBlockStalenessMs?: number;
  /** User feed: max staleness (ms) before blocked (extreme). */
  userFeedBlockStalenessMs?: number;
  /** Current runtime phase: starting | rebuilding | reconciling | ready | degraded | stopped. */
  runtimePhase?: string;
  /** Exchange truth (orders/fills) available and recent. */
  exchangeTruthAvailable?: boolean;
  /** Worker/process health: repeated errors or unhealthy. */
  workerHealth?: "ok" | "degraded" | "unhealthy";
  /** Count of repeated runtime errors (e.g. reconcile failures). */
  repeatedRuntimeErrors?: number;
  /** Threshold: above this => degraded or blocked. */
  repeatedRuntimeErrorsThreshold?: number;
  /** Unapplied fill replay backlog count. */
  fillReplayBacklog?: number;
  /** Threshold: above this => degraded. */
  fillReplayBacklogThreshold?: number;
  /** Dev only: force state (e.g. "normal" for testing). */
  manualOverride?: RuntimeSafetyState | null;
}

/** Result of runtime safety evaluation. Auditable, explicit reasons. */
export interface RuntimeSafetyResult {
  state: RuntimeSafetyState;
  blockingReasons: string[];
  warnings: string[];
  evaluatedAt: string;
  /** Safe to persist or expose (no secrets). */
  snapshotJson: string;
}
