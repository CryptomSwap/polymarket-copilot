/**
 * Close eligible relaxed paper trades (12h rule), regenerate analytics dumps, and write a compact outcome summary.
 * Run: npx tsx tools/run-paper-relaxed-close-and-report.ts
 * Or: npm run dump:paper-relaxed-close-and-report
 */

import "dotenv/config";
import * as fs from "fs/promises";
import * as path from "path";
import { execSync } from "child_process";
import { prisma } from "../lib/db";
import { getFunderForDecisionRecompute } from "../lib/decision/recompute";
import { getActiveOrApprovedShadowModel } from "../lib/ml/shadow-score";
import { getPaperTradingConfig } from "../lib/paper-trading/config";
import { closePaperTradesAt12h } from "../lib/paper-trading/engine";

const DUMP_DIR = path.join(process.cwd(), "dump");
const SUMMARY_PATH = path.join(DUMP_DIR, "paper-relaxed-close-and-report-summary.md");

/** Same 12h rule as engine: entryTime <= now - 12h => eligible to close. */
const HORIZON_12H_MS = 12 * 60 * 60 * 1000;

async function getRelaxedSnapshot(): Promise<{
  totalRelaxed: number;
  openRelaxed: number;
  closedRelaxed: number;
  eligibleToCloseRelaxed: number;
}> {
  const relaxed = await prisma.paperTrade.findMany({
    where: { paperPolicyMode: "relaxed_block_candidate" },
    select: { id: true, status: true, entryTime: true },
  });
  const now = Date.now();
  const horizonEnd = new Date(now - HORIZON_12H_MS);
  const openRelaxed = relaxed.filter((t) => t.status === "open");
  const eligibleToCloseRelaxed = openRelaxed.filter((t) => t.entryTime <= horizonEnd).length;
  const closedRelaxed = relaxed.filter((t) => t.status === "closed").length;
  return {
    totalRelaxed: relaxed.length,
    openRelaxed: openRelaxed.length,
    closedRelaxed,
    eligibleToCloseRelaxed,
  };
}

