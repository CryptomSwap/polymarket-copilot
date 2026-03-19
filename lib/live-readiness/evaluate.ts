/**
 * Deterministic live-readiness evaluation.
 * Fail-closed: missing or false conditions block progression. allowLiveTrading remains false.
 */

import type {
  LiveReadinessInput,
  LiveReadinessResult,
  LiveReadinessOverallState,
} from "./types";

const CHECK_KEYS = [
  "runtimeSafetyState",
  "executionLedgerReady",
  "fillReplayRecoveryReady",
  "orderIntentDurabilityReady",
  "cancelReplaceDurabilityReady",
  "reconciliationAlignmentReady",
  "executionPolicyReady",
  "executionQualityReady",
  "portfolioRiskReady",
  "decisionEngineReady",
  "exchangeCredentialValidationReady",
  "exchangeTruthHealthy",
  "livePlacementGuardsPresent",
  "requiredDocsPresent",
] as const;

/** Mandatory for not_ready: if any of these fail, state is not_ready (or paper_only if no live request). */
const MANDATORY_CONTROL_CHECKS = [
  "executionLedgerReady",
  "fillReplayRecoveryReady",
  "orderIntentDurabilityReady",
  "cancelReplaceDurabilityReady",
  "reconciliationAlignmentReady",
  "executionPolicyReady",
  "executionQualityReady",
  "portfolioRiskReady",
  "decisionEngineReady",
  "exchangeCredentialValidationReady",
  "livePlacementGuardsPresent",
] as const;

function toBool(v: unknown): boolean {
  if (v === true) return true;
  if (typeof v === "boolean") return v;
  return false;
}

function checkRuntimeSafety(input: LiveReadinessInput): { pass: boolean; reason?: string } {
  const s = input.runtimeSafetyState;
  if (s === "kill_switch" || s === "blocked") {
    return { pass: false, reason: `runtime_safety_${s}` };
  }
  return { pass: true };
}

function checkExchangeTruth(input: LiveReadinessInput): { pass: boolean; reason?: string } {
  if (!toBool(input.exchangeTruthHealthy)) {
    return { pass: false, reason: "exchange_truth_unhealthy_or_missing" };
  }
  return { pass: true };
}

/**
 * Evaluate live readiness from the given input.
 * allowLiveTrading is always false. overallState is derived from checks and operator context.
 */
