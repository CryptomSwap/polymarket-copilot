/**
 * Writes dump/paper-score-calibration-report.json and .md (read-only diagnostics).
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import type { PaperScoreCalibrationReport, ScoreBatchStats } from "../lib/paper-trading/paper-score-calibration-report";
import {
  runPaperScoreCalibrationReport,
  summarizeScores,
} from "../lib/paper-trading/paper-score-calibration-report";
import { getPaperTradingConfig } from "../lib/paper-trading/config";
import { effectivePaperMinScoreFromConfig } from "../lib/paper-trading/paper-roi-admission";

const DUMP_DIR = path.join(process.cwd(), "dump");

const EMPTY_STATS: ScoreBatchStats = summarizeScores([]);

function mdStats(title: string, s: ScoreBatchStats): string {
  const lines = [`### ${title}`, "", "| Metric | Value |", "|--------|-------|"];
  lines.push(`| n | ${s.n} |`);
  lines.push(`| min | ${s.min ?? "—"} |`);
  lines.push(`| max | ${s.max ?? "—"} |`);
  lines.push(`| mean | ${s.mean ?? "—"} |`);
  lines.push(`| stdev | ${s.stdev ?? "—"} |`);
  lines.push(`| p50 | ${s.p50 ?? "—"} |`);
  lines.push(`| p90 | ${s.p90 ?? "—"} |`);
  lines.push(`| count ≥ 0.95 | ${s.countGte095} |`);
  lines.push(`| count ≥ 0.90 | ${s.countGte09} |`);
  lines.push("");
  return lines.join("\n");
}

function stubReport(technicalDetail: string): PaperScoreCalibrationReport {
  const cfg = getPaperTradingConfig();
  return {
    generatedAt: new Date().toISOString(),
    lookbackDays: 30,
    pipelineAudit: "DB unavailable; regenerate when DATABASE_URL is reachable.",
    dominantIssueHypothesis:
      "Could not load recent PaperTrade rows from the database; saturation/calibration stats require a successful query.",
    configEcho: {
      paperShadowLogitTemperature: cfg.paperShadowLogitTemperature,
      paperShadowUseCalibratedScoreForPaper: cfg.paperShadowUseCalibratedScoreForPaper,
      effectiveMinScoreWithOverride: effectivePaperMinScoreFromConfig(cfg),
    },
    logitFromMetadata: { note: "—", n: 0, stats: { ...EMPTY_STATS } },
    rawFromPaperTradeColumn: { ...EMPTY_STATS },
    counterfactualCalibrated: {
      note: "—",
      temperature: cfg.paperShadowLogitTemperature,
      stats: { ...EMPTY_STATS },
    },
    rankingSeparation: {
      rawStdev: null,
      calibratedStdev: null,
      ratioCalibratedOverRaw: null,
      interpretation: "—",
    },
    thresholdSelectivity: {
      hypotheticalMinScore: 0.95,
      fractionRawGte: null,
      fractionCalibratedGte: null,
      note: "stub",
    },
    recommendedNextSteps: ["Fix DB connection and re-run: npx tsx tools/create-paper-score-calibration-report.ts"],
    recommendedPaperThresholdAfterCalibration: {
      suggestedMinScore: null,
      rationale: "—",
      caveat: technicalDetail,
    },
  };
}

async function main(): Promise<void> {
  let r: PaperScoreCalibrationReport;
  try {
    r = await runPaperScoreCalibrationReport({ lookbackDays: 30, hypotheticalMinScore: 0.95 });
  } catch (e) {
    const full = e instanceof Error ? e.message : String(e);
    console.warn("[create-paper-score-calibration-report] DB failed; writing stub.", full);
    const detail = full.length > 400 ? `${full.slice(0, 397)}...` : full;
    r = stubReport(detail);
  }

  await fs.mkdir(DUMP_DIR, { recursive: true });
  const jsonPath = path.join(DUMP_DIR, "paper-score-calibration-report.json");
  const mdPath = path.join(DUMP_DIR, "paper-score-calibration-report.md");
  await fs.writeFile(jsonPath, JSON.stringify(r, null, 2), "utf8");

  const lines: string[] = [];
  lines.push("# Paper score calibration report");
  lines.push("");
  lines.push(`- **Generated:** ${r.generatedAt}`);
  lines.push(`- **Lookback (days):** ${r.lookbackDays}`);
  lines.push("");
  lines.push("## Pipeline audit");
  lines.push("");
  lines.push(r.pipelineAudit);
  lines.push("");
  lines.push("## Dominant issue hypothesis");
  lines.push("");
  lines.push(r.dominantIssueHypothesis);
  lines.push("");
  lines.push("## Config echo");
  lines.push("");
  lines.push(`- PAPER_SHADOW_LOGIT_TEMPERATURE: ${r.configEcho.paperShadowLogitTemperature}`);
  lines.push(`- PAPER_SHADOW_USE_CALIBRATED_SCORE_FOR_PAPER: ${r.configEcho.paperShadowUseCalibratedScoreForPaper}`);
  lines.push(`- Effective min score (global override included): ${r.configEcho.effectiveMinScoreWithOverride}`);
  lines.push("");
  lines.push(mdStats("Raw scores (PaperTrade.score)", r.rawFromPaperTradeColumn));
  lines.push(mdStats(`Counterfactual calibrated (T=${r.counterfactualCalibrated.temperature})`, r.counterfactualCalibrated.stats));
  lines.push(`*${r.counterfactualCalibrated.note}*`);
  lines.push("");
  lines.push(mdStats("Logits from metadata (subset)", r.logitFromMetadata.stats));
  lines.push(`*${r.logitFromMetadata.note}*`);
  lines.push("");
  lines.push("## Ranking separation");
  lines.push("");
  lines.push(`- **Raw stdev:** ${r.rankingSeparation.rawStdev ?? "—"}`);
  lines.push(`- **Calibrated stdev:** ${r.rankingSeparation.calibratedStdev ?? "—"}`);
  lines.push(`- **Ratio (cal/raw):** ${r.rankingSeparation.ratioCalibratedOverRaw ?? "—"}`);
  lines.push(`- **Interpretation:** ${r.rankingSeparation.interpretation}`);
  lines.push("");
  lines.push("## Threshold selectivity (hypothetical)");
  lines.push("");
  lines.push(`- **Hypothetical min:** ${r.thresholdSelectivity.hypotheticalMinScore}`);
  lines.push(`- **Fraction raw ≥ min:** ${r.thresholdSelectivity.fractionRawGte ?? "—"}`);
  lines.push(`- **Fraction calibrated ≥ min:** ${r.thresholdSelectivity.fractionCalibratedGte ?? "—"}`);
  lines.push(`- ${r.thresholdSelectivity.note}`);
  lines.push("");
  lines.push("## Recommended paper threshold (after calibration)");
  lines.push("");
  lines.push(`- **Suggested min score:** ${r.recommendedPaperThresholdAfterCalibration.suggestedMinScore ?? "—"}`);
  lines.push(`- **Rationale:** ${r.recommendedPaperThresholdAfterCalibration.rationale}`);
  lines.push(`- **Caveat:** ${r.recommendedPaperThresholdAfterCalibration.caveat}`);
  lines.push("");
  lines.push("## Next steps");
  lines.push("");
  for (const s of r.recommendedNextSteps) {
    lines.push(`- ${s}`);
  }
  lines.push("");

  await fs.writeFile(mdPath, lines.join("\n"), "utf8");
  console.log("Wrote", jsonPath);
  console.log("Wrote", mdPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
