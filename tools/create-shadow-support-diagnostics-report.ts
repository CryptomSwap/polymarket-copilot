/**
 * Shadow ML support diagnostics report.
 * Writes dump/shadow-support-diagnostics-report.json and .md.
 * Diagnostic only; does not change admission, thresholds, or runtime behavior.
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import {
  getShadowSupportDiagnosticsReport,
  type ShadowSupportDiagnosticsReport,
  type ShadowSupportDiagnostic,
} from "../lib/ml/support/shadow-support-diagnostics";

const DUMP_DIR = path.join(process.cwd(), "dump");

function renderMarkdown(report: ShadowSupportDiagnosticsReport): string {
  const lines: string[] = [];

  lines.push("# Shadow ML support diagnostics report");
  lines.push("");
  lines.push("## 1) Overview: what support means in this repo");
  lines.push("");
  for (const w of report.whatSupportMeans) {
    lines.push("- " + w);
  }
  lines.push("");

  lines.push("## 2) Exact vs heuristic signals");
  lines.push("");
  lines.push("**Exact:**");
  for (const s of report.exactSignals) {
    lines.push("- " + s);
  }
  lines.push("");
  lines.push("**Heuristic:**");
  for (const s of report.heuristicSignals) {
    lines.push("- " + s);
  }
  lines.push("");
  lines.push("**Cannot compute honestly:**");
  for (const s of report.cannotCompute) {
    lines.push("- " + s);
  }
  lines.push("");

  lines.push("## 3) Global support summary");
  lines.push("");
  const g = report.global;
  lines.push("| Metric | Value |");
  lines.push("|--------|-------|");
  lines.push("| Label coverage % | " + (g.labelCoveragePct != null ? g.labelCoveragePct.toFixed(1) + "%" : "—") + " |");
  lines.push("| Total paper trades (lookback) | " + g.totalPaperTrades + " |");
  lines.push("| Total labeled | " + g.totalLabeled + " |");
  lines.push("| Challenger coverage % | " + (g.challengerCoveragePct != null ? g.challengerCoveragePct.toFixed(1) + "%" : "—") + " |");
  lines.push("| Segment count | " + g.segmentCount + " |");
  lines.push("| Segments below min support | " + g.segmentsBelowMinSupport + " |");
  lines.push("| Model train count (metricsJson) | " + (g.modelTrainCount != null ? String(g.modelTrainCount) : "—") + " |");
  lines.push("");

  lines.push("## 4) Segment-level support summary (top 20)");
  lines.push("");
  lines.push("| Segment key | Training count | Below min support |");
  lines.push("|-------------|----------------|-------------------|");
  for (const s of report.segmentSupportSummary.slice(0, 20)) {
    lines.push("| " + s.segmentKey + " | " + s.trainingCount + " | " + (s.belowMinSupport ? "yes" : "no") + " |");
  }
  lines.push("");

  lines.push("## 5) Top low-support / risky segments");
  lines.push("");
  if (report.lowSupportSegments.length === 0) {
    lines.push("None below min support in sample.");
  } else {
    lines.push("| Segment key | Count | Reason |");
    lines.push("|-------------|-------|--------|");
    for (const r of report.lowSupportSegments.slice(0, 15)) {
      lines.push("| " + r.segmentKey + " | " + r.count + " | " + r.reason + " |");
    }
  }
  lines.push("");

  lines.push("## 6) Sample recent trades with support diagnostics");
  lines.push("");
  lines.push("| id | botType | score | bucket | lowSupport | reasonCodes | featurePct | provenance |");
  lines.push("|----|---------|-------|--------|------------|-------------|------------|------------|");
  for (const row of report.sampleDiagnostics.slice(0, 15)) {
    const d: ShadowSupportDiagnostic = row.diagnostic;
    const codes = d.supportReasonCodes.slice(0, 3).join("; ");
    lines.push(
      "| " +
        row.id.slice(0, 8) +
        " | " +
        (row.botType ?? "—") +
        " | " +
        row.score.toFixed(3) +
        " | " +
        d.supportBucket +
        " | " +
        (d.lowSupportWarning ? "yes" : "no") +
        " | " +
        codes +
        " | " +
        (d.featureCompletenessPct != null ? d.featureCompletenessPct + "%" : "—") +
        " | " +
        d.provenance +
        " |"
    );
  }
  lines.push("");

  lines.push("## 7) Caveats and future wiring");
  lines.push("");
  for (const c of report.caveats) {
    lines.push("- " + c);
  }
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("*Diagnostic only. Admission, thresholds, model selection, and training behavior are unchanged.*");
  return lines.join("\n");
}

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });

  const report = await getShadowSupportDiagnosticsReport();

  const jsonPath = path.join(DUMP_DIR, "shadow-support-diagnostics-report.json");
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");
  console.log("Wrote", jsonPath);

  const md = renderMarkdown(report);
  const mdPath = path.join(DUMP_DIR, "shadow-support-diagnostics-report.md");
  await fs.writeFile(mdPath, md, "utf8");
  console.log("Wrote", mdPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
