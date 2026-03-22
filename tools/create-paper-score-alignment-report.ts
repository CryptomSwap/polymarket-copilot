/**
 * Paper score ↔ realized performance alignment report.
 * Writes dump/paper-score-alignment-report.json and .md (read-only).
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { runPaperScoreAlignmentReport } from "../lib/paper-trading/paper-score-alignment-report";

const DUMP_DIR = path.join(process.cwd(), "dump");

function renderMarkdown(r: Awaited<ReturnType<typeof runPaperScoreAlignmentReport>>): string {
  const lines: string[] = [];
  lines.push("# Paper score alignment report");
  lines.push("");
  lines.push("- **Generated:** " + r.generatedAt);
  lines.push("- **Lookback (days):** " + r.lookbackDays);
  lines.push("- **Label proxy:** " + r.primaryTrainingLabel);
  lines.push("");
  lines.push("## Assumptions");
  lines.push("");
  for (const a of r.assumptions) {
    lines.push("- " + a);
  }
  lines.push("");
  lines.push("## Totals (window)");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|--------|-------|");
  lines.push("| Paper trades | " + r.totals.paperTradesInWindow + " |");
  lines.push("| Open | " + r.totals.openInWindow + " |");
  lines.push("| Closed | " + r.totals.closedInWindow + " |");
  lines.push("| With `openAttribution` in metadata | " + r.totals.withOpenAttributionJson + " |");
  lines.push("");

  lines.push("## By score band");
  lines.push("");
  lines.push(
    "| Band | Opens | Closes | mean pnl% | hit pnl | mean markout12h | label +% | mean spread bps | mean slip bps | spread n | slip n |"
  );
  lines.push("|------|-------|--------|-----------|---------|-----------------|----------|-----------------|---------------|----------|--------|");
  for (const b of r.byScoreBand) {
    const mp = b.meanPnlPct != null ? (b.meanPnlPct * 100).toFixed(2) + "%" : "—";
    const hp = b.hitRatePnl != null ? (b.hitRatePnl * 100).toFixed(1) + "%" : "—";
    const mm = b.meanMarkout12h != null ? (b.meanMarkout12h * 100).toFixed(2) + "%" : "—";
    const lr = b.labelPositiveRate != null ? (b.labelPositiveRate * 100).toFixed(1) + "%" : "—";
    const sp = b.meanSpreadBps != null ? b.meanSpreadBps.toFixed(1) : "—";
    const sl = b.meanSlippageBps != null ? b.meanSlippageBps.toFixed(1) : "—";
    lines.push(
      "| " +
        b.scoreBand +
        " | " +
        b.openCount +
        " | " +
        b.closedCount +
        " | " +
        mp +
        " | " +
        hp +
        " | " +
        mm +
        " | " +
        lr +
        " | " +
        sp +
        " | " +
        sl +
        " | " +
        b.spreadSamples +
        " | " +
        b.slippageSamples +
        " |"
    );
  }
  lines.push("");

  lines.push("## Monotonicity (closed trades)");
  lines.push("");
  lines.push("- **Spearman ρ (band order vs mean pnl):** " + (r.monotonicity.bandOrderCorrelationWithMeanPnl != null ? r.monotonicity.bandOrderCorrelationWithMeanPnl.toFixed(3) : "—"));
  lines.push("- **High − low band mean pnl:** " + (r.monotonicity.highBandMeanPnlVsLowBandMeanPnl != null ? (r.monotonicity.highBandMeanPnlVsLowBandMeanPnl * 100).toFixed(3) + " pp" : "—"));
  lines.push("- **Read:** " + r.monotonicity.interpretation);
  lines.push("");

  const ts = r.thresholdStudy;
  lines.push("## Threshold study (report-only, not applied)");
  lines.push("");
  lines.push("- " + ts.note);
  lines.push("");
  lines.push("| Setting | Value |");
  lines.push("|---------|-------|");
  lines.push("| Config threshold | " + ts.configThreshold + " |");
  lines.push("| Min score buffer | " + ts.configMinScoreBuffer + " |");
  lines.push("| Effective min score (default profile) | " + ts.effectiveMinScoreDefault + " |");
  lines.push("| Last tick aboveThresholdCount | " + (ts.lastTickAboveThresholdCount ?? "—") + " |");
  lines.push("| Last tick candidatesScored | " + (ts.lastTickCandidatesScored ?? "—") + " |");
  lines.push("| Last tick lastScoringTime | " + (ts.lastTickAt ?? "—") + " |");
  lines.push("");
  lines.push("### Closed outcomes: score ≥ effective min vs < effective min");
  lines.push("");
  lines.push("| Bucket | n | mean pnl% | hit pnl |");
  lines.push("|--------|---|-----------|---------|");
  const a = ts.outcomesAboveVsBelowEffectiveMin.aboveOrEqual;
  const bl = ts.outcomesAboveVsBelowEffectiveMin.below;
  lines.push(
    "| ≥ effective min | " +
      a.count +
      " | " +
      (a.meanPnlPct != null ? (a.meanPnlPct * 100).toFixed(2) + "%" : "—") +
      " | " +
      (a.hitRatePnl != null ? (a.hitRatePnl * 100).toFixed(1) + "%" : "—") +
      " |"
  );
  lines.push(
    "| < effective min | " +
      bl.count +
      " | " +
      (bl.meanPnlPct != null ? (bl.meanPnlPct * 100).toFixed(2) + "%" : "—") +
      " | " +
      (bl.hitRatePnl != null ? (bl.hitRatePnl * 100).toFixed(1) + "%" : "—") +
      " |"
  );
  lines.push("");
  lines.push("### Median score split (closed)");
  lines.push("");
  lines.push("| Side of median | n | mean pnl% | hit pnl |");
  lines.push("|----------------|---|-----------|---------|");
  const m = ts.medianSplit;
  lines.push(
    "| ≥ median (" +
      (m.medianScore != null ? m.medianScore.toFixed(4) : "—") +
      ") | " +
      m.atOrAboveMedian.count +
      " | " +
      (m.atOrAboveMedian.meanPnlPct != null ? (m.atOrAboveMedian.meanPnlPct * 100).toFixed(2) + "%" : "—") +
      " | " +
      (m.atOrAboveMedian.hitRatePnl != null ? (m.atOrAboveMedian.hitRatePnl * 100).toFixed(1) + "%" : "—") +
      " |"
  );
  lines.push(
    "| < median | " +
      m.belowMedian.count +
      " | " +
      (m.belowMedian.meanPnlPct != null ? (m.belowMedian.meanPnlPct * 100).toFixed(2) + "%" : "—") +
      " | " +
      (m.belowMedian.hitRatePnl != null ? (m.belowMedian.hitRatePnl * 100).toFixed(1) + "%" : "—") +
      " |"
  );
  lines.push("");
  lines.push("### Best hypothetical min-score (closed subset, min samples = " + ts.bestByMeanPnl.minSamples + ")");
  lines.push("");
  lines.push("- **By mean pnl:** " + (ts.bestByMeanPnl.hypotheticalMinScore ?? "—") + " — " + ts.bestByMeanPnl.caveat);
  lines.push("- **By hit rate:** " + (ts.bestByHitRate.hypotheticalMinScore ?? "—") + " — " + ts.bestByHitRate.caveat);
  lines.push("");
  lines.push("<details><summary>Full threshold grid (JSON in sibling file)</summary>");
  lines.push("");
  lines.push("See `paper-score-alignment-report.json` → `thresholdStudy.thresholdGrid`.");
  lines.push("");
  lines.push("</details>");
  lines.push("");
  return lines.join("\n");
}

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });
  const report = await runPaperScoreAlignmentReport({
    lookbackDays: Number(process.env.PAPER_ALIGNMENT_LOOKBACK_DAYS ?? 90),
    thresholdGridStep: Number(process.env.PAPER_ALIGNMENT_THRESHOLD_STEP ?? 0.025),
    minSamplesForThresholdBest: Number(process.env.PAPER_ALIGNMENT_MIN_SAMPLES_BEST ?? 8),
  });

  const jsonPath = path.join(DUMP_DIR, "paper-score-alignment-report.json");
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");
  console.log("Wrote", jsonPath);

  const mdPath = path.join(DUMP_DIR, "paper-score-alignment-report.md");
  await fs.writeFile(mdPath, renderMarkdown(report), "utf8");
  console.log("Wrote", mdPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
