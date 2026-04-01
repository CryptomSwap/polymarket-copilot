import "dotenv/config";
import * as fs from "fs/promises";
import * as path from "path";
import { prisma } from "../lib/db";

function fmtDate(d: Date | null): string {
  return d ? d.toISOString() : "-";
}

async function fileHasDryRunMode(p: string): Promise<boolean> {
  try {
    const txt = await fs.readFile(p, "utf8");
    return txt.toLowerCase().includes("mode: dry-run");
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const generatedAt = new Date();
  const now = generatedAt;
  const hoursBack = Math.max(1, parseInt(process.env.PAPER_POST_FIX_PERSISTENCE_AUDIT_HOURS ?? "24", 10));
  const fallbackStart = new Date(now.getTime() - hoursBack * 60 * 60 * 1000);
  const start = process.env.PAPER_POST_FIX_AUDIT_START
    ? new Date(process.env.PAPER_POST_FIX_AUDIT_START)
    : fallbackStart;

  const postRows = await prisma.paperTrade.findMany({
    where: {
      dedupeKey: { contains: "|v2|" },
      createdAt: { gte: start },
    },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      createdAt: true,
      status: true,
      dedupeKey: true,
      metadataJson: true,
    },
  });

  const reopenRows = postRows.filter((r) => r.dedupeKey.includes("|reopen|"));
  const withScoreProvenance = postRows.filter((r) =>
    (r.metadataJson ?? "").includes('"scoreProvenance"')
  );
  const withClosedBypassMarker = postRows.filter((r) =>
    (r.metadataJson ?? "").includes("closedRowBypassed")
  );
  const openCount = postRows.filter((r) => r.status === "open").length;
  const closedCount = postRows.filter((r) => r.status === "closed").length;

  const detectorRule =
    "regime start = first PaperTrade where dedupeKey contains '|reopen|' (from v2 post-dedupe baseline script)";
  const detectorMissReason =
    reopenRows.length === 0
      ? "No persisted PaperTrade row currently has dedupeKey '|reopen|'; rule cannot anchor a post-fix regime."
      : "Detector would anchor on earliest '|reopen|' row.";

  const diagDir = path.join(process.cwd(), "diagnostics");
  const dryRunSignals = {
    admissionBlockers: await fileHasDryRunMode(
      path.join(diagDir, "v2-admission-blockers-audit.md")
    ),
    postSuppressionFlow: await fileHasDryRunMode(
      path.join(diagDir, "v2-post-suppression-flow-validation.md")
    ),
    dedupeMismatch: await fileHasDryRunMode(
      path.join(diagDir, "v2-dedupe-key-mismatch-audit.md")
    ),
  };

  const lines: string[] = [];
  lines.push("# V2 Post-Fix Persistence Audit");
  lines.push("");
  lines.push(`- Generated: ${generatedAt.toISOString()}`);
  lines.push(`- Audit window start: ${fmtDate(start)}`);
  lines.push(`- Audit window source: ${process.env.PAPER_POST_FIX_AUDIT_START ? "env:PAPER_POST_FIX_AUDIT_START" : `fallback:${hoursBack}h`}`);
  lines.push("");
  lines.push("## A. Persistence reality check");
  lines.push(`- V2 PaperTrade rows created after window start: ${postRows.length}`);
  lines.push(`- status split: open=${openCount}, closed=${closedCount}`);
  lines.push(`- rows with dedupeKey '|reopen|': ${reopenRows.length}`);
  lines.push(`- rows with metadataJson.scoreProvenance: ${withScoreProvenance.length}`);
  lines.push(`- rows with metadata marker 'closedRowBypassed': ${withClosedBypassMarker.length}`);
  if (postRows.length > 0) {
    lines.push(`- first row in window: ${fmtDate(postRows[0]!.createdAt)} (${postRows[0]!.id})`);
    lines.push(`- last row in window: ${fmtDate(postRows[postRows.length - 1]!.createdAt)} (${postRows[postRows.length - 1]!.id})`);
  }
  lines.push("");
  lines.push("## B. Detector audit");
  lines.push(`- current detector rule: ${detectorRule}`);
  lines.push(`- why detector missed: ${detectorMissReason}`);
  lines.push("- alternative detector candidates:");
  lines.push("  - createdAt >= explicit fix deployment timestamp (env-defined)");
  lines.push("  - first row where dedupeCollisionBreakdown.closedRowBypassed > 0 (if persisted)");
  lines.push("  - first row with explicit persisted post-fix marker in metadataJson");
  lines.push("  - first row with dedupeKey '|reopen|' (works only if that key path is persisted in non-dry-run opens)");
  lines.push("");
  lines.push("## C. Runtime vs persistence mismatch");
  lines.push(`- dry-run evidence present in admission blockers audit: ${dryRunSignals.admissionBlockers}`);
  lines.push(`- dry-run evidence present in post-suppression flow validation: ${dryRunSignals.postSuppressionFlow}`);
  lines.push(`- dry-run evidence present in dedupe mismatch audit: ${dryRunSignals.dedupeMismatch}`);
  lines.push(
    `- summary: ${dryRunSignals.admissionBlockers || dryRunSignals.postSuppressionFlow || dryRunSignals.dedupeMismatch ? "major recent evidence is from dry-run diagnostics; DB persistence must be verified separately" : "recent diagnostics are not marked dry-run"}`
  );
  lines.push("");
  lines.push("## D. Minimal recommendation for measurement");
  let recommendation = "wait for non-dry-run trades to accumulate";
  if (postRows.length > 0 && reopenRows.length === 0) recommendation = "better detector only";
  if (postRows.length === 0) recommendation = "wait for non-dry-run trades to accumulate";
  lines.push(`- ${recommendation}`);
  lines.push("");
  lines.push("## E. Blunt conclusion");
  let conclusion = "evidence insufficient";
  if (postRows.length > 0 && reopenRows.length > 0) conclusion = "post-fix opens are persisting; detector is wrong";
  else if (postRows.length === 0 && (dryRunSignals.admissionBlockers || dryRunSignals.postSuppressionFlow))
    conclusion = "only dry-run evidence exists so far";
  else if (postRows.length === 0) conclusion = "post-fix opens are not persisting in current validation path";
  else if (postRows.length > 0 && reopenRows.length === 0) conclusion = "post-fix opens are persisting; detector is wrong";
  lines.push(`- ${conclusion}`);

  await fs.mkdir(diagDir, { recursive: true });
  const outPath = path.join(diagDir, "v2-post-fix-persistence-audit.md");
  await fs.writeFile(outPath, lines.join("\n"), "utf8");
  console.log(`Wrote ${outPath}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

