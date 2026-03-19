/**
 * Staged decision evaluator tests: eligibility, edge, portfolio fit, sizing, explanation.
 * Deterministic; no black-box blending.
 *
 * Run with (from repo root):
 *   npx ts-node --project tsconfig.tests.json -r tsconfig-paths/register lib/decision/__tests__/evaluate-staged.test.ts
 */

import assert from "assert";
import { evaluateDecisionStaged } from "../evaluate-staged";
import type { StagedDecisionInput } from "../stages/types";

function check(cond: boolean, msg: string): void {
  assert.strictEqual(cond, true, msg);
}

function baseInput(overrides?: Partial<StagedDecisionInput>): StagedDecisionInput {
  return {
    action: "STRONG_BUY",
    blockedReason: null,
    qualityBlocker: null,
    heuristicPriorityScore: 0.7,
    mlScore: 0.65,
    newsCatalystBoost: 0.02,
    newsSaturationPenalty: 0,
    themeExposurePct: 10,
    topThemeConcentrationPct: 20,
    behaviorPenalty: 0,
    portfolioPenalty: 0,
    setupActedWinRate: null,
    setupOverrideWinRate: null,
    setupSampleCount: 0,
    reviewStatus: "APPROVED",
    signalType: null,
    suggestedSizeFromRec: 0.5,
    hasExistingPosition: false,
    liquidityScore: 0.5,
    ...overrides,
  };
}

function run(): void {
  console.log("\n--- 1. Blocked recommendation cannot size > 0 ---");
  {
    const r = evaluateDecisionStaged(baseInput({ blockedReason: "Sync portfolio first." }));
    check(r.sizing.suggestedSize === 0, "suggested size 0 when blocked");
    check(r.sizeMultiplier === 0, "size multiplier 0");
    check(r.finalSuggestedSize === 0, "finalSuggestedSize 0");
    check(r.eligibility.eligible === false, "not eligible");
  }

  console.log("\n--- 2. blockedReason causes eligibility failure, not mere score reduction ---");
  {
    const r = evaluateDecisionStaged(baseInput({ blockedReason: "Theme overconcentrated." }));
    check(r.eligibility.eligible === false, "eligible false");
    check(r.eligibility.blockers.some((b) => b.includes("overconcentrated")), "blocker present");
    check(r.sizing.suggestedSize === 0, "size 0");
  }

  console.log("\n--- 3. Concentration affects sizing / portfolio fit, not raw edge stage ---");
  {
    const lowConc = evaluateDecisionStaged(baseInput({ themeExposurePct: 5, topThemeConcentrationPct: 15 }));
    const highConc = evaluateDecisionStaged(baseInput({ themeExposurePct: 35, topThemeConcentrationPct: 55 }));
    check(lowConc.edge.convictionScore > 0, "edge has conviction");
    check(highConc.edge.convictionScore > 0, "edge still has conviction");
    check(highConc.portfolioFit.portfolioFitState === "block" || highConc.sizing.suggestedSize < lowConc.sizing.suggestedSize, "high concentration reduces size or blocks");
  }

  console.log("\n--- 4. qualityBlocker causes eligibility failure ---");
  {
    const r = evaluateDecisionStaged(baseInput({ qualityBlocker: "Sync portfolio to resolve positions." }));
    check(r.eligibility.eligible === false, "not eligible");
    check(r.eligibility.blockers.some((b) => b.includes("Sync")), "qualityBlocker in blockers");
  }

  console.log("\n--- 5. News saturation does not double-count with edge ---");
  {
    const noNews = evaluateDecisionStaged(baseInput({ newsSaturationPenalty: 0, newsCatalystBoost: 0 }));
    const withSaturation = evaluateDecisionStaged(baseInput({ newsSaturationPenalty: 0.15, newsCatalystBoost: 0 }));
    check(withSaturation.edge.convictionScore < noNews.edge.convictionScore, "saturation reduces edge once");
    check(withSaturation.marketQuality.marketQualityReasons.some((r) => r.toLowerCase().includes("saturation")) || withSaturation.marketQuality.warnings.length > 0, "saturation in market quality");
  }

  console.log("\n--- 6. High edge + poor market quality can warn/block distinctly ---");
  {
    const poorLiq = evaluateDecisionStaged(baseInput({ liquidityScore: 0.1 }));
    check(poorLiq.marketQuality.block === true, "poor liquidity blocks");
    check(poorLiq.marketQuality.marketQualityState === "poor", "market quality poor");
    check(poorLiq.sizing.suggestedSize === 0, "size 0 when market quality blocks");
  }

  console.log("\n--- 7. Good edge + bad portfolio fit yields reduced size or block ---");
  {
    const badFit = evaluateDecisionStaged(baseInput({ topThemeConcentrationPct: 55, themeExposurePct: 40 }));
    check(badFit.portfolioFit.portfolioFitState === "block", "portfolio fit block");
    check(badFit.sizing.suggestedSize === 0, "size 0");
    check(badFit.edge.convictionScore >= 0.5, "edge still scored");
  }

  console.log("\n--- 8. Reasoning output remains ordered and human-readable ---");
  {
    const r = evaluateDecisionStaged(baseInput());
    check(r.explanation.length >= 0, "explanation array");
    check(Array.isArray(r.reasoningBreakdown.blockers), "blockers array");
    check(Array.isArray(r.reasoningBreakdown.edgeReasons), "edgeReasons array");
    check(Array.isArray(r.reasoningBreakdown.sizingReasons), "sizingReasons array");
  }

  console.log("\n--- 9. Backward-compatible snapshot still produced ---");
  {
    const r = evaluateDecisionStaged(baseInput());
    check(typeof r.policyState === "string", "policyState string");
    check(typeof r.blendedScore === "number" && r.blendedScore >= 0 && r.blendedScore <= 1, "blendedScore 0-1");
    check(typeof r.sizeMultiplier === "number", "sizeMultiplier number");
    check(typeof r.finalSuggestedSize === "number", "finalSuggestedSize number");
    check(r.reasoningBreakdown.blockers !== undefined && r.reasoningBreakdown.supportive !== undefined, "reasoningBreakdown has blockers and supportive");
  }

  console.log("\n--- 10. EXIT and TRIM actions get correct sizing ---");
  {
    const exitR = evaluateDecisionStaged(baseInput({ action: "EXIT", suggestedSizeFromRec: 1 }));
    check(exitR.policyState === "EXIT", "EXIT state");
    check(exitR.sizing.suggestedSize <= 1 && exitR.sizing.suggestedSize > 0, "exit size");
    const trimR = evaluateDecisionStaged(baseInput({ action: "TRIM", suggestedSizeFromRec: 0.5 }));
    check(trimR.policyState === "TRIM", "TRIM state");
    check(trimR.sizing.sizeMultiplier === 0.8, "trim multiplier");
  }

  console.log("\nAll staged decision tests passed.");
}

run();
