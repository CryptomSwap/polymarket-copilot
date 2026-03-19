/**
 * Default runtime policy / freshness thresholds.
 * Values aligned with current execution-policy, stream-watchdog, and stream-runtime usage.
 * Do not change runtime behavior; this is the central default for calibration and future wiring.
 */

import type { RuntimePolicyThresholds } from "./types";

export const defaultRuntimePolicyThresholds: RuntimePolicyThresholds = {
  marketDataFreshnessWarnMs: 30_000,
  marketDataFreshnessBlockMs: 60_000,
  userFeedFreshnessWarnMs: 60_000,
  userFeedFreshnessBlockMs: 90_000,
  portfolioTruthFreshnessWarnMs: 60_000,
  portfolioTruthFreshnessBlockMs: 120_000,
  reconciliationFreshnessWarnMs: 60_000,
  reconciliationFreshnessBlockMs: 120_000,
  decisionSnapshotMaxAgeMs: 300_000,
  runtimeErrorWarnCount: 5,
  runtimeErrorBlockCount: 20,
  fillReplayBacklogWarn: 10,
  fillReplayBacklogBlock: 50,
  exchangeTruthUnavailableBlocks: true,
  runtimePhaseBlockOnStartup: true,
  runtimePhaseBlockOnRebuilding: true,
  runtimePhaseBlockOnReconciling: true,
};

let currentThresholds: RuntimePolicyThresholds = { ...defaultRuntimePolicyThresholds };

export function getRuntimePolicyThresholds(): RuntimePolicyThresholds {
  return { ...currentThresholds };
}

export function setRuntimePolicyThresholds(thresholds: Partial<RuntimePolicyThresholds>): void {
  currentThresholds = { ...currentThresholds, ...thresholds };
}
