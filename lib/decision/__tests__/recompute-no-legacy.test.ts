/**
 * Regression: ensure the active decision recompute path does not depend on legacy blend or policy modules.
 * The staged decision engine (evaluate-staged.ts + stages/*) is the only decision path used by recompute.
 */

import * as fs from "fs";
import * as path from "path";

const RECOMPUTE_PATH = path.join(__dirname, "..", "recompute.ts");

function check(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

async function run(): Promise<void> {
  const src = fs.readFileSync(RECOMPUTE_PATH, "utf-8");

  check(!src.includes('from "./blend"') && !src.includes("from './blend'"), "recompute must not import blend");
  check(!src.includes('from "./policy"') && !src.includes("from './policy'"), "recompute must not import policy");
  check(!src.includes("computeBlendedScore"), "recompute must not reference computeBlendedScore");
  check(!src.includes("applyPolicy"), "recompute must not reference applyPolicy");
  check(src.includes("evaluateDecisionStaged"), "recompute must use evaluateDecisionStaged");
  check(src.includes("StagedDecisionInput"), "recompute must use staged types");

  console.log("OK: recompute uses only staged decision path; no legacy blend/policy dependency.");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
