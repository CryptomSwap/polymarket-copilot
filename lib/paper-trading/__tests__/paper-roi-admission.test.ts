/**
 * Paper ROI admission helpers (unit tests).
 * Run: npx tsx lib/paper-trading/__tests__/paper-roi-admission.test.ts
 */

import assert from "assert";
import {
  applyPaperIntendedSizeMultiplier,
  computeEffectivePaperMinScore,
  DEFAULT_PAPER_SIZE_SCORE_TIERS,
  evaluatePaperLiquidityGuards,
  resolvePaperSizeBucket,
} from "../paper-roi-admission";
import {
  buildPaperTradeOpenAttribution,
  mergeOpenAttributionIntoMetadata,
  parseOpenAttributionFromMetadataJson,
} from "../paper-trade-open-attribution";
import type { ShadowScoreResult } from "@/lib/ml/shadow-score/types";
import type { ShadowScoreInput } from "@/lib/ml/shadow-score/types";
import * as fs from "fs";
import * as path from "path";

function check(cond: boolean, msg: string): void {
  assert.strictEqual(cond, true, msg);
}

function mockShadowResult(overrides: Partial<ShadowScoreResult> = {}): ShadowScoreResult {
  return {
    shadowMlScore: 0.92,
    shadowMlLogit: 2.2,
    shadowMlScoreCalibrated: 0.92,
    shadowMlScoreBand: "high",
    modelId: "run_test",
    modelFeatureSet: "shadow_v1",
    modelTargetLabel: "labelGoodDecision12h",
    isShadowModel: true,
    featureCompletenessWarnings: [],
    ...overrides,
  };
}

function baseInput(overrides: Partial<ShadowScoreInput> = {}): ShadowScoreInput {
  return {
    spreadBps: "100",
    estimatedSlippage: "0.002",
    blockedIndicator: false,
    qualityState: "good",
    policyState: "allow",
    executionAllow: true,
    tradable: true,
    ...overrides,
  };
}

function run(): void {
  console.log("\n--- computeEffectivePaperMinScore ---");
  const a = computeEffectivePaperMinScore({
    baseMinScore: 0.35,
    globalOverride: null,
    botOverride: null,
  });
  check(a.effectiveMinScore === 0.35, "no override");
  const b = computeEffectivePaperMinScore({
    baseMinScore: 0.35,
    globalOverride: 0.8,
    botOverride: null,
  });
  check(b.effectiveMinScore === 0.8, "global raises");
  const c = computeEffectivePaperMinScore({
    baseMinScore: 0.5,
    globalOverride: 0.3,
    botOverride: null,
  });
  check(c.effectiveMinScore === 0.5, "global cannot lower");
  const d = computeEffectivePaperMinScore({
    baseMinScore: 0.35,
    globalOverride: 0.5,
    botOverride: 0.85,
  });
  check(d.effectiveMinScore === 0.85, "bot max with global");

  console.log("\n--- resolvePaperSizeBucket ---");
  const s1 = resolvePaperSizeBucket(0.85, 0.8, DEFAULT_PAPER_SIZE_SCORE_TIERS);
  check(s1?.label === "small", "small tier");
  const s2 = resolvePaperSizeBucket(0.95, 0.8, DEFAULT_PAPER_SIZE_SCORE_TIERS);
  check(s2?.label === "medium", "medium tier");
  const s3 = resolvePaperSizeBucket(0.99, 0.8, DEFAULT_PAPER_SIZE_SCORE_TIERS);
  check(s3?.label === "large", "large tier");
  check(resolvePaperSizeBucket(0.79, 0.8, DEFAULT_PAPER_SIZE_SCORE_TIERS) == null, "below floor");

  console.log("\n--- evaluatePaperLiquidityGuards ---");
  check(evaluatePaperLiquidityGuards(50, 10, null, null).ok === true, "guards off");
  check(evaluatePaperLiquidityGuards(200, 10, 150, null).ok === false, "spread block");
  check(
    evaluatePaperLiquidityGuards(200, 10, 150, null).ok === false &&
      (evaluatePaperLiquidityGuards(200, 10, 150, null) as { ok: false }).reason === "spread",
    "spread reason"
  );
  check(evaluatePaperLiquidityGuards(10, 50, 100, 40).ok === false, "slippage block");
  check(evaluatePaperLiquidityGuards(null, 20, 100, 40).ok === true, "missing spread no spread block; slip under cap");

  console.log("\n--- applyPaperIntendedSizeMultiplier ---");
  check(applyPaperIntendedSizeMultiplier("10", 0.5) === "5", "scale size");

  console.log("\n--- openAttribution paperRoi roundtrip ---");
  const roi = {
    effectiveMinScoreUsed: 0.8,
    baseMinScoreBeforePaperOverride: 0.35,
    globalPaperMinScoreOverride: 0.8,
    botPaperMinScoreOverride: null,
    admittedUnderTightenedPaperThreshold: true,
    sizeByScoreEnabled: true,
    sizeScoreBucketLabel: "medium",
    paperSizeMultiplier: 1,
    spreadBpsAtAdmission: 12,
    estimatedSlippageBpsAtAdmission: 5,
    blockedBySpreadGuard: false as const,
    blockedBySlippageGuard: false as const,
  };
  const attr = buildPaperTradeOpenAttribution({
    shadowResult: mockShadowResult(),
    thresholdUsed: 0.3,
    minScoreUsed: 0.8,
    shadowInput: baseInput(),
    paperRoiAdmission: roi,
  });
  const json = JSON.stringify(mergeOpenAttributionIntoMetadata({ x: 1 }, attr));
  const parsed = parseOpenAttributionFromMetadataJson(json);
  check(parsed?.paperRoiAdmission?.effectiveMinScoreUsed === 0.8, "roi effective");
  check(parsed?.paperRoiAdmission?.sizeScoreBucketLabel === "medium", "bucket");

  console.log("\n--- live path must not import paper-roi-admission ---");
  const omPath = path.join(process.cwd(), "lib/runtime/order-manager/paper-order-manager.ts");
  const omSrc = fs.readFileSync(omPath, "utf8");
  check(!omSrc.includes("paper-roi-admission"), "order manager clean");

  console.log("\nAll paper-roi-admission tests passed.");
}

run();
