/**
 * Decision-stage calibration tests: subtype grouping, recommendation logic, reduced-size cohort, threshold exposure.
 */

import {
  decisionSubtypeFromBlockReason,
  subtypesFromDecisionSnapshot,
  subtypesFromDecisionSnapshotJson,
  hasDecisionStageBlock,
  buildRecommendation,
} from "../index";
import type { DecisionStageSubtypeStats, DecisionStageSubtype } from "../types";
import { getDecisionStageThresholds } from "@/lib/decision-config";

function check(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function emptyStats(subtype: DecisionStageSubtype): DecisionStageSubtypeStats {
  return {
    subtype,
    blockedCount: 0,
    reducedCount: 0,
    allowedCount: 0,
    evaluatedBlocked: 0,
    evaluatedReduced: 0,
    evaluatedAllowed: 0,
    goodBlockCount: 0,
    badBlockCount: 0,
    goodAllowCount: 0,
    badAllowCount: 0,
    goodReducedCount: 0,
    badReducedCount: 0,
    averageMarkout24hBlocked: null,
    averageMarkout24hAllowed: null,
    averageMarkout24hReduced: null,
    rawSamples: [],
  };
}

function run(): void {
  console.log("\n--- 1. Subtype grouping from block reasons and staged output ---");
  {
    check(
      decisionSubtypeFromBlockReason("recommendation:Review required.") === "eligibility_block",
      "recommendation -> eligibility_block"
    );
    check(
      decisionSubtypeFromBlockReason("Theme concentration 55% exceeds limit.") === "poor_portfolio_fit",
      "theme concentration -> poor_portfolio_fit"
    );
    check(decisionSubtypeFromBlockReason("exposure_total_breach") === null, "exposure not decision");
  }

  console.log("\n--- 2. subtypesFromDecisionSnapshot ---");
  {
    const subs = subtypesFromDecisionSnapshot({
      blockers: ["Sync portfolio first."],
      policyState: "BLOCK",
      sizeMultiplier: 0,
    });
    check(subs.includes("eligibility_block"), "blockers -> eligibility_block");
    check(subs.includes("size_zero"), "sizeMultiplier 0 -> size_zero");

    const subs2 = subtypesFromDecisionSnapshot({
      blendedScore: 0.7,
      marketQualityReasons: ["Liquidity too low."],
      sizeMultiplier: 0.6,
    });
    check(subs2.includes("high_conviction_edge"), "blendedScore 0.7 -> high_conviction_edge");
    check(subs2.includes("poor_market_quality"), "liquidity too low -> poor_market_quality");
    check(subs2.includes("size_reduced"), "sizeMultiplier 0.6 -> size_reduced");

    const subs3 = subtypesFromDecisionSnapshot({
      sizingReasons: ["Trim: reduced size."],
    });
    check(subs3.includes("exit_trim_logic"), "trim -> exit_trim_logic");
  }

  console.log("\n--- 3. subtypesFromDecisionSnapshotJson / hasDecisionStageBlock ---");
  {
    const json = JSON.stringify({
      blockers: ["Review rejected."],
      policyState: "BLOCK",
    });
    const subs = subtypesFromDecisionSnapshotJson(json);
    check(subs.includes("eligibility_block"), "json parse eligibility_block");
    check(hasDecisionStageBlock(["recommendation:Theme concentration exceeds limit."]) === true, "has decision block");
    check(hasDecisionStageBlock(["quote_stale"]) === false, "no decision block for quote_stale");
  }

  console.log("\n--- 4. review_loosen for high bad_block rate ---");
  {
    const stats = emptyStats("eligibility_block");
    stats.blockedCount = 10;
    stats.evaluatedBlocked = 10;
    stats.goodBlockCount = 3;
    stats.badBlockCount = 7;
    const row = buildRecommendation("eligibility_block", stats, 5);
    check(row.recommendation === "review_loosen", "high bad_block -> review_loosen");
  }

  console.log("\n--- 5. keep_strict for high good_block rate ---");
  {
    const stats = emptyStats("poor_market_quality");
    stats.blockedCount = 10;
    stats.evaluatedBlocked = 10;
    stats.goodBlockCount = 8;
    stats.badBlockCount = 2;
    const row = buildRecommendation("poor_market_quality", stats, 5);
    check(row.recommendation === "keep_strict", "high good_block -> keep_strict");
  }

  console.log("\n--- 6. review_tighten for high bad_allow rate ---");
  {
    const stats = emptyStats("size_reduced");
    stats.allowedCount = 20;
    stats.evaluatedAllowed = 10;
    stats.goodAllowCount = 3;
    stats.badAllowCount = 7;
    const row = buildRecommendation("size_reduced", stats, 5);
    check(row.recommendation === "review_tighten", "high bad_allow -> review_tighten");
  }

  console.log("\n--- 7. Reduced-size cohort: high badReducedCount -> review_tighten ---");
  {
    const stats = emptyStats("portfolio_fit_penalty");
    stats.reducedCount = 15;
    stats.evaluatedReduced = 10;
    stats.goodReducedCount = 4;
    stats.badReducedCount = 6;
    const row = buildRecommendation("portfolio_fit_penalty", stats, 5);
    check(row.recommendation === "review_tighten", "high bad reduced -> review_tighten");
    check(
      row.summary.includes("Reduced-size") || row.summary.includes("bad"),
      "summary mentions reduced or bad"
    );
  }

  console.log("\n--- 8. insufficient_data on small sample ---");
  {
    const stats = emptyStats("low_conviction_edge");
    stats.blockedCount = 3;
    stats.evaluatedBlocked = 3;
    const row = buildRecommendation("low_conviction_edge", stats, 5);
    check(row.recommendation === "insufficient_data", "below minEvaluated -> insufficient_data");
  }

  console.log("\n--- 9. Current threshold config (getDecisionStageThresholds) ---");
  {
    const t = getDecisionStageThresholds();
    check(typeof t.edgeHighConvictionThreshold === "number", "edgeHighConvictionThreshold number");
    check(t.edgeHighConvictionThreshold === 0.65, "default edge high 0.65");
    check(t.marketQualityBlockLiquidityThreshold === 0.15, "default liquidity block 0.15");
    check(t.concentrationBlockPct === 50, "default concentrationBlockPct 50");
  }

  console.log("\nAll decision-calibration tests passed.");
}

run();
