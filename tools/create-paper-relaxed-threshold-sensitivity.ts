/**
 * Threshold sensitivity for closed relaxed paper trades: simulate metrics at 0.3, 0.4, 0.5, 0.6.
 * Outputs: dump/paper-relaxed-threshold-sensitivity.json, dump/paper-relaxed-threshold-sensitivity.md
 * Run: npx tsx tools/create-paper-relaxed-threshold-sensitivity.ts
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";

const DUMP_DIR = path.join(process.cwd(), "dump");

const THRESHOLDS = [0.3, 0.4, 0.5, 0.6] as const;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (i - lo) * (sorted[hi] - sorted[lo]);
}

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });

  const timestamp = new Date().toISOString();

  const relaxedClosed = await prisma.paperTrade.findMany({
    where: {
      paperPolicyMode: "relaxed_block_candidate",
      status: "closed",
    },
  });

  const byThreshold: Record<
    number,
    { includedCount: number; closedCount: number; winRate: number | null; avgPnl: number | null; medianPnl: number | null; cumulativePnl: number | null }
  > = {};
  for (const th of THRESHOLDS) {
    const included = relaxedClosed.filter((t) => t.score >= th);
    const pnls = included.map((t) => parseFloat(t.pnlPct ?? "")).filter((n) => Number.isFinite(n));
    const wins = pnls.filter((p) => p > 0).length;
    byThreshold[th] = {
      includedCount: included.length,
      closedCount: included.length,
      winRate: pnls.length ? wins / pnls.length : null,
      avgPnl: pnls.length ? pnls.reduce((a, b) => a + b, 0) / pnls.length : null,
      medianPnl: pnls.length ? percentile([...pnls].sort((a, b) => a - b), 50) : null,
      cumulativePnl: pnls.length ? pnls.reduce((a, b) => a + b, 0) : null,
    };
  }

  const byThresholdByReason: Record<
    number,
    Record<string, { includedCount: number; closedCount: number; winRate: number | null; avgPnl: number | null; medianPnl: number | null; cumulativePnl: number | null }>
  > = {};
  for (const th of THRESHOLDS) {
    byThresholdByReason[th] = {};
    for (const reason of ["edge_too_small", "liquidity_too_low"]) {
      const subset = relaxedClosed.filter((t) => (t.paperRelaxationReason ?? "") === reason && t.score >= th);
      const pnls = subset.map((t) => parseFloat(t.pnlPct ?? "")).filter((n) => Number.isFinite(n));
      const wins = pnls.filter((p) => p > 0).length;
      byThresholdByReason[th][reason] = {
        includedCount: subset.length,
        closedCount: subset.length,
        winRate: pnls.length ? wins / pnls.length : null,
        avgPnl: pnls.length ? pnls.reduce((a, b) => a + b, 0) / pnls.length : null,
        medianPnl: pnls.length ? percentile([...pnls].sort((a, b) => a - b), 50) : null,
        cumulativePnl: pnls.length ? pnls.reduce((a, b) => a + b, 0) : null,
      };
    }
  }

  const report = {
    timestamp,
    totalClosedRelaxed: relaxedClosed.length,
    byThreshold,
    byThresholdByReason,
  };

  const jsonPath = path.join(DUMP_DIR, "paper-relaxed-threshold-sensitivity.json");
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");
  console.log("Wrote", jsonPath);

  const md: string[] = [
    "# Paper relaxed threshold sensitivity",
    "",
    "**Generated:** " + timestamp,
    "",
    "Closed relaxed trades only; metrics simulated as if each threshold had been used to include trades (score >= threshold).",
    "",
    "## Overall by threshold",
    "",
    "| Threshold | includedCount | closedCount | winRate | avgPnl | medianPnl | cumulativePnl |",
    "|-----------|---------------|-------------|---------|--------|-----------|---------------|",
  ];
  for (const th of THRESHOLDS) {
    const r = byThreshold[th];
    md.push(
      `| ${th} | ${r.includedCount} | ${r.closedCount} | ${r.winRate != null ? r.winRate.toFixed(3) : "—"} | ${r.avgPnl != null ? r.avgPnl.toFixed(3) : "—"} | ${r.medianPnl != null ? r.medianPnl.toFixed(3) : "—"} | ${r.cumulativePnl != null ? r.cumulativePnl.toFixed(3) : "—"} |`
    );
  }
  md.push("");
  md.push("## By threshold × reason (edge_too_small, liquidity_too_low)");
  md.push("");
  for (const th of THRESHOLDS) {
    md.push("### Threshold " + th);
    md.push("");
    md.push("| Reason | includedCount | closedCount | winRate | avgPnl | medianPnl | cumulativePnl |");
    md.push("|--------|---------------|-------------|---------|--------|-----------|---------------|");
    const byR = byThresholdByReason[th];
    for (const reason of ["edge_too_small", "liquidity_too_low"]) {
      const r = byR[reason];
      if (r) {
        md.push(
          `| ${reason} | ${r.includedCount} | ${r.closedCount} | ${r.winRate != null ? r.winRate.toFixed(3) : "—"} | ${r.avgPnl != null ? r.avgPnl.toFixed(3) : "—"} | ${r.medianPnl != null ? r.medianPnl.toFixed(3) : "—"} | ${r.cumulativePnl != null ? r.cumulativePnl.toFixed(3) : "—"} |`
        );
      }
    }
    md.push("");
  }

  const mdPath = path.join(DUMP_DIR, "paper-relaxed-threshold-sensitivity.md");
  await fs.writeFile(mdPath, md.join("\n"), "utf8");
  console.log("Wrote", mdPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
