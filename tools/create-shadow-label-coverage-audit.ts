/**
 * Shadow label coverage and calibration audit report.
 * Reads PaperTrade + MlShadowTrainingExample (labelGoodDecision12h), writes:
 * dump/shadow-label-coverage-audit.json, dump/shadow-label-coverage-audit.md
 * Read-only; does not change admission, runtime, or label semantics.
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { runShadowLabelCoverageAudit } from "../lib/ml/audits/shadow-label-coverage-audit";
import type { ShadowLabelCoverageAuditResult, ShadowLabelCoverageSegment } from "../lib/ml/audits/shadow-label-coverage-audit";

const DUMP_DIR = path.join(process.cwd(), "dump");

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });

  const report = await runShadowLabelCoverageAudit({
    lookbackDays: 90,
    minSupport: 10,
  });

  const jsonPath = path.join(DUMP_DIR, "shadow-label-coverage-audit.json");
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");
  console.log("Wrote", jsonPath);

  const md = renderMarkdown(report);
  const mdPath = path.join(DUMP_DIR, "shadow-label-coverage-audit.md");
  await fs.writeFile(mdPath, md, "utf8");
  console.log("Wrote", mdPath);
}

function renderMarkdown(report: ShadowLabelCoverageAuditResult): string {
  const lines: string[] = [];

  lines.push("# Shadow label coverage & calibration audit");
  lines.push("");
  lines.push("## 1) Overview / assumptions");
  lines.push("");
  lines.push("- **Primary target:** " + report.primaryTarget + " (operational).");
  lines.push("- **Scope:** PaperTrade rows (last " + report.lookbackDays + " days), labels resolved from MlShadowTrainingExample by (recommendationId, assetId, side).");
  lines.push("- **Null semantics:** Unlabeled = no matching example or labelGoodDecision12h is null (missing 12h data). Never treated as 0/false.");
  lines.push("");
  for (const a of report.assumptions) {
    lines.push("- " + a);
  }
  lines.push("");

  lines.push("## 2) Global summary (" + report.primaryTarget + ")");
  lines.push("");
  const g = report.global;
  lines.push("| Metric | Value |");
  lines.push("|--------|-------|");
  lines.push("| Total paper trades | " + g.totalPaperTrades + " |");
  lines.push("| With resolved example | " + g.totalWithResolvedExample + " |");
  lines.push("| Labeled (non-null 12h) | " + g.totalLabeled + " |");
  lines.push("| Unlabeled | " + g.totalUnlabeled + " |");
  lines.push("| Label coverage % | " + (g.labelCoveragePct != null ? g.labelCoveragePct.toFixed(1) + "%" : "—") + " |");
  lines.push("| Avg shadow score | " + (g.avgScore != null ? g.avgScore.toFixed(4) : "—") + " |");
  lines.push("| Empirical positive rate (labeled only) | " + (g.empiricalPositiveRate != null ? (g.empiricalPositiveRate * 100).toFixed(1) + "%" : "—") + " |");
  lines.push("| Calibration gap (avgScore - EPR) | " + (g.calibrationGap != null ? g.calibrationGap.toFixed(4) : "—") + " |");
  lines.push("| Brier-like error (labeled only) | " + (g.brierLikeError != null ? g.brierLikeError.toFixed(4) : "—") + " |");
  lines.push("| Win count (labeled) | " + g.winCount + " |");
  lines.push("| Loss count (labeled) | " + g.lossCount + " |");
  lines.push("");

  lines.push("## 3) Best available segment tables");
  lines.push("");
  lines.push("(Segments with at least " + report.minSupport + " rows.)");
  lines.push("");

  function tableSegment(name: string, segs: ShadowLabelCoverageSegment[]): void {
    if (segs.length === 0) return;
    lines.push("### " + name);
    lines.push("");
    lines.push("| Value | total | labeled | coverage% | avgScore | EPR | calGap | brier | challenger% |");
    lines.push("|-------|-------|--------|-----------|----------|-----|--------|-------|--------------|");
    for (const s of segs.slice(0, 15)) {
      const v = s.value ?? "null";
      const cov = s.labelCoveragePct != null ? s.labelCoveragePct.toFixed(1) : "—";
      const avg = s.avgShadowMlScore != null ? s.avgShadowMlScore.toFixed(3) : "—";
      const epr = s.empiricalPositiveRate != null ? (s.empiricalPositiveRate * 100).toFixed(1) + "%" : "—";
      const gap = s.calibrationGap != null ? s.calibrationGap.toFixed(3) : "—";
      const brier = s.brierLikeError != null ? s.brierLikeError.toFixed(3) : "—";
      const ch = s.challengerCoveragePct != null ? s.challengerCoveragePct.toFixed(0) + "%" : "—";
      lines.push("| " + v + " | " + s.totalRows + " | " + s.labeledRows + " | " + cov + " | " + avg + " | " + epr + " | " + gap + " | " + brier + " | " + ch + " |");
    }
    lines.push("");
  }

  tableSegment("By botType", report.byBotType);
  tableSegment("By targetLabel", report.byTargetLabel);
  tableSegment("By policyState", report.byPolicyState);
  tableSegment("By paperPolicyMode", report.byPaperPolicyMode);
  tableSegment("By entryPriceBand", report.byEntryPriceBand);
  tableSegment("By theme", report.byTheme);
  tableSegment("By category", report.byCategory);
  tableSegment("By challengerAvailable", report.byChallengerAvailable);
  tableSegment("By explorationAdmissionMode", report.byExplorationAdmissionMode);

  lines.push("## 4) Top risk segments");
  lines.push("");
  if (report.riskSegments.length === 0) {
    lines.push("None above threshold.");
  } else {
    lines.push("| Dimension | Value | Reason | Severity | Detail |");
    lines.push("|-----------|-------|--------|----------|--------|");
    for (const r of report.riskSegments.slice(0, 15)) {
      lines.push("| " + r.dimension + " | " + (r.value ?? "null") + " | " + r.reason + " | " + r.severity + " | " + JSON.stringify(r.detail) + " |");
    }
  }
  lines.push("");

  lines.push("## 5) Calibration bucket summary (global)");
  lines.push("");
  lines.push("| Score bucket | Count | Labeled | Empirical positive rate |");
  lines.push("|--------------|-------|--------|--------------------------|");
  for (const [bucket, data] of Object.entries(report.global.scoreBucketCounts).sort()) {
    const epr = data.empiricalPositiveRate != null ? (data.empiricalPositiveRate * 100).toFixed(1) + "%" : "—";
    lines.push("| " + bucket + " | " + data.count + " | " + data.labeledCount + " | " + epr + " |");
  }
  lines.push("");

  lines.push("## 6) Caveats / missing dimensions");
  lines.push("");
  for (const c of report.caveats) {
    lines.push("- " + c);
  }
  lines.push("");
  for (const d of report.dimensionsNotAvailable) {
    lines.push("- **Not available:** " + d);
  }
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("*Audit is read-only. Label semantics and runtime behavior are unchanged.*");
  return lines.join("\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
