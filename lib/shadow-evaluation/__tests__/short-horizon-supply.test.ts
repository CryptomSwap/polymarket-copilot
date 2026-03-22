/**
 * Static regression checks for short-horizon truth persistence path.
 * Verifies canonical evaluator now includes a pre-24h markout backfill pass.
 */

import * as fs from "fs";
import * as path from "path";

function check(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function run(): void {
  const repoRoot = path.resolve(__dirname, "../../..");
  const file = path.join(repoRoot, "lib/shadow-evaluation/evaluate.ts");
  const src = fs.readFileSync(file, "utf8");

  console.log("\n--- 1) short-horizon pass exists before full eval ---");
  check(src.includes("shortHorizonLimit"), "shortHorizonLimit option exists");
  check(src.includes("cutoff6h"), "6h cutoff exists");
  check(src.includes("shortHorizonCandidates"), "short-horizon candidate query exists");
  check(src.includes("OR: [{ markout1h: null }, { markout6h: null }]"), "query targets missing 1h/6h markouts");
  check(
    src.includes("Keep evaluatedAt null so full 24h outcome classification still happens later"),
    "comment documents no evaluatedAt contamination"
  );

  console.log("\n--- 2) short-horizon pass persists markout6h ---");
  check(src.includes("updateData.markout6h"), "markout6h write path exists");
  check(src.includes("await prisma.shadowCandidate.update"), "shadow candidate update call exists");

  console.log("\n--- 3) full 24h path remains intact ---");
  check(src.includes("const cutoff = new Date(Date.now() - minAgeMs);"), "existing 24h gating still present");
  check(src.includes("outcomeClassification = classify"), "classification path still present");
  check(src.includes("evaluatedAt: new Date()"), "full evaluation still marks evaluatedAt");

  console.log("\n--- 4) snapshot market-id mapping handles conditionId/id mismatch ---");
  check(src.includes("resolveSnapshotMarketIds"), "snapshot market-id resolver exists");
  check(src.includes("conditionId"), "resolver checks SyncedMarket.conditionId mapping");
  check(src.includes("marketId: { in: marketIds }"), "price lookup uses resolved market-id set");

  console.log("\nAll short-horizon supply tests passed.");
}

run();

