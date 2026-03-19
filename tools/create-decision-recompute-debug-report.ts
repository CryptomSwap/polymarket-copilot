/**
 * Decision recompute debug report.
 * Runs recomputeDecisions() once and reports how many snapshots were upserted and any errors.
 *
 * Writes:
 * - dump/decision-recompute-debug-report.json
 * - dump/decision-recompute-debug-report.md
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import { recomputeDecisions, getFunderForDecisionRecompute } from "../lib/decision/recompute";

async function main(): Promise<void> {
  const dumpDir = path.join(process.cwd(), "dump");
  await fs.mkdir(dumpDir, { recursive: true });

  const funder = await getFunderForDecisionRecompute();
  const beforeSnapshots = await prisma.decisionPolicySnapshot.count({
    where: funder ? { funderAddress: funder } : undefined,
  });

  const result = await recomputeDecisions(funder ?? undefined);

  const afterSnapshots = await prisma.decisionPolicySnapshot.count({
    where: result.funderAddress ? { funderAddress: result.funderAddress } : undefined,
  });

  const report = {
    generatedAt: new Date().toISOString(),
    funderAddress: result.funderAddress,
    snapshotsBefore: beforeSnapshots,
    snapshotsAfter: afterSnapshots,
    snapshotsDelta: afterSnapshots - beforeSnapshots,
    profilesCreated: result.profilesCreated,
    profilesUpdated: result.profilesUpdated,
    snapshotsUpserted: result.snapshotsUpserted,
    errorCount: result.errors.length,
    errorsSample: result.errors.slice(0, 10),
  };

  const jsonPath = path.join(dumpDir, "decision-recompute-debug-report.json");
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");
  console.log("Wrote", jsonPath);

  const lines: string[] = [];
  lines.push("# Decision recompute debug report");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|--------|-------|");
  lines.push("| Funder | " + report.funderAddress + " |");
  lines.push("| Snapshots before | " + report.snapshotsBefore + " |");
  lines.push("| Snapshots after | " + report.snapshotsAfter + " |");
  lines.push("| Delta | " + report.snapshotsDelta + " |");
  lines.push("| Profiles created | " + report.profilesCreated + " |");
  lines.push("| Profiles updated | " + report.profilesUpdated + " |");
  lines.push("| snapshotsUpserted (reported) | " + report.snapshotsUpserted + " |");
  lines.push("| errorCount | " + report.errorCount + " |");
  lines.push("");
  if (report.errorCount > 0) {
    lines.push("## Sample errors");
    lines.push("");
    for (const e of report.errorsSample) {
      lines.push("- " + e);
    }
  } else {
    lines.push("No errors reported by recomputeDecisions().");
  }

  const mdPath = path.join(dumpDir, "decision-recompute-debug-report.md");
  await fs.writeFile(mdPath, lines.join("\n"), "utf8");
  console.log("Wrote", mdPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

