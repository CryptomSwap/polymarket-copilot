/**
 * Shadow label pipeline debug report.
 * Finds why PaperTrades do not resolve to labels (join, examples, 12h snapshot).
 * Writes dump/shadow-label-pipeline-debug-report.json and .md.
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import {
  runShadowLabelPipelineDebug,
  type ShadowLabelPipelineDebugResult,
} from "../lib/ml/audits/shadow-label-pipeline-debugger";

const DUMP_DIR = path.join(process.cwd(), "dump");

function renderMarkdown(r: ShadowLabelPipelineDebugResult): string {
  const lines: string[] = [];
  lines.push("# Shadow label pipeline debug report");
  lines.push("");
  lines.push("**Goal:** Find why PaperTrades are not resolving to labels (join or snapshot population).");
  lines.push("");
  lines.push("## 1) Summary");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|--------|-------|");
  lines.push("| % missing examples (no join) | " + r.join.pctMissingExamples.toFixed(1) + "% |");
  lines.push("| % join failures | " + r.join.pctJoinFailures.toFixed(1) + "% |");
  lines.push("| % examples with null label (among matched) | " + r.join.pctExamplesWithNullLabel.toFixed(1) + "% |");
  lines.push("| % resolved with label | " + r.join.pctResolvedWithLabel.toFixed(1) + "% |");
  lines.push("| % missing price snapshots (heuristic) | " + (r.priceSnapshots.pctMissingPriceSnapshots != null ? r.priceSnapshots.pctMissingPriceSnapshots.toFixed(1) + "%" : "—") + " |");
  lines.push("");
  lines.push("## 2) PaperTrade");
  lines.push("");
  lines.push("| Metric | Count | % |");
  lines.push("|--------|-------|---|");
  lines.push("| Total | " + r.paperTrade.total + " | 100% |");
  lines.push("| With recommendationId | " + r.paperTrade.withRecommendationId + " | " + r.paperTrade.pctWithRecommendationId.toFixed(1) + "% |");
  lines.push("| Without recommendationId | " + r.paperTrade.withoutRecommendationId + " | " + r.paperTrade.pctMissingRecommendationId.toFixed(1) + "% |");
  lines.push("");
  lines.push("## 3) MlShadowTrainingExample");
  lines.push("");
  lines.push("| Metric | Count | % (of total with recId) |");
  lines.push("|--------|-------|-------------------------|");
  lines.push("| Total | " + r.mlShadowTrainingExample.total + " | — |");
  lines.push("| With recommendationId | " + r.mlShadowTrainingExample.withRecommendationId + " | " + r.mlShadowTrainingExample.pctWithRecommendationId.toFixed(1) + "% |");
  lines.push("| With recId, null labelGoodDecision12h | " + r.mlShadowTrainingExample.withRecommendationIdNullLabel + " | " + r.mlShadowTrainingExample.pctExamplesWithNullLabel.toFixed(1) + "% |");
  lines.push("| With recId, non-null label | " + r.mlShadowTrainingExample.withRecommendationIdWithLabel + " | " + r.mlShadowTrainingExample.pctExamplesWithLabel.toFixed(1) + "% |");
  lines.push("");
  lines.push("## 4) Join (PaperTrade → MlShadowTrainingExample)");
  lines.push("");
  lines.push("Join key: `(recommendationId, assetId, side)`. recommendationId from PaperTrade.metadataJson.");
  lines.push("");
  lines.push("| Outcome | Count |");
  lines.push("|---------|-------|");
  lines.push("| No key (missing recommendationId) | " + r.join.noKey + " |");
  lines.push("| Key but no matching example | " + r.join.joinFailureNoExample + " |");
  lines.push("| Matched, example has null label | " + r.join.matchedNullLabel + " |");
  lines.push("| Matched, example has label | " + r.join.matchedWithLabel + " |");
  lines.push("");
  lines.push("## 5) Price snapshots");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|--------|-------|");
  lines.push("| Total MarketPriceSnapshot rows (lookback) | " + r.priceSnapshots.totalSnapshots + " |");
  lines.push("| Distinct (marketId, assetId) with snapshot | " + r.priceSnapshots.distinctMarketAssetWithSnapshot + " |");
  lines.push("| Examples with recId but null label (likely missing 12h) | " + r.priceSnapshots.examplesWithRecIdButNullLabel + " |");
  lines.push("");
  lines.push("## 6) Sample join failures");
  lines.push("");
  if (r.sampleJoinFailures.length === 0) {
    lines.push("None.");
  } else {
    lines.push("| PaperTrade id | assetId | side | recommendationId | reason |");
    lines.push("|--------------|---------|------|------------------|--------|");
    for (const s of r.sampleJoinFailures.slice(0, 15)) {
      lines.push("| " + s.paperTradeId.slice(0, 12) + " | " + s.assetId.slice(0, 12) + " | " + s.side + " | " + (s.recommendationId ?? "—") + " | " + s.reason + " |");
    }
  }
  lines.push("");
  lines.push("## 7) Sample matched but null label");
  lines.push("");
  if (r.sampleMatchedNullLabel.length === 0) {
    lines.push("None.");
  } else {
    lines.push("| PaperTrade id | key | exampleId | example labelGoodDecision12h |");
    lines.push("|--------------|-----|------------|------------------------------|");
    for (const s of r.sampleMatchedNullLabel.slice(0, 10)) {
      lines.push("| " + s.paperTradeId.slice(0, 12) + " | " + s.key.slice(0, 30) + "… | " + s.exampleId.slice(0, 12) + " | " + String(s.exampleLabelGoodDecision12h) + " |");
    }
  }
  lines.push("");
  lines.push("## 8) Caveats");
  lines.push("");
  for (const c of r.caveats) {
    lines.push("- " + c);
  }
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("*Debug is read-only. Join uses most recent example per (recommendationId, assetId, side).*");
  return lines.join("\n");
}

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });
  const result = await runShadowLabelPipelineDebug({ lookbackDays: 90, sampleSize: 25 });

  const jsonPath = path.join(DUMP_DIR, "shadow-label-pipeline-debug-report.json");
  await fs.writeFile(jsonPath, JSON.stringify(result, null, 2), "utf8");
  console.log("Wrote", jsonPath);

  const mdPath = path.join(DUMP_DIR, "shadow-label-pipeline-debug-report.md");
  await fs.writeFile(mdPath, renderMarkdown(result), "utf8");
  console.log("Wrote", mdPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