async function main(): Promise<void> {
  const timestamp = new Date().toISOString();
  const root = process.cwd();

  console.log("1. Pre-close snapshot (relaxed cohort)...");
  const pre = await getRelaxedSnapshot();
  console.log("   Total relaxed:", pre.totalRelaxed, "| Open:", pre.openRelaxed, "| Closed:", pre.closedRelaxed, "| Eligible to close now:", pre.eligibleToCloseRelaxed);

  console.log("2. Running close (all eligible paper trades, 12h rule)...");
  const closeResult = await closePaperTradesAt12h();
  console.log("   Closed this run:", closeResult.closed, "| Errors:", closeResult.errors.length);
  if (closeResult.errors.length > 0) {
    closeResult.errors.slice(0, 5).forEach((e) => console.warn("   ", e));
  }

  console.log("3. Post-close snapshot (relaxed cohort)...");
  const post = await getRelaxedSnapshot();
  const relaxedClosedThisRun = post.closedRelaxed - pre.closedRelaxed;
  console.log("   Open relaxed:", post.openRelaxed, "| Closed relaxed:", post.closedRelaxed, "| Relaxed closed this run:", relaxedClosedThisRun);

  console.log("4. Regenerating dumps...");
  execSync("npx tsx tools/create-paper-relaxed-trades-review.ts", { cwd: root, stdio: "inherit" });
  execSync("npx tsx tools/create-paper-relaxed-cohort-analysis.ts", { cwd: root, stdio: "inherit" });
  execSync("npx tsx tools/create-paper-relaxed-threshold-sensitivity.ts", { cwd: root, stdio: "inherit" });

  const funder = await getFunderForDecisionRecompute();
  const active = await getActiveOrApprovedShadowModel();
  const config = getPaperTradingConfig();

  let reviewJson: Record<string, unknown> = {};
  let cohortJson: Record<string, unknown> = {};
  let thresholdJson: Record<string, unknown> = {};
  try {
    reviewJson = JSON.parse(await fs.readFile(path.join(DUMP_DIR, "paper-relaxed-trades-review.json"), "utf8"));
    cohortJson = JSON.parse(await fs.readFile(path.join(DUMP_DIR, "paper-relaxed-cohort-analysis.json"), "utf8"));
    thresholdJson = JSON.parse(await fs.readFile(path.join(DUMP_DIR, "paper-relaxed-threshold-sensitivity.json"), "utf8"));
  } catch (e) {
    console.warn("Could not read generated JSON for summary:", e);
  }

  const lines: string[] = [
    "# Paper relaxed close-and-report summary",
    "",
    "**Generated:** " + timestamp,
    "",
    "## Context",
    "- Active funder: " + (funder ?? "—") + "",
    "- Model run ID: " + (active?.run.id ?? "—") + "",
    "- Target: " + (active?.run.targetLabel ?? "—") + "",
    "- Threshold: " + config.threshold + "",
    "",
    "## Pre-close snapshot",
    "- Relaxed total trades: " + pre.totalRelaxed + "",
    "- Relaxed open (before close): " + pre.openRelaxed + "",
    "- Relaxed eligible to close (entryTime ≤ now − 12h): " + pre.eligibleToCloseRelaxed + "",
    "- Relaxed closed (before): " + pre.closedRelaxed + "",
    "",
    "## Close run",
    "- Actually closed this run (all paper trades): " + closeResult.closed + "",
    "- Relaxed closed this run (derived): " + relaxedClosedThisRun + "",
    "",
    "## Post-close snapshot",
    "- Relaxed open (after close): " + post.openRelaxed + "",
    "- Relaxed closed (after): " + post.closedRelaxed + "",
    "",
  ];

  if (post.closedRelaxed > 0) {
    const overall = cohortJson.relaxedOverall as Record<string, unknown> | undefined;
    lines.push("## Relaxed cohort outcomes (post-close)");
    if (overall) {
      lines.push("- Win rate: " + (overall.winRate ?? "—") + "");
      lines.push("- Avg PnL: " + (overall.averagePnl ?? "—") + "");
      lines.push("- Median PnL: " + (overall.medianPnl ?? "—") + "");
      const byR = (cohortJson.byRelaxationReason as Record<string, { cumulativePnl?: number | null }>) ?? {};
      const totalCumulative = Object.values(byR).reduce((s, r) => s + (r.cumulativePnl ?? 0), 0);
      if (totalCumulative !== 0) lines.push("- Cumulative PnL (sum by reason): " + totalCumulative.toFixed(4) + "");
      else lines.push("- Cumulative PnL: see cohort-analysis.json byRelaxationReason / entryPriceBandStats.");
    }
    lines.push("");
    lines.push("### By paperRelaxationReason");
    const byReason = (cohortJson.byRelaxationReason as Record<string, Record<string, unknown>>) ?? {};
    for (const [reason, r] of Object.entries(byReason)) {
      lines.push("- **" + reason + ":** opened=" + r.opened + " closed=" + r.closed + " winRate=" + (r.winRate ?? "—") + " avgPnl=" + (r.avgPnl ?? "—") + " medianPnl=" + (r.medianPnl ?? "—") + " cumulativePnl=" + (r.cumulativePnl ?? "—") + "");
    }
    lines.push("");
    lines.push("### By score band");
    const byScore = (cohortJson.byScoreBand as Record<string, Record<string, unknown>>) ?? {};
    for (const [band, r] of Object.entries(byScore)) {
      if ((r.opened as number) > 0)
        lines.push("- **" + band + ":** opened=" + r.opened + " closed=" + r.closed + " winRate=" + (r.winRate ?? "—") + " avgPnl=" + (r.avgPnl ?? "—") + " medianPnl=" + (r.medianPnl ?? "—") + "");
    }
    lines.push("");
    lines.push("### By entry price band");
    const byEntry = (cohortJson.entryPriceBandStats as Record<string, Record<string, unknown>>) ?? {};
    for (const [band, r] of Object.entries(byEntry)) {
      if ((r.opened as number) > 0)
        lines.push("- **" + band + ":** opened=" + r.opened + " closed=" + r.closed + " winRate=" + (r.winRate ?? "—") + " avgPnl=" + (r.avgPnl ?? "—") + " medianPnl=" + (r.medianPnl ?? "—") + " avgScore=" + (r.avgScore ?? "—") + "");
    }
    lines.push("");
    lines.push("### Threshold sensitivity (closed relaxed)");
    const byThresh = (thresholdJson.byThreshold as Record<string, Record<string, unknown>>) ?? {};
    for (const [th, r] of Object.entries(byThresh)) {
      if ((r.closedCount as number) > 0)
        lines.push("- Threshold " + th + ": included=" + r.includedCount + " closed=" + r.closedCount + " winRate=" + (r.winRate ?? "—") + " avgPnl=" + (r.avgPnl ?? "—") + " medianPnl=" + (r.medianPnl ?? "—") + " cumulativePnl=" + (r.cumulativePnl ?? "—") + "");
    }
    const worst = (cohortJson.worst20RelaxedClosed as unknown[]) ?? [];
    const best = (cohortJson.best20RelaxedClosed as unknown[]) ?? [];
    if (worst.length > 0 || best.length > 0) {
      lines.push("");
      lines.push("### Best / worst cohort slice");
      if (worst.length > 0) lines.push("- Worst " + worst.length + " closed relaxed: see paper-relaxed-cohort-analysis.json `worst20RelaxedClosed`.");
      if (best.length > 0) lines.push("- Best " + best.length + " closed relaxed: see paper-relaxed-cohort-analysis.json `best20RelaxedClosed`.");
    }
  } else {
    lines.push("## Relaxed cohort outcomes");
    lines.push("");
    lines.push("No relaxed trades were old enough yet (zero closed relaxed). Run again after trades have been open for at least 12h.");
  }

  await fs.mkdir(DUMP_DIR, { recursive: true });
  await fs.writeFile(SUMMARY_PATH, lines.join("\n"), "utf8");
  console.log("5. Wrote summary:", SUMMARY_PATH);
  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
