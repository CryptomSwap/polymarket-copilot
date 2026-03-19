/**
 * Uncertainty and support metrics report: segment support, feature completeness, low-support flags.
 * Outputs: dump/ml-uncertainty-support-report.json, dump/ml-uncertainty-support-report.md
 */

import * as fs from "fs";
import * as path from "path";
import { buildSegmentSupportMap } from "../lib/ml/support/segment-support";

const DUMP_DIR = path.join(process.cwd(), "dump");

function ensureDumpDir(): void {
  if (!fs.existsSync(DUMP_DIR)) fs.mkdirSync(DUMP_DIR, { recursive: true });
}

async function main(): Promise<void> {
  ensureDumpDir();
  const report: {
    generatedAt: string;
    segmentSupport: Array<{ segmentKey: string; trainingCount: number; positiveCount?: number; lowSupport: boolean }>;
    minSupportUsed: number;
    note: string;
  } = {
    generatedAt: new Date().toISOString(),
    segmentSupport: [],
    minSupportUsed: 5,
    note: "Segment support built from placeholder; attach real training segment keys when available.",
  };

  try {
    const { prisma } = await import("../lib/db");
    const examples = await prisma.mlShadowTrainingExample.findMany({
      where: { labelGoodDecision: { not: null } },
      select: { candidateSource: true, executionBlockingReasonGroups: true },
      take: 3000,
    });
    const segmentValues = examples.map((r) => ({
      source: r.candidateSource ?? "unknown",
      block: (r.executionBlockingReasonGroups ?? "none").toString().slice(0, 50),
    }));
    const supportMap = buildSegmentSupportMap(segmentValues, 5);
    for (const [, summary] of supportMap) {
      report.segmentSupport.push({
        segmentKey: summary.segmentKey,
        trainingCount: summary.trainingCount,
        positiveCount: summary.positiveCount,
        lowSupport: summary.trainingCount < report.minSupportUsed,
      });
    }
  } catch {
    report.segmentSupport = [
      { segmentKey: "placeholder", trainingCount: 0, lowSupport: true },
    ];
  }

  const jsonPath = path.join(DUMP_DIR, "ml-uncertainty-support-report.json");
  const mdPath = path.join(DUMP_DIR, "ml-uncertainty-support-report.md");
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf-8");
  console.log(`Wrote ${jsonPath}`);

  const md = [
    "# ML Uncertainty / Support Report",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    `Min support threshold: ${report.minSupportUsed}`,
    "",
    "## Segment support",
    "| Segment key | Training count | Low support |",
    "|-------------|---------------|-------------|",
    ...report.segmentSupport.map(
      (s) => `| ${s.segmentKey} | ${s.trainingCount} | ${s.lowSupport ? "yes" : "no"} |`
    ),
    "",
    report.note,
    "",
  ].join("\n");
  fs.writeFileSync(mdPath, md, "utf-8");
  console.log(`Wrote ${mdPath}`);
}

main();
