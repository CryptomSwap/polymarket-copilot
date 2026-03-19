/**
 * Champion/challenger comparison report (scaffold).
 * Outputs: dump/ml-champion-challenger-report.json, dump/ml-champion-challenger-report.md
 */

import * as fs from "fs";
import * as path from "path";
import { buildChampionChallengerComparison } from "../lib/ml/champion-challenger";
import { fromLegacyShadowScore } from "../lib/ml/types/scoring";

const DUMP_DIR = path.join(process.cwd(), "dump");

function ensureDumpDir(): void {
  if (!fs.existsSync(DUMP_DIR)) fs.mkdirSync(DUMP_DIR, { recursive: true });
}

function main(): void {
  ensureDumpDir();
  const sampleChampion = fromLegacyShadowScore(0.55, "run-champion-1", "labelGoodDecision", "shadow_v1", []);
  const sampleChallenger = fromLegacyShadowScore(0.52, "run-challenger-1", "labelGoodDecision12h", "shadow_v1", []);
  const comparison = buildChampionChallengerComparison("sample-candidate-1", sampleChampion, [
    { descriptor: { variantId: "challenger-12h", role: "challenger", targetLabel: "labelGoodDecision12h", featureSet: "shadow_v1" }, bundle: sampleChallenger },
  ]);
  const report = {
    generatedAt: new Date().toISOString(),
    scaffold: true,
    note: "Full parallel scoring requires loading multiple model runs; this report shows format and sample comparison.",
    sampleComparison: comparison,
  };
  const jsonPath = path.join(DUMP_DIR, "ml-champion-challenger-report.json");
  const mdPath = path.join(DUMP_DIR, "ml-champion-challenger-report.md");
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf-8");
  console.log(`Wrote ${jsonPath}`);
  const md = [
    "# ML Champion / Challenger Report",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "## Scaffold",
    "Champion = current active default model. Challenger = alternate target/calibration/feature set.",
    "",
    "## Sample comparison format",
    "| Candidate | Champion score | Best challenger score | Delta |",
    "|-----------|----------------|----------------------|-------|",
    `| ${comparison.candidateId} | ${comparison.summary?.championScore ?? "—"} | ${comparison.summary?.bestChallengerScore ?? "—"} | ${comparison.summary?.scoreDelta ?? "—"} |`,
    "",
    report.note,
    "",
  ].join("\n");
  fs.writeFileSync(mdPath, md, "utf-8");
  console.log(`Wrote ${mdPath}`);
}

main();
