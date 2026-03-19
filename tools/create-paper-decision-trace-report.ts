/**
 * Paper decision trace report from last open tick.
 * Reads PaperTradingState.lastOpenTickResultJson.decisionTraceBundle and writes:
 * dump/paper-decision-trace-report.json, dump/paper-decision-trace-report.md
 * Read-only; does not change runtime or admission behavior.
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import type { PaperDecisionTraceBundle } from "../lib/paper-trading/decision-trace-types";

const DUMP_DIR = path.join(process.cwd(), "dump");
const STATE_ID = "default";

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });

  const state = await prisma.paperTradingState.findUnique({
    where: { id: STATE_ID },
  });

  let bundle: PaperDecisionTraceBundle | null = null;
  let lastOpenTickAt: string | null = null;
  if (state?.lastOpenTickResultJson) {
    try {
      const parsed = JSON.parse(state.lastOpenTickResultJson) as Record<string, unknown>;
      lastOpenTickAt = state.lastOpenTickAt?.toISOString() ?? null;
      if (parsed.decisionTraceBundle && typeof parsed.decisionTraceBundle === "object") {
        bundle = parsed.decisionTraceBundle as unknown as PaperDecisionTraceBundle;
      }
    } catch {
      // ignore parse errors
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    lastOpenTickAt,
    hasTraceBundle: bundle != null,
    bundle: bundle ?? undefined,
  };

  const jsonPath = path.join(DUMP_DIR, "paper-decision-trace-report.json");
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");
  console.log("Wrote", jsonPath);

  const md = renderMarkdown(report);
  const mdPath = path.join(DUMP_DIR, "paper-decision-trace-report.md");
  await fs.writeFile(mdPath, md, "utf8");
  console.log("Wrote", mdPath);
}

function renderMarkdown(report: {
  generatedAt: string;
  lastOpenTickAt: string | null;
  hasTraceBundle: boolean;
  bundle?: PaperDecisionTraceBundle;
}): string {
  const lines: string[] = [];
  lines.push("# Paper decision trace report");
  lines.push("");
  lines.push("Short overview: last-tick candidate decision traces (observability only; admission unchanged).");
  lines.push("");
  lines.push(`Report generated: ${report.generatedAt}`);
  lines.push(`Last open tick at: ${report.lastOpenTickAt ?? "—"}`);
  lines.push(`Trace bundle present: ${report.hasTraceBundle ? "yes" : "no"}`);
  lines.push("");

  if (!report.bundle) {
    lines.push("No decision trace bundle in last open tick result. Run a paper-trading open tick to populate.");
    lines.push("");
    lines.push("---");
    lines.push("");
    lines.push("*Storage: Trace bundle is stored in `PaperTradingState.lastOpenTickResultJson.decisionTraceBundle`. Only the latest tick is kept. Detailed traces are capped at 400 entries; per-bot aggregates are exact.*");
    return lines.join("\n");
  }

  const b = report.bundle;
  lines.push("## Per-bot aggregates (last tick)");
  lines.push("");
  lines.push("| botType | total | admitted | rejected | byThreshold | byExplorationCap | byBudget | byCooldown | byDedupe | byCaps | other | explorationEligible | explorationUsed |");
  lines.push("|---------|-------|----------|----------|-------------|------------------|----------|------------|----------|-------|-------|---------------------|-----------------|");
  for (const a of b.perBotAggregates) {
    lines.push(
      `| ${a.botType} | ${a.totalCandidates} | ${a.admitted} | ${a.rejected} | ${a.rejectedByThreshold} | ${a.rejectedByExplorationCap} | ${a.rejectedByBudget} | ${a.rejectedByCooldown} | ${a.rejectedByDedupe} | ${a.rejectedByCaps} | ${a.rejectedOther} | ${a.explorationEligible} | ${a.explorationUsed} |`
    );
  }
  lines.push("");

  const rejectCounts: Record<string, number> = {};
  for (const t of b.traces) {
    if (t.finalDisposition === "rejected" && t.rejectReasonCode) {
      rejectCounts[t.rejectReasonCode] = (rejectCounts[t.rejectReasonCode] ?? 0) + 1;
    }
  }
  lines.push("## Reject reason summary (from stored traces)");
  lines.push("");
  lines.push("| Reason | Count |");
  lines.push("|--------|-------|");
  for (const [code, count] of Object.entries(rejectCounts).sort((a, b) => b[1] - a[1])) {
    lines.push(`| \`${code}\` | ${count} |`);
  }
  lines.push("");

  lines.push("## Sample detailed traces");
  lines.push("");
  lines.push(`Showing up to 15 traces (stored: ${b.traces.length}, maxStored: ${b.maxTracesStored}, totalCandidatesConsidered: ${b.totalCandidatesConsidered}).`);
  lines.push("");
  const sample = b.traces.slice(-15).reverse();
  for (let i = 0; i < sample.length; i++) {
    const t = sample[i];
    lines.push(`### Trace ${i + 1}`);
    lines.push("");
    lines.push(`- **botType:** ${t.botType} | **recommendationId:** ${t.recommendationId} | **assetId:** ${t.assetId}`);
    lines.push(`- **disposition:** ${t.finalDisposition}${t.rejectReasonCode ? ` | **rejectReasonCode:** \`${t.rejectReasonCode}\`` : ""}`);
    lines.push(`- **championScore:** ${t.championScore ?? "—"} | **minScore:** ${t.minScore ?? "—"} | thresholdEligible: ${t.thresholdEligible} | explorationUsed: ${t.explorationUsed}`);
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push("**Notes on bounded storage / approximations**");
  lines.push("");
  lines.push("- Only the **last open tick** result is persisted in `PaperTradingState.lastOpenTickResultJson`.");
  lines.push("- **Detailed traces** are capped at **400** entries per tick; the slice kept is the most recent 400 by consideration order.");
  lines.push("- **Per-bot aggregates** are exact (all candidates counted); they are not derived from the capped trace list.");
  lines.push("- Reject reason summary above is computed from the **stored** trace sample, so it may undercount when traces are capped.");
  lines.push("- Trace is observability-only; admission logic and behavior are unchanged.");
  return lines.join("\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
