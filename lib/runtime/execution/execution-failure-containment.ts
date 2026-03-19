/**
 * Execution rollback / failure containment. When submit/cancel/replace fails mid-flight,
 * the system fails closed: marks ambiguity explicitly, freezes affected asset, and
 * prevents unsafe continued automation. Ambiguity is visible in health and diagnostics.
 */

/** Failure/ambiguity reason codes for health and guardrails. */
export const EXECUTION_FAILURE_REASON_CODES = {
  SUBMIT_AMBIGUOUS: "submit_ambiguous",
  CANCEL_AMBIGUOUS: "cancel_ambiguous",
  REPLACE_AMBIGUOUS: "replace_ambiguous",
  EXECUTION_VERIFICATION_REQUIRED: "execution_verification_required",
  ASSET_EXECUTION_FROZEN: "asset_execution_frozen",
  EXCHANGE_ACK_TIMEOUT: "exchange_ack_timeout",
} as const;

export type ExecutionFailureReasonCode =
  (typeof EXECUTION_FAILURE_REASON_CODES)[keyof typeof EXECUTION_FAILURE_REASON_CODES];

/** Execution failure state for an order (outcome unknown). */
export type ExecutionFailureState =
  | "submit_requested"
  | "submit_ambiguous"
  | "cancel_requested"
  | "cancel_ambiguous"
  | "replace_ambiguous"
  | "exchange_ack_timeout"
  | "execution_verification_required";

/** Failure-containment policy: which assets are frozen, counters, and whether to force cancel_only/frozen. */
export interface FailureContainmentState {
  /** Asset IDs for which new automated entries are blocked due to execution ambiguity. */
  frozenAssetIds: Set<string>;
  /** Total submit ambiguous count (since start or last reset). */
  submitAmbiguousCount: number;
  /** Total cancel ambiguous count. */
  cancelAmbiguousCount: number;
  /** Total replace ambiguous count (cancel-replace interrupted after cancel, before replace). */
  replaceAmbiguousCount: number;
  /** Orders requiring verification (e.g. may have reached exchange but no local ack). */
  executionVerificationRequiredCount: number;
  /** Last time an ambiguity was recorded (for degradation). */
  lastAmbiguityAt: Date | null;
}

/** Threshold: number of ambiguities in window that triggers runtime degradation. */
export const DEFAULT_AMBIGUITY_DEGRADE_THRESHOLD = 3;

/** Window ms: ambiguities within this window count toward degrade. */
export const DEFAULT_AMBIGUITY_WINDOW_MS = 300_000; // 5 min

/** Threshold: number of frozen assets that can force cancel_only or frozen mode. */
export const DEFAULT_FROZEN_ASSETS_FORCE_MODE_THRESHOLD = 2;

export interface FailureContainmentPolicyConfig {
  ambiguityDegradeThreshold?: number;
  ambiguityWindowMs?: number;
  frozenAssetsForceModeThreshold?: number;
}

/**
 * In-memory failure containment state. Tracks frozen assets and ambiguity counters.
 * Call recordSubmitAmbiguous / recordCancelAmbiguous / recordReplaceAmbiguous /
 * recordExecutionVerificationRequired when adapter or manager detects ambiguous outcome.
 */
export class FailureContainmentStateManager {
  private frozenAssetIds = new Set<string>();
  private submitAmbiguousCount = 0;
  private cancelAmbiguousCount = 0;
  private replaceAmbiguousCount = 0;
  private executionVerificationRequiredCount = 0;
  private lastAmbiguityAt: Date | null = null;
  private ambiguityTimestamps: Date[] = [];
  private readonly config: Required<FailureContainmentPolicyConfig>;

