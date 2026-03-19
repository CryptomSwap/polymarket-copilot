/**
 * Backfill DecisionPolicySnapshot rows for recent recommendations.
 * Uses recomputeDecisions to run the existing staged decision engine.
 *
 * Default: dry-run (no writes). Use --apply to perform recomputeDecisions for the resolved funder.
 *
 * Writes:
 * - dump/backfill-decision-policy-snapshots.json
 * - dump/backfill-decision-policy-snapshots.md
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import { recomputeDecisions, getFunderForDecisionRecompute } from "../lib/decision/recompute";

async function main(): Promise<void> {
  const dumpDir = path.join(process.cwd(), "dump");
  await fs.mkdir(dumpDir, { recursive: true });

  const apply = process.argv.includes("--apply");
  const dryRun = !apply;

  const funder = await getFunderForDecisionRecompute();

  // Snapshot counts before recompute (for currently resolved funder, if any)
  const beforeSnapshots = await prisma.decisionPolicySnapshot.count({
    where: funder ? { funderAddress: funder } : undefined,
  });

  let recomputeResult = null;
  if (!dryRun) {
    // Let recomputeDecisions resolve the funder internally so it matches its own logic.
    recomputeResult = await recomputeDecisions();
  }

  const effectiveFunder = recomputeResult?.funderAddress || funder || "";

  const afterSnapshots = await prisma.decisionPolicySnapshot.count({
    where: effectiveFunder ? { funderAddress: effectiveFunder } : undefined,
  });

  const report = {
    generatedAt: new Date().toISOString(),
    dryRun,
    funderAddress: effectiveFunder,
    snapshotsBefore: beforeSnapshots,
    snapshotsAfter: afterSnapshots,
    snapshotsDelta: afterSnapshots - beforeSnapshots,
    recomputeResult: dryRun ? null : recomputeResult,
    caveats: [
      "Backfill uses recomputeDecisions(), which rebuilds setup profiles and writes DecisionPolicySnapshot for all current recommendations for the funder.",
      "Dry-run mode only reports before/after counts; use --apply to actually recompute.",
    ],
  };

  const jsonPath = path.join(dumpDir, "backfill-decision-policy-snapshots.json");
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");
  console.log("Wrote", jsonPath);

  const lines: string[] = [];
  lines.push("# Backfill decision policy snapshots");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|--------|-------|");
  lines.push("| Dry run | " + dryRun + " |");
  lines.push("| Funder | " + effectiveFunder + " |");
  lines.push("| Snapshots before | " + beforeSnapshots + " |");
  lines.push("| Snapshots after | " + afterSnapshots + " |");
  lines.push("| Delta | " + report.snapshotsDelta + " |");
  lines.push("");
  lines.push("## Caveats");
  lines.push("");
  for (const c of report.caveats) {
    lines.push("- " + c);
  }
  lines.push("");
  lines.push("Run with `--apply` to run recomputeDecisions and write snapshots; default is dry-run.");

  const mdPath = path.join(dumpDir, "backfill-decision-policy-snapshots.md");
  await fs.writeFile(mdPath, lines.join("\n"), "utf8");
  console.log("Wrote", mdPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

