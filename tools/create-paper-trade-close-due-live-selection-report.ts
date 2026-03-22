/**
 * Live selection audit: Prisma due filter vs open PaperTrade rows + persisted close result shape.
 * Writes dump/paper-trade-close-due-live-selection-report.{md,json}
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { runPaperCloseDueSelectionAudit } from "../lib/paper-trading/paper-close-due-selection-audit";

const DUMP_DIR = path.join(process.cwd(), "dump");

function renderMd(a: Awaited<ReturnType<typeof runPaperCloseDueSelectionAudit>>): string {
  const lines: string[] = [];
  lines.push("# Paper trade close-due — live selection report");
  lines.push("");
  lines.push("**Generated:** " + a.generatedAt);
  lines.push("");
  lines.push("## Actual due filter (engine)");
  lines.push("");
  lines.push("- " + a.dueFilterDescription);
  lines.push("- `horizonEnd` = `" + a.horizonEndIso + "` (now − " + a.horizonMs / 3600000 + "h)");
  lines.push("");
  lines.push("## PaperTrade fields used");
  lines.push("");
  for (const f of a.paperTradeFieldsReferenced) {
    lines.push("- `" + f + "`");
  }
  lines.push("");
  lines.push("## Counts");
  lines.push("");
  lines.push("| Metric | Count |");
  lines.push("|--------|-------|");
  const c = (n: number | null) => (n == null ? "—" : String(n));
  lines.push("| Open total (`status = open`) | " + c(a.counts.openTotal) + " |");
  lines.push("| Due by engine (`entryTime ≤ horizonEnd`) | " + c(a.counts.dueByEntryTimeLteHorizonEnd) + " |");
  lines.push("| Open but not yet due (by entryTime) | " + c(a.counts.openNotYetDueByEntryTime) + " |");
  lines.push("| Hypothetical due if using `createdAt` instead | " + c(a.counts.wouldBeDueIfUsingCreatedAtInstead) + " |");
  lines.push("");
  lines.push("## Mismatch / notes");
  lines.push("");
  lines.push(a.mismatchExplanation);
  lines.push("");
  lines.push("## Persisted close result (PaperTradingState)");
  lines.push("");
  lines.push("- **lastCloseTickAt:** " + (a.rootCauseFromPersistedCloseResult.lastCloseTickAt ?? "—"));
  lines.push("- **legacyShape:** " + a.rootCauseFromPersistedCloseResult.normalized.legacyShape);
  lines.push("- **parseFailed:** " + a.rootCauseFromPersistedCloseResult.normalized.parseFailed);
  lines.push("- **inferred dueCount (diagnostics):** " + a.rootCauseFromPersistedCloseResult.normalized.dueCount);
  lines.push("- **closed:** " + a.rootCauseFromPersistedCloseResult.normalized.closed);
  lines.push("- **errorsTotal:** " + a.rootCauseFromPersistedCloseResult.normalized.errorsTotal);
  lines.push("");
  lines.push("**Interpretation:** " + a.rootCauseFromPersistedCloseResult.interpretation);
  lines.push("");
  lines.push("## Sample open trades (oldest 15 by entryTime)");
  lines.push("");
  lines.push("| id (prefix) | due? | age h (entry) | entryTime |");
  lines.push("|-------------|------|---------------|-----------|");
  for (const r of a.sampleOpenTrades) {
    lines.push(
      "| `" +
        r.id.slice(0, 12) +
        "…` | " +
        r.dueByEngineRule +
        " | " +
        r.ageHoursByEntry.toFixed(2) +
        " | " +
        r.entryTime +
        " |"
    );
  }
  lines.push("");
  lines.push("## Open but not due (first 10 by entryTime among `entryTime > horizonEnd`)");
  lines.push("");
  if (a.sampleOpenNotDue.length === 0) {
    lines.push("_None — all open rows are due by entryTime, or no open rows._");
  } else {
    lines.push("| id | age h | reason |");
    lines.push("|----|-------|--------|");
    for (const r of a.sampleOpenNotDue) {
      lines.push("| `" + r.id.slice(0, 12) + "…` | " + r.ageHoursByEntry.toFixed(2) + " | " + r.reasonExcluded + " |");
    }
  }
  lines.push("");
  lines.push("## Proof of fix");
  lines.push("");
  lines.push(
    "Deploy `closePaperTradesAt12h` that uses `resolvePaperTradeCloseExitPrice` and always sets `status: closed` when due. After one run, `dueByEntry` should match closed + `no_exit_price_snapshot` / markout counts in `closeReasonCounts`, and alignment report should show closed > 0."
  );
  lines.push("");
  return lines.join("\n");
}

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });
  const audit = await runPaperCloseDueSelectionAudit();
  const jsonPath = path.join(DUMP_DIR, "paper-trade-close-due-live-selection-report.json");
  const mdPath = path.join(DUMP_DIR, "paper-trade-close-due-live-selection-report.md");
  await fs.writeFile(jsonPath, JSON.stringify(audit, null, 2), "utf8");
  await fs.writeFile(mdPath, renderMd(audit), "utf8");
  console.log("Wrote", jsonPath);
  console.log("Wrote", mdPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
