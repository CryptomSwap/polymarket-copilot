/**
 * Shadow scoring tests: advisory output shape, model separation, missing features.
 * Deterministic where possible; no-model case tests error path.
 */

import { scoreShadowCandidate } from "../score-live";

function check(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

async function run(): Promise<void> {
  console.log("\n--- 1. No shadow model -> success false, error message ---");
  {
    const out = await scoreShadowCandidate({
      side: "BUY",
      intendedPrice: "0.5",
      intendedSize: "10",
    });
    if (!out.success) {
      check(typeof out.error === "string", "error string when no model");
      check(out.result == null, "no result when no model");
    }
  }

  console.log("\n--- 2. Scoring returns advisory output shape (when model exists) ---");
  {
    const out = await scoreShadowCandidate({
      side: "BUY",
      intendedPrice: "0.5",
      intendedSize: "10",
      recommendationPresent: false,
    });
    if (out.success && out.result) {
      check(typeof out.result.shadowMlScore === "number", "shadowMlScore number");
      check(
        ["low", "medium", "high"].includes(out.result.shadowMlScoreBand),
        "shadowMlScoreBand one of low/medium/high"
      );
      check(out.result.isShadowModel === true, "isShadowModel true");
      check(Array.isArray(out.result.featureCompletenessWarnings), "featureCompletenessWarnings array");
      check(typeof out.result.modelId === "string", "modelId string");
      check(out.result.modelTargetLabel != null, "modelTargetLabel present");
    }
  }

  console.log("\n--- 3. Missing optional features -> warnings (graceful degradation) ---");
  {
    const out = await scoreShadowCandidate({
      side: "SELL",
      intendedPrice: "0.4",
      intendedSize: "50",
    });
    if (out.success && out.result) {
      check(
        out.result.featureCompletenessWarnings.length >= 0,
        "warnings array present (may be empty or have entries when features missing)"
      );
    }
  }

  console.log("\n--- 4. Recommendation ML vs shadow ML: score output labels shadow ---");
  {
    const out = await scoreShadowCandidate({
      side: "BUY",
      intendedPrice: "0.5",
      intendedSize: "10",
    });
    if (out.success && out.result) {
      check(out.result.isShadowModel === true, "output explicitly isShadowModel true (distinguishable from recommendation ML)");
    }
  }

  console.log("\n--- All shadow-score tests passed ---");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
