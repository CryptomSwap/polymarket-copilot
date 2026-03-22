/**
 * Follow-up bootstrap flow safety tests (static assertions).
 * Keeps checks deterministic without DB dependency.
 */

import * as fs from "fs";
import * as path from "path";

function check(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function run(): void {
  const repoRoot = path.resolve(__dirname, "../../..");
  const selfImprovePath = path.join(repoRoot, "lib/ops/self-improvement-loop.ts");
  const jobsPath = path.join(repoRoot, "lib/ops/scheduled-jobs.ts");
  const selfImprove = fs.readFileSync(selfImprovePath, "utf8");
  const jobs = fs.readFileSync(jobsPath, "utf8");

  console.log("\n--- 1) Cold-start bootstrap target list excludes generic targets ---");
  {
    const chooserStart = selfImprove.indexOf("async function chooseBootstrapTarget");
    const chooserEnd = selfImprove.indexOf("async function parseRunMetrics");
    check(chooserStart >= 0 && chooserEnd > chooserStart, "chooseBootstrapTarget block found");
    const chooserBlock = selfImprove.slice(chooserStart, chooserEnd);
    check(chooserBlock.includes("labelGoodDecision12h"), "12h bootstrap target present");
    check(chooserBlock.includes("labelGoodDecision6h"), "6h bootstrap target present");
    check(!chooserBlock.includes("labelMissedOpportunity"), "missed-opportunity fallback removed from chooser");
    check(!chooserBlock.includes("labelGoodDecision\","), "generic good-decision fallback removed from chooser");
  }

  console.log("\n--- 2) Retrain flow no longer auto-approves ---");
  {
    const retrainStart = selfImprove.indexOf("export async function runShadowRetrainJob");
    const retrainEnd = selfImprove.indexOf("export async function runShadowBootstrapActivationJob");
    check(retrainStart >= 0 && retrainEnd > retrainStart, "runShadowRetrainJob block found");
    const retrainBlock = selfImprove.slice(retrainStart, retrainEnd);
    check(!retrainBlock.includes("status: \"APPROVED\""), "retrain block does not mutate status to APPROVED");
    check(!retrainBlock.includes("updateMany({"), "retrain block has no status updateMany mutation");
    check(retrainBlock.includes("bootstrapActivationDelegated: true"), "retrain emits delegated-activation audit marker");
  }

  console.log("\n--- 3) Dedicated bootstrap activation path exists and is scheduled ---");
  {
    check(selfImprove.includes("export async function runShadowBootstrapActivationJob"), "dedicated activation function exists");
    check(selfImprove.includes("status: \"approved\""), "activation function emits approved report payload");
    check(selfImprove.includes("scope: \"paper_only\""), "activation payload explicitly paper_only");
    check(jobs.includes("\"ml_shadow_bootstrap_activate\""), "scheduled job name includes bootstrap activation job");
    check(jobs.includes("runShadowBootstrapActivationJob"), "scheduled job executes dedicated activation function");
  }

  console.log("\n--- 4) Fail-closed cold-start skip when no short-horizon target eligible ---");
  {
    check(
      selfImprove.includes("reason: \"no_eligible_short_horizon_bootstrap_target\""),
      "retrain emits explicit fail-closed skip reason"
    );
    check(
      selfImprove.includes("failClosed: true"),
      "fail-closed marker is reported when skipping due to no eligible short-horizon target"
    );
  }

  console.log("\nAll bootstrap follow-up tests passed.");
}

run();