  constructor(config: FailureContainmentPolicyConfig = {}) {
    this.config = {
      ambiguityDegradeThreshold: config.ambiguityDegradeThreshold ?? DEFAULT_AMBIGUITY_DEGRADE_THRESHOLD,
      ambiguityWindowMs: config.ambiguityWindowMs ?? DEFAULT_AMBIGUITY_WINDOW_MS,
      frozenAssetsForceModeThreshold:
        config.frozenAssetsForceModeThreshold ?? DEFAULT_FROZEN_ASSETS_FORCE_MODE_THRESHOLD,
    };
  }

  /** Record submit ambiguous (timeout/unknown); freezes asset and increments counter. */
  recordSubmitAmbiguous(assetId: string): void {
    this.frozenAssetIds.add(assetId);
    this.submitAmbiguousCount += 1;
    this.executionVerificationRequiredCount += 1;
    this.pushAmbiguityTimestamp();
  }

  /** Record cancel ambiguous (cancel sent but no confirmation); freezes asset. */
  recordCancelAmbiguous(assetId: string): void {
    this.frozenAssetIds.add(assetId);
    this.cancelAmbiguousCount += 1;
    this.executionVerificationRequiredCount += 1;
    this.pushAmbiguityTimestamp();
  }

  /** Record replace ambiguous (cancel-replace interrupted after cancel, before replace). */
  recordReplaceAmbiguous(assetId: string): void {
    this.frozenAssetIds.add(assetId);
    this.replaceAmbiguousCount += 1;
    this.executionVerificationRequiredCount += 1;
    this.pushAmbiguityTimestamp();
  }

  /** Record that an order requires verification (e.g. submit may have reached exchange, no local ack). */
  recordExecutionVerificationRequired(_assetId?: string): void {
    this.executionVerificationRequiredCount += 1;
    this.pushAmbiguityTimestamp();
  }

  private pushAmbiguityTimestamp(): void {
    const now = new Date();
    this.lastAmbiguityAt = now;
    this.ambiguityTimestamps.push(now);
    const cutoff = now.getTime() - this.config.ambiguityWindowMs;
    this.ambiguityTimestamps = this.ambiguityTimestamps.filter((t) => t.getTime() > cutoff);
  }

  /** Whether new automated entries are blocked for this asset. */
  isAssetExecutionFrozen(assetId: string): boolean {
    return this.frozenAssetIds.has(assetId);
  }

  /** Clear frozen state for an asset (e.g. after verification or manual resolution). */
  clearAssetFrozen(assetId: string): void {
    this.frozenAssetIds.delete(assetId);
  }

  /** All currently frozen asset IDs (read-only). */
  getFrozenAssetIds(): ReadonlySet<string> {
    return this.frozenAssetIds;
  }

  /** Whether repeated ambiguities in the window should degrade the runtime. */
  shouldDegradeRuntime(): boolean {
    return this.ambiguityTimestamps.length >= this.config.ambiguityDegradeThreshold;
  }

  /** Whether frozen asset count should force cancel_only or frozen mode. */
  shouldForceCancelOnlyOrFrozen(): boolean {
    return this.frozenAssetIds.size >= this.config.frozenAssetsForceModeThreshold;
  }

  /** Snapshot for health/diagnostics. */
  getState(): FailureContainmentState {
    return {
      frozenAssetIds: new Set(this.frozenAssetIds),
      submitAmbiguousCount: this.submitAmbiguousCount,
      cancelAmbiguousCount: this.cancelAmbiguousCount,
      replaceAmbiguousCount: this.replaceAmbiguousCount,
      executionVerificationRequiredCount: this.executionVerificationRequiredCount,
      lastAmbiguityAt: this.lastAmbiguityAt,
    };
  }

  /** Count of ambiguities in the current window (for degradation). */
  getAmbiguityCountInWindow(): number {
    return this.ambiguityTimestamps.length;
  }

  reset(): void {
    this.frozenAssetIds.clear();
    this.submitAmbiguousCount = 0;
    this.cancelAmbiguousCount = 0;
    this.replaceAmbiguousCount = 0;
    this.executionVerificationRequiredCount = 0;
    this.lastAmbiguityAt = null;
    this.ambiguityTimestamps = [];
  }
}
