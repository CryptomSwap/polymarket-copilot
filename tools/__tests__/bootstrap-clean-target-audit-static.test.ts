/**
 * Static checks: clean-target audit tool documents experimental semantics (no DB).
 */

import * as fs from "fs";
import * as path from "path";

function check(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function run(): void {
  const p = path.resolve(__dirname, "../create-bootstrap-clean-target-audit.ts");
  const src = fs.readFileSync(p, "utf8");
  check(src.includes("markout12h > 0"), "experimental positive = markout12h > 0");
  check(src.includes("allowed") && src.includes("submitted"), "trade path allows allowed/submitted");
  check(src.includes("blockedIndicator === false"), "excludes blocked indicator");
  check(src.includes("computeActiveFeatureIndices"), "mirrors constant-feature drop");
  check(src.includes("balancedClassWeights"), "mirrors balanced training");
  check(src.includes("buildConclusion"), "emits conclusion section");
  console.log("--- bootstrap-clean-target-audit static checks passed ---");
}

run();