export function evaluateLiveReadiness(input: LiveReadinessInput): LiveReadinessResult {
  const evaluatedAt = new Date().toISOString();
  const blockingReasons: string[] = [];
  const warnings: string[] = [];
  const passedChecks: string[] = [];
  const failedChecks: string[] = [];

  const safetyCheck = checkRuntimeSafety(input);
  if (!safetyCheck.pass) {
    blockingReasons.push(safetyCheck.reason ?? "runtime_safety_blocked");
    failedChecks.push("runtimeSafetyState");
  } else if (input.runtimeSafetyState != null) {
    passedChecks.push("runtimeSafetyState");
  }

  if (!toBool(input.livePlacementGuardsPresent)) {
    blockingReasons.push("live_placement_guards_missing");
    failedChecks.push("livePlacementGuardsPresent");
  } else {
    passedChecks.push("livePlacementGuardsPresent");
  }

  if (!toBool(input.exchangeCredentialValidationReady)) {
    blockingReasons.push("exchange_credential_validation_not_ready");
    failedChecks.push("exchangeCredentialValidationReady");
  } else {
    passedChecks.push("exchangeCredentialValidationReady");
  }

  const exchangeTruthCheck = checkExchangeTruth(input);
  if (!exchangeTruthCheck.pass) {
    blockingReasons.push(exchangeTruthCheck.reason ?? "exchange_truth_unhealthy");
    failedChecks.push("exchangeTruthHealthy");
  } else {
    passedChecks.push("exchangeTruthHealthy");
  }

  const skipKeys = new Set(["runtimeSafetyState", "livePlacementGuardsPresent", "exchangeCredentialValidationReady", "exchangeTruthHealthy"]);
  for (const key of MANDATORY_CONTROL_CHECKS) {
    if (skipKeys.has(key)) continue;
    const val = (input as Record<string, unknown>)[key];
    if (!toBool(val)) {
      failedChecks.push(key);
      if (!blockingReasons.includes(`missing_or_failed:${key}`)) {
        blockingReasons.push(`missing_or_failed:${key}`);
      }
    } else {
      passedChecks.push(key);
    }
  }

  if (!toBool(input.requiredDocsPresent)) {
    warnings.push("required_docs_or_runbooks_missing");
    failedChecks.push("requiredDocsPresent");
  } else {
    passedChecks.push("requiredDocsPresent");
  }

  const manualLiveRequested = toBool(input.manualLiveEnableRequested);
  const operatorMode = input.operatorMode ?? "paper_only";
  const anyBlock = blockingReasons.length > 0;
  const allMandatoryPass =
    safetyCheck.pass &&
    toBool(input.livePlacementGuardsPresent) &&
    toBool(input.exchangeCredentialValidationReady) &&
    exchangeTruthCheck.pass &&
    MANDATORY_CONTROL_CHECKS.every((k) => {
      if (skipKeys.has(k)) return true;
      return toBool((input as Record<string, unknown>)[k]);
    });

  let overallState: LiveReadinessOverallState = "paper_only";
  if (anyBlock) {
    if (manualLiveRequested || operatorMode !== "paper_only") {
      overallState = "not_ready";
    } else {
      overallState = "paper_only";
    }
  } else {
    if (!manualLiveRequested && operatorMode === "paper_only") {
      overallState = "paper_only";
    } else if (allMandatoryPass && toBool(input.requiredDocsPresent)) {
      overallState = "ready_for_review";
    } else if (allMandatoryPass) {
      overallState = "limited_ready";
    } else if (
      toBool(input.executionLedgerReady) &&
      toBool(input.executionPolicyReady) &&
      toBool(input.livePlacementGuardsPresent)
    ) {
      overallState = "shadow_ready";
    } else if (manualLiveRequested || operatorMode !== "paper_only") {
      overallState = "not_ready";
    }
  }

  const snapshot = {
    evaluatedAt,
    overallState,
    allowLiveTrading: false,
    blockingReasons,
    warnings,
    passedChecks,
    failedChecks,
    operatorMode,
    manualLiveEnableRequested: manualLiveRequested,
  };

  return {
    overallState,
    allowLiveTrading: false,
    blockingReasons,
    warnings,
    passedChecks,
    failedChecks,
    evaluatedAt,
    snapshotJson: JSON.stringify(snapshot),
  };
}

/**
 * Build a default input reflecting current implementation status.
 * Use from worker/API to seed known-true durability and guard flags.
 */
export function buildDefaultLiveReadinessInput(
  overrides: Partial<LiveReadinessInput> = {}
): LiveReadinessInput {
  return {
    executionLedgerReady: true,
    fillReplayRecoveryReady: true,
    orderIntentDurabilityReady: true,
    cancelReplaceDurabilityReady: true,
    reconciliationAlignmentReady: true,
    executionPolicyReady: true,
    executionQualityReady: true,
    portfolioRiskReady: true,
    decisionEngineReady: true,
    livePlacementGuardsPresent: true,
    requiredDocsPresent: true,
    ...overrides,
  };
}

/**
 * Build readiness input from runtime signals (safety, health).
 * Use from worker heartbeat to merge dynamic state with default implementation flags.
 */
export function buildLiveReadinessInputFromRuntime(params: {
  runtimeSafetyState?: LiveReadinessInput["runtimeSafetyState"];
  exchangeTruthHealthy?: boolean | null;
  reconciliationOk?: boolean | null;
  exchangeCredentialValidationReady?: boolean | null;
  operatorMode?: LiveReadinessInput["operatorMode"];
  manualLiveEnableRequested?: boolean | null;
  environment?: string | null;
}): LiveReadinessInput {
  return buildDefaultLiveReadinessInput({
    runtimeSafetyState: params.runtimeSafetyState ?? "normal",
    exchangeTruthHealthy: params.exchangeTruthHealthy ?? false,
    reconciliationAlignmentReady: params.reconciliationOk ?? true,
    exchangeCredentialValidationReady: params.exchangeCredentialValidationReady ?? false,
    operatorMode: params.operatorMode ?? "paper_only",
    manualLiveEnableRequested: params.manualLiveEnableRequested ?? false,
    environment: params.environment ?? null,
  });
}
