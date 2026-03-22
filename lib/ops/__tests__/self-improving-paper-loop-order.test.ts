/**
 * Static wiring tests: self-improving paper loop ordering, fail-closed gates (no DB).
 */

import * as fs from "fs";
import * as path from "path";

function check(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function run(): void {
  const repoRoot = path.resolve(__dirname, "../../..");
  const jobsPath = path.join(repoRoot, "lib/ops/scheduled-jobs.ts");
  const loopPath = path.join(repoRoot, "lib/ops/self-improvement-loop.ts");
  const enginePath = path.join(repoRoot, "lib/paper-trading/engine.ts");
  const jobs = fs.readFileSync(jobsPath, "utf8");
  const loop = fs.readFileSync(loopPath, "utf8");
  const engine = fs.readFileSync(enginePath, "utf8");

  console.log("\n--- 1) ml_shadow_retrain: dataset → path backfill → retrain ---");
  {
    const caseStart = jobs.indexOf('case "ml_shadow_retrain"');
    check(caseStart >= 0, "ml_shadow_retrain case exists");
    const caseEnd = jobs.indexOf("case \"self_improving_paper_loop\"", caseStart);
    check(caseEnd > caseStart, "self_improving_paper_loop follows ml_shadow_retrain");
    const block = jobs.slice(caseStart, caseEnd);
    const iRefresh = block.indexOf("runShadowDatasetRefreshJob");
    const iBackfill = block.indexOf("runShadowPathFeatureBackfillJob");
    const iRetrain = block.indexOf("runShadowRetrainJob");
    check(iRefresh >= 0 && iBackfill > iRefresh && iRetrain > iBackfill, "order: refresh < backfill < retrain");
  }

  console.log("\n--- 2) Orchestrated loop job registered ---");
  {
    check(jobs.includes('"self_improving_paper_loop"'), "JOB_NAMES includes self_improving_paper_loop");
    check(jobs.includes("runSelfImprovingPaperLoopJob"), "case invokes runSelfImprovingPaperLoopJob");
    check(loop.includes("path_feature_backfill"), "loop includes path_feature_backfill stage");
    const ord = loop.indexOf("runShadowPathFeatureBackfillJob");
    const rtrain = loop.indexOf("runShadowRetrainJob", ord);
    check(ord >= 0 && rtrain > ord, "loop orders path backfill before retrain");
  }

  console.log("\n--- 3) Standalone path backfill job ---");
  {
    check(jobs.includes('"ml_shadow_path_feature_backfill"'), "JOB_NAMES includes ml_shadow_path_feature_backfill");
    check(jobs.includes("runShadowPathFeatureBackfillJob"), "scheduled case calls runShadowPathFeatureBackfillJob");
  }

  console.log("\n--- 4) Promotion preview + no write on skip (read-only path exists) ---");
  {
    check(loop.includes("export async function computeShadowPromotionPreview"), "computeShadowPromotionPreview exported");
    check(loop.includes("export async function computeBootstrapActivationPreview"), "computeBootstrapActivationPreview exported");
    const promoteStart = loop.indexOf("export async function runShadowEvaluateAndPromoteJob");
    const promoteBlock = loop.slice(promoteStart, promoteStart + 800);
    check(promoteBlock.includes("computeShadowPromotionPreview()"), "promote job uses preview");
  }

  console.log("\n--- 5) Paper tick fail-closed without ACTIVE/APPROVED model ---");
  {
    const fnStart = engine.indexOf("export async function runPaperTradingTick");
    check(fnStart >= 0, "runPaperTradingTick exists");
    const fnSnippet = engine.slice(fnStart, fnStart + 3200);
    check(fnSnippet.includes("await getActiveOrApprovedShadowModel()"), "tick awaits shadow model gate");
    const iModel = fnSnippet.indexOf("await getActiveOrApprovedShadowModel()");
    const iCand = fnSnippet.indexOf("getSubmittedShadowCandidatesForTickWithDiagnostics");
    check(iModel >= 0 && (iCand < 0 || iCand > iModel), "model gate before candidate load in tick body");
    check(fnSnippet.includes("No ACTIVE or APPROVED shadow model"), "early return message when no model");
  }

  console.log("\n--- 6) Status report output paths ---");
  {
    const statusPath = path.join(repoRoot, "lib/ops/self-improving-loop-status.ts");
    const status = fs.readFileSync(statusPath, "utf8");
    check(status.includes("self-improving-loop-status.json"), "status module writes json path");
    check(status.includes("self-improving-loop-status.md"), "status module writes md path");
  }

  console.log("\n--- 7) No promotion DB writes when preview skips or gates fail ---");
  {
    const promoteStart = loop.indexOf("export async function runShadowEvaluateAndPromoteJob");
    check(promoteStart >= 0, "runShadowEvaluateAndPromoteJob found");
    const promoteEnd = loop.indexOf("\nfunction clamp", promoteStart);
    check(promoteEnd > promoteStart, "promote block bounded");
    const promoteBlock = loop.slice(promoteStart, promoteEnd);
    check(promoteBlock.includes('preview.status === "skipped"'), "skipped preview short-circuits");
    check(promoteBlock.includes("if (preview.wouldPromote)"), "transaction guarded by wouldPromote");
    check(
      promoteBlock.indexOf("if (preview.wouldPromote)") < promoteBlock.indexOf("$transaction"),
      "wouldPromote check precedes transaction"
    );
  }

  console.log("\nAll self-improving paper loop order tests passed.");
}

run();
