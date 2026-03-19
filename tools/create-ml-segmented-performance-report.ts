/**
 * Segmented model evaluation report (by category, price band, liquidity, spread, block reason, etc.).
 * Outputs: dump/ml-segmented-performance-report.json, dump/ml-segmented-performance-report.md
 * Uses sample/placeholder segments when no DB; run with real data for full report.
 */

import * as fs from "fs";
import * as path from "path";
import { prisma } from "../lib/db";

const DUMP_DIR = path.join(process.cwd(), "dump");

interface SegmentMetrics {
  segmentKey: string;
  segmentValue: string;
  exampleCount: number;
  positiveCount: number;
  positiveRate: number;
  avgScore: number | null;
  /** Bucketed calibration summary (e.g. low/med/high). */
  calibrationSummary?: string;
  thresholdHitRates?: Record<string, number>;
  supportFlag?: "ok" | "low";
}

function ensureDumpDir(): void {
  if (!fs.existsSync(DUMP_DIR)) fs.mkdirSync(DUMP_DIR, { recursive: true });
}

async function fetchSegmentedMetrics(): Promise<{
  byCandidateSource: SegmentMetrics[];
  byBlockReason: SegmentMetrics[];
  global: { exampleCount: number; positiveCount: number; positiveRate: number };
}> {
  const byCandidateSource: SegmentMetrics[] = [];
  const byBlockReason: SegmentMetrics[] = [];
  let globalPositive = 0;
  let globalCount = 0;

  try {
    const examples = await prisma.mlShadowTrainingExample.findMany({
      where: { labelGoodDecision: { not: null } },
      select: {
        labelGoodDecision: true,
        outcomeClassification: true,
        executionBlockingReasonGroups: true,
        candidateSource: true,
      },
      take: 5000,
    });
    globalCount = examples.length;
    globalPositive = examples.filter((r) => r.labelGoodDecision === true).length;

    const sourceCounts = new Map<string, { count: number; pos: number }>();
    const blockCounts = new Map<string, { count: number; pos: number }>();
    for (const r of examples) {
      const src = r.candidateSource ?? "unknown";
      const curSrc = sourceCounts.get(src) ?? { count: 0, pos: 0 };
      curSrc.count++;
      if (r.labelGoodDecision === true) curSrc.pos++;
      sourceCounts.set(src, curSrc);

      const block = r.executionBlockingReasonGroups ?? "none";
      const curBlock = blockCounts.get(block) ?? { count: 0, pos: 0 };
      curBlock.count++;
      if (r.labelGoodDecision === true) curBlock.pos++;
      blockCounts.set(block, curBlock);
    }
    for (const [segmentValue, { count, pos }] of sourceCounts) {
      byCandidateSource.push({
        segmentKey: "candidate_source",
        segmentValue,
        exampleCount: count,
        positiveCount: pos,
        positiveRate: count > 0 ? pos / count : 0,
        avgScore: null,
        supportFlag: count < 10 ? "low" : "ok",
      });
    }
    for (const [segmentValue, { count, pos }] of blockCounts) {
      byBlockReason.push({
        segmentKey: "block_reason_group",
        segmentValue,
        exampleCount: count,
        positiveCount: pos,
        positiveRate: count > 0 ? pos / count : 0,
        avgScore: null,
        supportFlag: count < 10 ? "low" : "ok",
      });
    }
  } catch (e) {
    console.warn("DB not available or no data:", e instanceof Error ? e.message : String(e));
  }

  return {
    byCandidateSource,
    byBlockReason,
    global: {
      exampleCount: globalCount,
      positiveCount: globalPositive,
      positiveRate: globalCount > 0 ? globalPositive / globalCount : 0,
    },
  };
}

async function main(): Promise<void> {
  ensureDumpDir();
  const metrics = await fetchSegmentedMetrics();
  const report = {
    generatedAt: new Date().toISOString(),
    global: metrics.global,
    segments: {
      byCandidateSource: metrics.byCandidateSource,
      byBlockReason: metrics.byBlockReason,
    },
    note: "avgScore and thresholdHitRates require scored validation set; add when evaluation pipeline runs.",
  };
  const jsonPath = path.join(DUMP_DIR, "ml-segmented-performance-report.json");
  const mdPath = path.join(DUMP_DIR, "ml-segmented-performance-report.md");
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf-8");
  console.log(`Wrote ${jsonPath}`);

  const md = [
    "# ML Segmented Performance Report",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "## Global",
    `- Examples: ${report.global.exampleCount}`,
    `- Positive count: ${report.global.positiveCount}`,
    `- Positive rate: ${report.global.positiveRate.toFixed(3)}`,
    "",
    "## By candidate source",
    "| Segment | Count | Positive | Rate | Support |",
    "|---------|-------|----------|------|---------|",
    ...metrics.byCandidateSource.map(
      (s) =>
        `| ${s.segmentValue} | ${s.exampleCount} | ${s.positiveCount} | ${s.positiveRate.toFixed(3)} | ${s.supportFlag ?? "ok"} |`
    ),
    "",
    "## By block reason group",
    "| Segment | Count | Positive | Rate | Support |",
    "|---------|-------|----------|------|---------|",
    ...metrics.byBlockReason.map(
      (s) =>
        `| ${s.segmentValue} | ${s.exampleCount} | ${s.positiveCount} | ${s.positiveRate.toFixed(3)} | ${s.supportFlag ?? "ok"} |`
    ),
    "",
    report.note,
    "",
  ].join("\n");
  fs.writeFileSync(mdPath, md, "utf-8");
  console.log(`Wrote ${mdPath}`);
}

main();
