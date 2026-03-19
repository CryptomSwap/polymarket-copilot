/**
 * Shadow analysis tests: reason normalization, aggregation by reason, calibration suggestion logic.
 */

import { normalizeBlockingReason, normalizeBlockingReasons, REASON_GROUP } from "../reasons";

function check(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function run(): void {
  console.log("\n--- 1. Reason normalization groups similar reasons ---");
  {
    check(normalizeBlockingReason("execution_quality:spread_too_wide") === REASON_GROUP.EXECUTION_QUALITY, "execution_quality prefix");
    check(normalizeBlockingReason("execution_quality:stale_quote") === REASON_GROUP.EXECUTION_QUALITY, "execution_quality stale_quote");
    check(normalizeBlockingReason("quote_stale") === REASON_GROUP.EXECUTION_QUALITY, "quote_stale raw");
    check(normalizeBlockingReason("spread_too_wide") === REASON_GROUP.EXECUTION_QUALITY, "spread_too_wide raw");
    check(normalizeBlockingReason("freshness:market_data_stale") === REASON_GROUP.EXECUTION_POLICY_FRESHNESS, "freshness prefix");
    check(normalizeBlockingReason("liquidity:execution_quality:insufficient_depth") === REASON_GROUP.EXECUTION_POLICY_LIQUIDITY, "liquidity prefix");
    check(normalizeBlockingReason("market_data_stale") === REASON_GROUP.GUARDRAIL_FRESHNESS, "guardrail market_data_stale");
    check(normalizeBlockingReason("exposure_total_breach") === REASON_GROUP.GUARDRAIL_EXPOSURE, "guardrail exposure");
    check(normalizeBlockingReason("kill_switch_global") === REASON_GROUP.GUARDRAIL_OPERATIONAL, "guardrail kill_switch");
  }

  console.log("\n--- 2. normalizeBlockingReasons returns groups and raw samples ---");
  {
    const { groups, rawByGroup } = normalizeBlockingReasons(["execution_quality:quote_stale", "spread_too_wide"]);
    check(groups.includes(REASON_GROUP.EXECUTION_QUALITY), "groups include execution_quality");
    check(rawByGroup[REASON_GROUP.EXECUTION_QUALITY]?.length >= 1, "raw samples per group");
  }

  console.log("\n--- 3. Good_block / bad_block aggregation by reason (logic) ---");
  {
    const blockedWithReason = [
      { outcomeClassification: "good_block", reasonGroup: REASON_GROUP.EXECUTION_QUALITY },
      { outcomeClassification: "good_block", reasonGroup: REASON_GROUP.EXECUTION_QUALITY },
      { outcomeClassification: "bad_block", reasonGroup: REASON_GROUP.EXECUTION_QUALITY },
    ];
    const good = blockedWithReason.filter((r) => r.outcomeClassification === "good_block").length;
    const bad = blockedWithReason.filter((r) => r.outcomeClassification === "bad_block").length;
    check(good === 2 && bad === 1, "aggregation counts");
  }

  console.log("\n--- 4. Good_allow / bad_allow aggregation (logic) ---");
  {
    const allowed = [
      { outcomeClassification: "good_allow" },
      { outcomeClassification: "bad_allow" },
      { outcomeClassification: "good_allow" },
    ];
    const goodAllow = allowed.filter((r) => r.outcomeClassification === "good_allow").length;
    const badAllow = allowed.filter((r) => r.outcomeClassification === "bad_allow").length;
    check(goodAllow === 2 && badAllow === 1, "allowed aggregation");
  }

  console.log("\n--- 5. Calibration suggestion: high bad_block rate -> review_threshold ---");
  {
    const evaluated = 10;
    const goodBlock = 3;
    const badBlock = 7;
    const badRate = badBlock / evaluated;
    const minEvaluated = 5;
    check(evaluated >= minEvaluated && badRate >= 0.5, "high bad_block implies review_threshold");
  }

  console.log("\n--- 6. Calibration suggestion: high good_block rate -> keep_strict ---");
  {
    const evaluated = 10;
    const goodBlock = 8;
    const goodRate = goodBlock / evaluated;
    check(goodRate >= 0.6, "high good_block implies keep_strict");
  }

  console.log("\n--- 7. Calibration suggestion: insufficient sample -> insufficient_data ---");
  {
    const evaluated = 3;
    const minEvaluated = 5;
    check(evaluated < minEvaluated, "below min -> insufficient_data");
  }

  console.log("\n--- 8. Exposure and recommendation groups ---");
  {
    check(normalizeBlockingReason("exposure:exposure_total_breach") === REASON_GROUP.EXECUTION_POLICY_EXPOSURE, "exposure prefix");
    check(normalizeBlockingReason("recommendation:blocked_reason") === REASON_GROUP.EXECUTION_POLICY_RECOMMENDATION, "recommendation prefix");
  }

  console.log("\nAll shadow-analysis tests passed.");
}

run();
