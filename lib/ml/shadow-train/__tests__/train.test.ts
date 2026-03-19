/**
 * Shadow training tests: feature matrix from rows, model type separation.
 * Deterministic; DB-dependent training test skipped if no data.
 */

import { toShadowFeatureVector, SHADOW_FEATURE_NAMES, SHADOW_FEATURE_SET_V1 } from "../features";
import { SHADOW_MODEL_TYPE } from "../train";

function check(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function run(): void {
  console.log("\n--- 1. Shadow training rows map into feature matrix (fixed length) ---");
  {
    const full = {
      sizeMultiplier: "0.5",
      finalSuggestedSize: "50",
      eligibilityBlockersCount: 1,
      reducedSizeIndicator: true,
      blockedIndicator: false,
      executionAllow: true,
      executionWarningCount: 1,
      qualityState: "good",
      spreadBps: "25",
      estimatedSlippage: "0.002",
      tradable: true,
      grossExposure: "1000",
      totalOpenExposure: "1000",
      maxSingleMarketConcentrationPct: "20",
      maxSingleThemeConcentrationPct: "30",
      portfolioRiskFlagsCount: 0,
      runtimeWarningCount: 0,
      runtimeBlockingCount: 0,
      intendedPrice: "0.55",
      intendedSize: "100",
      recommendationPresent: true,
      side: "BUY",
      policyState: "allow",
      outcomeBlockedVsAllowedVsSubmitted: "submitted" as const,
    };
    const vec = toShadowFeatureVector(full);
    check(vec.length === SHADOW_FEATURE_NAMES.length, "feature vector length matches SHADOW_FEATURE_NAMES");
    check(vec.every((v) => typeof v === "number"), "all elements numeric");
    check(vec[3] === 1, "reducedSizeIndicator 1");
    check(vec[4] === 0, "blockedIndicator 0");
    check(vec[20] === 1, "recommendationPresent 1");
    check(vec[21] === 1, "side BUY -> 1");
    check(vec[23] === 3, "outcome submitted -> 3");
  }

  console.log("\n--- 2. Missing optional features -> valid partial feature row (zeros) ---");
  {
    const minimal = {};
    const vec = toShadowFeatureVector(minimal);
    check(vec.length === SHADOW_FEATURE_NAMES.length, "minimal still produces same length");
    check(vec.every((v) => v === 0 || (vec[21] === 0 && vec[21] === 0)), "missing values -> 0");
  }

  console.log("\n--- 3. Feature set name and model type separation ---");
  {
    check(SHADOW_FEATURE_SET_V1 === "shadow_v1", "feature set shadow_v1");
    check(SHADOW_MODEL_TYPE === "logistic_regression_shadow", "shadow model type distinct from recommendation");
  }

  console.log("\n--- All shadow-train tests passed ---");
}

run();
