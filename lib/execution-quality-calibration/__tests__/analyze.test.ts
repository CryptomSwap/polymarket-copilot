/**
 * Execution-quality calibration tests: subtype grouping, recommendation logic, threshold exposure.
 */

import {
  executionQualitySubtypeFromRaw,
  subtypesFromBlockingReasons,
  subtypesFromWarnings,
  hasExecutionQualityBlock,
  snapshotHasEqWarnings,
  buildRecommendation,
} from "../index";
import type { EqSubtypeStats, ExecutionQualitySubtype } from "../types";
import { getExecutionQualityThresholds } from "@/lib/execution-quality/config";

function check(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function emptyStats(subtype: ExecutionQualitySubtype): EqSubtypeStats {
  return {
    subtype,
    blockedCount: 0,
    evaluatedBlocked: 0,
    goodBlockCount: 0,
    badBlockCount: 0,
    allowedWithWarningCount: 0,
    evaluatedAllowedWithWarning: 0,
    goodAllowCount: 0,
    badAllowCount: 0,
    averageMarkout24hBlocked: null,
    averageMarkout24hAllowedWithWarning: null,
    rawSamples: [],
  };
}

function run(): void {
  console.log("\n--- 1. Subtype grouping from raw reasons ---");
  {
    check(executionQualitySubtypeFromRaw("quote_stale") === "stale_quote", "quote_stale -> stale_quote");
    check(executionQualitySubtypeFromRaw("execution_quality:quote_stale") === "stale_quote", "execution_quality:quote_stale");
    check(executionQualitySubtypeFromRaw("spread_too_wide") === "spread_too_wide", "spread_too_wide");
    check(executionQualitySubtypeFromRaw("wide_spread") === "spread_too_wide", "wide_spread");
    check(executionQualitySubtypeFromRaw("insufficient_depth") === "insufficient_depth", "insufficient_depth");
    check(executionQualitySubtypeFromRaw("estimated_slippage_high") === "slippage_too_high", "slippage");
    check(executionQualitySubtypeFromRaw("not_tradable") === "not_tradable", "not_tradable");
    check(executionQualitySubtypeFromRaw("liquidity_below_threshold") === "low_liquidity_score", "liquidity");
    check(executionQualitySubtypeFromRaw("intended_price_far_from_market") === "price_too_far_from_market", "price_far");
    check(executionQualitySubtypeFromRaw("unknown_reason") === null, "unknown returns null");
  }

  console.log("\n--- 2. subtypesFromBlockingReasons ---");
  {
    const subs = subtypesFromBlockingReasons(["execution_quality:quote_stale", "wide_spread"]);
    check(subs.includes("stale_quote"), "stale_quote in list");
    check(subs.includes("spread_too_wide"), "spread_too_wide in list");
  }

  console.log("\n--- 3. hasExecutionQualityBlock ---");
  {
    check(hasExecutionQualityBlock(["execution_quality:quote_stale"]) === true, "eq reason true");
    check(hasExecutionQualityBlock(["quote_stale"]) === true, "raw quote_stale true");
    check(hasExecutionQualityBlock(["kill_switch_global"]) === false, "non-eq false");
    check(hasExecutionQualityBlock([]) === false, "empty false");
  }

  console.log("\n--- 4. snapshotHasEqWarnings ---");
  {
    check(snapshotHasEqWarnings(JSON.stringify({ warnings: ["wide_spread"] })) === true, "has warnings true");
    check(snapshotHasEqWarnings(JSON.stringify({ warnings: [] })) === false, "empty warnings false");
    check(snapshotHasEqWarnings(null) === false, "null false");
    check(snapshotHasEqWarnings("{}") === false, "no warnings key false");
  }

  console.log("\n--- 5. review_loosen for high bad_block rate ---");
  {
    const stats = emptyStats("stale_quote");
    stats.blockedCount = 10;
    stats.evaluatedBlocked = 10;
    stats.goodBlockCount = 3;
    stats.badBlockCount = 7;
    const row = buildRecommendation("stale_quote", stats, 5);
    check(row.recommendation === "review_loosen", "high bad_block -> review_loosen");
    check(row.summary.includes("bad_block"), "summary mentions bad_block");
  }

  console.log("\n--- 6. keep_strict for high good_block rate ---");
  {
    const stats = emptyStats("spread_too_wide");
    stats.blockedCount = 10;
    stats.evaluatedBlocked = 10;
    stats.goodBlockCount = 8;
    stats.badBlockCount = 2;
    const row = buildRecommendation("spread_too_wide", stats, 5);
    check(row.recommendation === "keep_strict", "high good_block -> keep_strict");
    check(row.summary.includes("good_block"), "summary mentions good_block");
  }

  console.log("\n--- 7. review_tighten for warn-heavy bad allows ---");
  {
    const stats = emptyStats("insufficient_depth");
    stats.allowedWithWarningCount = 20;
    stats.evaluatedAllowedWithWarning = 10;
    stats.goodAllowCount = 3;
    stats.badAllowCount = 7;
    const row = buildRecommendation("insufficient_depth", stats, 5);
    check(row.recommendation === "review_tighten", "high bad_allow in warn cohort -> review_tighten");
    check(row.summary.includes("bad_allows") || row.summary.includes("tighten"), "summary mentions tighten/bad_allows");
  }

  console.log("\n--- 8. insufficient_data when sample too small ---");
  {
    const stats = emptyStats("slippage_too_high");
    stats.blockedCount = 3;
    stats.evaluatedBlocked = 3;
    stats.goodBlockCount = 1;
    stats.badBlockCount = 2;
    const row = buildRecommendation("slippage_too_high", stats, 5);
    check(row.recommendation === "insufficient_data", "below minEvaluated -> insufficient_data");
  }

  console.log("\n--- 9. monitor when no strong signal ---");
  {
    const stats = emptyStats("not_tradable");
    stats.blockedCount = 10;
    stats.evaluatedBlocked = 10;
    stats.goodBlockCount = 5;
    stats.badBlockCount = 4;
    const row = buildRecommendation("not_tradable", stats, 5);
    check(row.recommendation === "monitor", "mixed rates below loosen/keep_strict -> monitor");
  }

  console.log("\n--- 10. Current threshold config (via getExecutionQualityThresholds) ---");
  {
    const t = getExecutionQualityThresholds();
    check(typeof t.staleQuoteBlockMs === "number", "staleQuoteBlockMs number");
    check(typeof t.spreadBlockBps === "number", "spreadBlockBps number");
    check(typeof t.slippageWarnBps === "number", "slippageWarnBps number");
    check(t.staleQuoteBlockMs === 60_000, "default staleQuoteBlockMs 60000");
    check(t.spreadWarnBps === 400, "default spreadWarnBps 400");
  }

  console.log("\nAll execution-quality-calibration tests passed.");
}

run();
