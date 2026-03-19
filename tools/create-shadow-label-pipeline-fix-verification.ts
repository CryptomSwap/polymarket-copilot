/**
 * Verification report for shadow label pipeline fix.
 * Runs pipeline debugger and MlShadowTrainingExample counts; writes
 * dump/shadow-label-pipeline-fix-verification.json and .md.
 * Run before backfill for baseline; run after backfill --apply to verify improvement.
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import { runShadowLabelPipelineDebug } from "../lib/ml/audits/shadow-label-pipeline-debugger";

const DUMP_DIR = path.join(process.cwd(), "dump");

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });

  const [debugResult, totalExamples, withRecIdCount] = await Promise.all([
    runShadowLabelPipelineDebug({ lookbackDays: 90, sampleSize: 15 }),
    prisma.mlShadowTrainingExample.count().catch(() => 0),
    prisma.mlShadowTrainingExample.count({ where: { recommendationId: { not: null } } }).catch(() => 0),
  ]);

  const withRecId = withRecIdCount;

  const report = {
    generatedAt: new Date().toISOString(),
    mlShadowTrainingExample: {
      totalRows: totalExamples,
      rowsWithRecommendationId: withRecId,
      rowsWithRecommendationIdPct: totalExamples > 0 ? (withRecId / totalExamples) * 100 : 0,
    },
    join: {
      pctMissingExamples: debugResult.join.pctMissingExamples,
      pctJoinFailures: debugResult.join.pctJoinFailures,
      pctResolvedWithLabel: debugResult.join.pctResolvedWithLabel,
      matchedWithLabel: debugResult.join.matchedWithLabel,
      matchedNullLabel: debugResult.join.matchedNullLabel,
      noKey: debugResult.join.noKey,
      joinFailureNoExample: debugResult.join.joinFailureNoExample,
    },
    paperTrade: {
      total: debugResult.paperTrade.total,
      withRecommendationId: debugResult.paperTrade.withRecommendationId,
    },
    caveats: [
      "Run before backfill for baseline. Run backfill with --apply, then re-run this script to verify improvement.",
      ...debugResult.caveats,
    ],
  };

  const jsonPath = path.join(DUMP_DIR, "shadow-label-pipeline-fix-verification.json");
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");
  console.log("Wrote", jsonPath);

  const md = [
    "# Shadow label pipeline fix verification",
    "",
    "## MlShadowTrainingExample",
    "| Metric | Value |",
    "|--------|-------|",
    "| Total rows | " + report.mlShadowTrainingExample.totalRows + " |",
    "| Rows with recommendationId | " + report.mlShadowTrainingExample.rowsWithRecommendationId + " |",
    "| % with recommendationId | " + report.mlShadowTrainingExample.rowsWithRecommendationIdPct.toFixed(1) + "% |",
    "",
    "## Join (PaperTrade → MlShadowTrainingExample)",
    "| Metric | Value |",
    "|--------|-------|",
    "| % missing examples | " + report.join.pctMissingExamples.toFixed(1) + "% |",
    "| % join failures | " + report.join.pctJoinFailures.toFixed(1) + "% |",
    "| % resolved with label | " + report.join.pctResolvedWithLabel.toFixed(1) + "% |",
    "| Matched with label | " + report.join.matchedWithLabel + " |",
    "| Matched but null label | " + report.join.matchedNullLabel + " |",
    "| No key (missing recId on PT) | " + report.join.noKey + " |",
    "| Join failure (no example) | " + report.join.joinFailureNoExample + " |",
    "",
    "## Caveats",
    ...report.caveats.map((c) => "- " + c),
    "",
    "---",
    "*Run before and after backfill to compare.*",
  ].join("\n");
  const mdPath = path.join(DUMP_DIR, "shadow-label-pipeline-fix-verification.md");
  await fs.writeFile(mdPath, md, "utf8");
  console.log("Wrote", mdPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
