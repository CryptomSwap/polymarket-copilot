/**
 * Paper candidate snapshot visibility report.
 * Compares paper candidate loader diagnostics with actual DecisionPolicySnapshot counts.
 *
 * Writes:
 * - dump/paper-candidate-snapshot-visibility-report.json
 * - dump/paper-candidate-snapshot-visibility-report.md
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import { getPaperTradingCandidatesWithDiagnostics } from "../lib/paper-trading/candidates";
import { getFunderForDecisionRecompute } from "../lib/decision/recompute";

async function main(): Promise<void> {
  const dumpDir = path.join(process.cwd(), "dump");
  await fs.mkdir(dumpDir, { recursive: true });

  const funder =
    (await getFunderForDecisionRecompute()) ??
    (await prisma.marketSignal.findFirst({ select: { funderAddress: true } }).then((r) => r?.funderAddress ?? "")).toLowerCase().trim();

  const { loadDiagnostics } = await getPaperTradingCandidatesWithDiagnostics(funder || "paper");

  const snapshotCounts = await prisma.decisionPolicySnapshot
    .groupBy({
      by: ["funderAddress"],
      _count: { id: true },
    })
    .catch(() => [] as { funderAddress: string; _count: { id: number } }[]);

  const snapshotsForFunder =
    snapshotCounts.find((g) => g.funderAddress.toLowerCase().trim() === funder)?. _count.id ?? 0;

  const result = {
    generatedAt: new Date().toISOString(),
    funderAddress: funder,
    loader: loadDiagnostics,
    snapshots: {
      totalByFunder: snapshotsForFunder,
      allFunders: snapshotCounts,
    },
  };

  const jsonPath = path.join(dumpDir, "paper-candidate-snapshot-visibility-report.json");
  await fs.writeFile(jsonPath, JSON.stringify(result, null, 2), "utf8");
  console.log("Wrote", jsonPath);

  const lines: string[] = [];
  lines.push("# Paper candidate snapshot visibility report");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|--------|-------|");
  lines.push("| Funder | " + funder + " |");
  lines.push("| recommendationsFound | " + loadDiagnostics.recommendationsFound + " |");
  lines.push("| noDecisionSnapshot | " + loadDiagnostics.noDecisionSnapshot + " |");
  lines.push("| afterPolicyFilter | " + loadDiagnostics.afterPolicyFilter + " |");
  lines.push("| zeroCandidatesReason | " + (loadDiagnostics.zeroCandidatesReason || "—") + " |");
  lines.push("| snapshots for funder | " + snapshotsForFunder + " |");
  lines.push("");
  lines.push("## Policy state counts");
  lines.push("");
  lines.push("```");
  lines.push(JSON.stringify(loadDiagnostics.policyStateCounts ?? {}, null, 2));
  lines.push("```");
  lines.push("");
  lines.push("## Notes");
  lines.push("");
  lines.push(
    "- If `noDecisionSnapshot` is high but `snapshots for funder` > 0, the loader may be filtering snapshots (e.g. by funder or policy state)."
  );
  lines.push(
    "- After running backfill (`backfill:decision-policy-snapshots -- --apply`), rerun this report to confirm `afterPolicyFilter > 0`."
  );

  const mdPath = path.join(dumpDir, "paper-candidate-snapshot-visibility-report.md");
  await fs.writeFile(mdPath, lines.join("\n"), "utf8");
  console.log("Wrote", mdPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

