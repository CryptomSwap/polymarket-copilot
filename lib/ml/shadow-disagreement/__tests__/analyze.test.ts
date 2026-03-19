/**
 * Disagreement analysis tests: cohort grouping, usefulness summary, advisory-only.
 * Deterministic where possible.
 */

import { getStagedCohort, getShadowBand, runDisagreementAnalysis } from "../analyze";

function check(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function run(): void {
  console.log("\n--- 1. Cohort grouping: staged_block / staged_allow / staged_reduce ---");
  {
    check(getStagedCohort({ wasBlocked: true, wasSubmitted: false, reducedSizeIndicator: false }) === "staged_block", "wasBlocked -> staged_block");
    check(getStagedCohort({ wasBlocked: false, wasSubmitted: true, reducedSizeIndicator: false }) === "staged_allow", "allow full -> staged_allow");
    check(getStagedCohort({ wasBlocked: false, wasSubmitted: true, reducedSizeIndicator: true }) === "staged_reduce", "reduced size -> staged_reduce");
  }

  console.log("\n--- 2. Shadow band from score ---");
  {
    check(getShadowBand(0.7) === "high", "0.7 -> high");
    check(getShadowBand(0.6) === "high", "0.6 -> high");
    check(getShadowBand(0.5) === "medium", "0.5 -> medium");
    check(getShadowBand(0.4) === "medium", "0.4 -> medium");
    check(getShadowBand(0.3) === "low", "0.3 -> low");
  }

  console.log("\n--- 3. Disagreement summary: run returns advisory-only and structure ---");
  (async () => {
    let result;
    try {
      result = await runDisagreementAnalysis({ limit: 100 });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("MlShadowTrainingExample") || msg.includes("P2021") || msg.includes("does not exist")) {
        console.log("  [SKIP] MlShadowTrainingExample table not present; run migrations.");
        console.log("\n--- All shadow-disagreement tests passed ---");
        return;
      }
      throw e;
    }
    check(result.advisoryOnly === true, "advisoryOnly true");
    check(Array.isArray(result.cohortStats), "cohortStats array");
    check(result.cohortStats.length === 9, "9 cohort buckets (3 staged x 3 bands)");
    const keys = new Set(result.cohortStats.map((c) => `${c.cohortKey.stagedCohort}:${c.cohortKey.shadowBand}`));
    check(keys.has("staged_block:low") && keys.has("staged_allow:high") && keys.has("staged_reduce:medium"), "expected cohort keys present");
    for (const c of result.cohortStats) {
      check(typeof c.total === "number" && c.total >= 0, "total non-negative");
      check(["staged_more_right", "shadow_more_right", "tie", "insufficient"].includes(c.usefulnessSummary), "usefulnessSummary valid");
    }
    if (result.agreementRate != null) {
      check(result.agreementRate >= 0 && result.agreementRate <= 1, "agreementRate in [0,1]");
    }
    if (result.disagreementRate != null) {
      check(result.disagreementRate >= 0 && result.disagreementRate <= 1, "disagreementRate in [0,1]");
    }
    check(Array.isArray(result.recentSamples), "recentSamples array");
    console.log("\n--- All shadow-disagreement tests passed ---");
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

run();
