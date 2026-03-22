/**
 * Static checks: 12h coverage selection and horizon isolation (no DB).
 */

import * as fs from "fs";
import * as path from "path";

function check(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function run(): void {
  console.log("\n--- 1. prefer_missing_12h SQL targets labelGoodDecision12h only (not 6h/24h) ---");
  {
    const p = path.resolve(__dirname, "../select-candidates.ts");
    const src = fs.readFileSync(p, "utf8");
    check(src.includes('ex."labelGoodDecision12h" IS NULL'), "join filters on 12h label column");
    check(!src.includes('sc."evaluatedAt"'), "12h backlog SQL does not filter on ShadowCandidate.evaluatedAt");
    check(!src.includes("markout6h"), "selection SQL does not use 6h markout (avoid 6h/12h conflation)");
    check(!src.includes("markout24h"), "selection SQL does not use 24h markout");
    check(src.includes("LEFT JOIN"), "uses join to MlShadowTrainingExample for dedupe semantics");
  }

  console.log("\n--- 2. build.ts branches on datasetCandidateSelection ---");
  {
    const p = path.resolve(__dirname, "../build.ts");
    const src = fs.readFileSync(p, "utf8");
    check(src.includes("prefer_missing_12h_label"), "build supports prefer_missing_12h_label");
    check(src.includes("selectShadowCandidateIdsPreferMissing12hLabel"), "wires selection helper");
  }

  console.log("\n--- 3. Unique shadowCandidateId prevents duplicate ML rows ---");
  {
    const schema = fs.readFileSync(
      path.resolve(__dirname, "../../../../prisma/schema.prisma"),
      "utf8"
    );
    check(schema.includes("shadowCandidateId") && schema.includes("@unique"), "schema enforces unique shadowCandidateId");
  }

  console.log("\n--- 4. Horizon labels remain independently derived in persist (12h vs 6h) ---");
  {
    const p = path.resolve(__dirname, "../build.ts");
    const src = fs.readFileSync(p, "utf8");
    check(src.includes("deriveGoodDecisionLabelFromMarkout") && src.includes("markout6hNum"), "6h from markout6h");
    check(src.includes("HORIZON_12H_MS") && src.includes("at12h"), "12h uses explicit 12h horizon window");
  }

  console.log("\n--- All coverage-12h-selection tests passed ---");
}

run();
