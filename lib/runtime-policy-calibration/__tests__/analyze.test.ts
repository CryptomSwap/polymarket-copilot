/**
 * Runtime-policy calibration tests: subtype grouping, recommendation logic, threshold exposure.
 */

import {
  runtimePolicySubtypeFromRaw,
  subtypesFromBlockingReasons,
  hasRuntimePolicyBlock,
  buildRecommendation,
} from "../index";
import type { RuntimePolicySubtypeStats, RuntimePolicySubtype } from "../types";
import { getRuntimePolicyThresholds } from "@/lib/runtime-policy-config";

function check(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function emptyStats(subtype: RuntimePolicySubtype): RuntimePolicySubtypeStats {
  return {
    subtype,
    blockedCount: 0,
    evaluatedBlocked: 0,
    goodBlockCount: 0,
    badBlockCount: 0,
    allowedCount: 0,
    evaluatedAllowed: 0,
    goodAllowCount: 0,
    badAllowCount: 0,
    averageMarkout24hBlocked: null,
    averageMarkout24hAllowed: null,
    rawSamples: [],
  };
}

function run(): void {
  console.log("\n--- 1. Subtype grouping from blocking reasons / warnings ---");
  {
    check(
      runtimePolicySubtypeFromRaw("market_data_stale") === "stale_market_data",
      "market_data_stale -> stale_market_data"
    );
    check(
      runtimePolicySubtypeFromRaw("freshness:market_data_stale") === "stale_market_data",
      "freshness:market_data_stale"
    );
    check(
      runtimePolicySubtypeFromRaw("user_data_stale") === "stale_user_feed",
      "user_data_stale -> stale_user_feed"
    );
    check(
      runtimePolicySubtypeFromRaw("reconciliation_stale") === "stale_reconciliation",
      "reconciliation_stale"
    );
    check(
      runtimePolicySubtypeFromRaw("decision_snapshot_stale") === "stale_decision_snapshot",
      "decision_snapshot_stale"
    );
    check(
      runtimePolicySubtypeFromRaw("runtime_rebuilding") === "runtime_phase_block",
      "runtime_rebuilding -> runtime_phase_block"
    );
    check(
      runtimePolicySubtypeFromRaw("runtime_not_ready") === "runtime_phase_block",
      "runtime_not_ready"
    );
    check(
      runtimePolicySubtypeFromRaw("exchange_truth_unavailable") === "exchange_truth_unavailable",
      "exchange_truth_unavailable"
    );
    check(
      runtimePolicySubtypeFromRaw("kill_switch_global") === "runtime_safety_kill_switch",
      "kill_switch_global"
    );
    check(runtimePolicySubtypeFromRaw("quote_stale") === null, "execution-quality not policy");
  }

  console.log("\n--- 2. subtypesFromBlockingReasons ---");
  {
    const subs = subtypesFromBlockingReasons([
      "freshness:market_data_stale",
      "reconciliation_stale",
    ]);
    check(subs.includes("stale_market_data"), "stale_market_data in list");
    check(subs.includes("stale_reconciliation"), "stale_reconciliation in list");
  }

  console.log("\n--- 3. hasRuntimePolicyBlock ---");
  {
    check(hasRuntimePolicyBlock(["market_data_stale"]) === true, "market_data_stale true");
    check(hasRuntimePolicyBlock(["runtime_reconciling"]) === true, "runtime_reconciling true");
    check(hasRuntimePolicyBlock(["exposure_total_breach"]) === false, "exposure false");
    check(hasRuntimePolicyBlock([]) === false, "empty false");
  }

  console.log("\n--- 4. review_loosen for high bad_block rate ---");
  {
    const stats = emptyStats("stale_market_data");
    stats.blockedCount = 10;
    stats.evaluatedBlocked = 10;
    stats.goodBlockCount = 3;
    stats.badBlockCount = 7;
    const row = buildRecommendation("stale_market_data", stats, 5);
    check(row.recommendation === "review_loosen", "high bad_block -> review_loosen");
    check(row.summary.includes("bad_block"), "summary mentions bad_block");
  }

  console.log("\n--- 5. keep_strict for high good_block rate ---");
  {
    const stats = emptyStats("stale_reconciliation");
    stats.blockedCount = 10;
    stats.evaluatedBlocked = 10;
    stats.goodBlockCount = 8;
    stats.badBlockCount = 2;
    const row = buildRecommendation("stale_reconciliation", stats, 5);
    check(row.recommendation === "keep_strict", "high good_block -> keep_strict");
    check(row.summary.includes("good_block"), "summary mentions good_block");
  }

  console.log("\n--- 6. review_tighten for high bad_allow rate in allowed cohort ---");
  {
    const stats = emptyStats("stale_decision_snapshot");
    stats.allowedCount = 20;
    stats.evaluatedAllowed = 10;
    stats.goodAllowCount = 3;
    stats.badAllowCount = 7;
    const row = buildRecommendation("stale_decision_snapshot", stats, 5);
    check(row.recommendation === "review_tighten", "high bad_allow -> review_tighten");
    check(
      row.summary.includes("bad_allows") || row.summary.includes("tighten"),
      "summary mentions tighten/bad_allows"
    );
  }

  console.log("\n--- 7. insufficient_data on small sample ---");
  {
    const stats = emptyStats("runtime_phase_block");
    stats.blockedCount = 3;
    stats.evaluatedBlocked = 3;
    stats.goodBlockCount = 1;
    stats.badBlockCount = 2;
    const row = buildRecommendation("runtime_phase_block", stats, 5);
    check(row.recommendation === "insufficient_data", "below minEvaluated -> insufficient_data");
  }

  console.log("\n--- 8. Current threshold config (getRuntimePolicyThresholds) ---");
  {
    const t = getRuntimePolicyThresholds();
    check(typeof t.marketDataFreshnessWarnMs === "number", "marketDataFreshnessWarnMs number");
    check(typeof t.decisionSnapshotMaxAgeMs === "number", "decisionSnapshotMaxAgeMs number");
    check(t.decisionSnapshotMaxAgeMs === 300_000, "default decisionSnapshotMaxAgeMs 300000");
    check(t.reconciliationFreshnessBlockMs === 120_000, "default reconciliationFreshnessBlockMs 120000");
    check(t.exchangeTruthUnavailableBlocks === true, "exchangeTruthUnavailableBlocks true");
    check(t.runtimePhaseBlockOnRebuilding === true, "runtimePhaseBlockOnRebuilding true");
  }

  console.log("\nAll runtime-policy-calibration tests passed.");
}

run();
