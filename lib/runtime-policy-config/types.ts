/**
 * Runtime policy / freshness threshold types.
 * Centralized for calibration and audit; callers may still use their own config until wired.
 */

export interface RuntimePolicyThresholds {
  /** Market data: warn when older than this (ms). */
  marketDataFreshnessWarnMs: number;
  /** Market data: block when older than this (ms). */
  marketDataFreshnessBlockMs: number;
  /** User feed: warn when older than this (ms). */
  userFeedFreshnessWarnMs: number;
  /** User feed: block when older than this (ms). */
  userFeedFreshnessBlockMs: number;
  /** Portfolio/position truth: warn when older than this (ms). */
  portfolioTruthFreshnessWarnMs: number;
  /** Portfolio/position truth: block when older than this (ms). */
  portfolioTruthFreshnessBlockMs: number;
  /** Reconciliation: warn when last run older than this (ms). */
  reconciliationFreshnessWarnMs: number;
  /** Reconciliation: block when last run older than this (ms). */
  reconciliationFreshnessBlockMs: number;
  /** Decision snapshot: max age (ms) before considered stale. */
  decisionSnapshotMaxAgeMs: number;
  /** Runtime errors: warn above this count (optional). */
  runtimeErrorWarnCount: number;
  /** Runtime errors: block above this count (optional). */
  runtimeErrorBlockCount: number;
  /** Fill replay backlog: warn above this (optional). */
  fillReplayBacklogWarn: number;
  /** Fill replay backlog: block above this (optional). */
  fillReplayBacklogBlock: number;
  /** When true, exchange truth unavailable blocks. */
  exchangeTruthUnavailableBlocks: boolean;
  /** Block when runtime phase is starting. */
  runtimePhaseBlockOnStartup: boolean;
  /** Block when runtime phase is rebuilding. */
  runtimePhaseBlockOnRebuilding: boolean;
  /** Block when runtime phase is reconciling. */
  runtimePhaseBlockOnReconciling: boolean;
}
