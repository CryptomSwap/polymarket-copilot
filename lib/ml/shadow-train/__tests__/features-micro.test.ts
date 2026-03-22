/**
 * shadow_v1_micro: append-only contract vs shadow_v1.
 */

import {
  SHADOW_FEATURE_NAMES_V1_MICRO,
  SHADOW_MICRO_SUFFIX_NAMES,
  toShadowFeatureVectorV1Micro,
} from "../features-shadow-v1-micro";
import { SHADOW_FEATURE_NAMES, toShadowFeatureVector } from "../features";

function check(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

/** `NaN === NaN` is false; feature vector uses Number(x) ?? patterns that can yield NaN when fields are omitted. */
function sameNum(a: number, b: number): boolean {
  return a === b || (Number.isNaN(a) && Number.isNaN(b));
}

function run(): void {
  const row = {
    spreadBps: "10",
    intendedPrice: "0.5",
    eligibilityBlockersCount: 0,
    executionWarningCount: 0,
    portfolioRiskFlagsCount: 0,
    runtimeWarningCount: 0,
    runtimeBlockingCount: 0,
    reducedSizeIndicator: false,
    blockedIndicator: false,
    recommendationPresent: false,
    depthSufficiency: "sufficient",
    quoteFreshnessState: "fresh",
    workingOrderExposure: "100",
    worstCaseLossEstimate: "0.02",
  };
  const v1 = toShadowFeatureVector(row);
  const micro = toShadowFeatureVectorV1Micro(row);
  check(v1.length === SHADOW_FEATURE_NAMES.length, "v1 length");
  check(micro.length === SHADOW_FEATURE_NAMES_V1_MICRO.length, "micro length");
  check(micro.length === v1.length + SHADOW_MICRO_SUFFIX_NAMES.length, "append 4");
  check(
    micro.slice(0, v1.length).every((x, i) => sameNum(x, v1[i])),
    "prefix equals v1"
  );
  console.log("--- features-micro tests passed ---");
}

run();
