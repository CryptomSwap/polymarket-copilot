/**
 * Writes dump/paper-roi-optimization-report.json and .md (read-only analytics).
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import {
  PAPER_ROI_IMPLEMENTATION_NOTE,
  runPaperRoiOptimizationReport,
} from "../lib/paper-trading/paper-roi-optimization-report";
import { getPaperTradingConfig } from "../lib/paper-trading/config";
import { effectivePaperMinScoreFromConfig } from "../lib/paper-trading/paper-roi-admission";

const DUMP_DIR = path.join(process.cwd(), "dump");

function mdTable(rows: [string, string][]): string {
  const lines = ["| Key | Value |", "|-----|-------|"];
  for (const [k, v] of rows) {
    lines.push(`| ${k} | ${v} |`);
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  let r: Awaited<ReturnType<typeof runPaperRoiOptimizationReport>>;
  try {
    r = await runPaperRoiOptimizationReport({ lookbackDays: 14 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("[create-paper-roi-optimization-report] DB/query failed; writing stub.", msg);
    const cfg = getPaperTradingConfig();
    r = {
      generatedAt: new Date().toISOString(),
      lookbackDays: 14,
      implementationNote: PAPER_ROI_IMPLEMENTATION_NOTE,
      paperConfig: {
        threshold: cfg.threshold,
        minScoreBuffer: cfg.minScoreBuffer,
        effectiveMinScoreDefault: effectivePaperMinScoreFromConfig(cfg),
        paperMinScoreOverrideGlobal: cfg.paperMinScoreOverrideGlobal,
        paperSizeByScoreEnabled: cfg.paperSizeByScoreEnabled,
        paperSizeScoreTiers: cfg.paperSizeScoreTiers.map((t) => ({
          maxExclusive: t.maxExclusive,
          label: t.label,
          multiplier: t.multiplier,
        })),
        paperMaxSpreadBps: cfg.paperMaxSpreadBps,
        paperMaxEstimatedSlippageBps: cfg.paperMaxEstimatedSlippageBps,
      },
      lastOpenTick: null,
      windowTrades: { total: 0, open: 0, closed: 0, withPaperRoiAdmission: 0 },
      scoreQuantilesRecentCandidates: {
        note: "No data — regenerate when DATABASE_URL is reachable.",
        count: 0,
        scores: [],
        p50: null,
        p90: null,
      },
      simulatedBucketCountsOnScores: {},
      opensByConfiguredSizeBucket: {},
      closedPnlByScoreBucket: [],
      spreadSlippage: {
        spreadBps: { count: 0, mean: null, p50: null, p90: null },
        slippageBps: { count: 0, mean: null, p50: null, p90: null },
      },
      recommendation: {
        summary: "Regenerate this report with a live DB: npx tsx tools/create-paper-roi-optimization-report.ts",
        caveat: `Stub only: ${msg}`,
      },
    };
  }
  await fs.mkdir(DUMP_DIR, { recursive: true });
  const jsonPath = path.join(DUMP_DIR, "paper-roi-optimization-report.json");
  const mdPath = path.join(DUMP_DIR, "paper-roi-optimization-report.md");
  await fs.writeFile(jsonPath, JSON.stringify(r, null, 2), "utf8");

  const lines: string[] = [];
  lines.push("# Paper ROI optimization report");
  lines.push("");
  lines.push(`- **Generated:** ${r.generatedAt}`);
  lines.push(`- **Lookback (days):** ${r.lookbackDays}`);
  lines.push("");
  lines.push("## Implementation note (audit)");
  lines.push("");
  lines.push(r.implementationNote);
  lines.push("");
  lines.push("## Current paper config (ROI knobs)");
  lines.push("");
  lines.push(
    mdTable([
      ["PAPER_TRADING_THRESHOLD", String(r.paperConfig.threshold)],
      ["PAPER_TRADING_MIN_SCORE_BUFFER", String(r.paperConfig.minScoreBuffer)],
      ["Effective min score (base + global override)", String(r.paperConfig.effectiveMinScoreDefault)],
      ["PAPER_TRADING_MIN_SCORE_OVERRIDE", r.paperConfig.paperMinScoreOverrideGlobal == null ? "(unset)" : String(r.paperConfig.paperMinScoreOverrideGlobal)],
      ["PAPER_TRADING_SIZE_BY_SCORE_ENABLED", String(r.paperConfig.paperSizeByScoreEnabled)],
      ["PAPER_TRADING_MAX_SPREAD_BPS", String(r.paperConfig.paperMaxSpreadBps)],
      ["PAPER_TRADING_MAX_ESTIMATED_SLIPPAGE_BPS", r.paperConfig.paperMaxEstimatedSlippageBps == null ? "(unset)" : String(r.paperConfig.paperMaxEstimatedSlippageBps)],
    ])
  );
  lines.push("");
  lines.push("### Configured score → size tiers");
  lines.push("");
  lines.push("| maxExclusive | label | multiplier |");
  lines.push("|--------------|-------|------------|");
  for (const t of r.paperConfig.paperSizeScoreTiers) {
    lines.push(`| ${t.maxExclusive} | ${t.label} | ${t.multiplier} |`);
  }
  lines.push("");
  lines.push("## Last persisted open tick (if any)");
  lines.push("");
  if (r.lastOpenTick) {
    lines.push(
      mdTable([
        ["lastScoringTime", r.lastOpenTick.lastScoringTime ?? "—"],
        ["opened", r.lastOpenTick.opened != null ? String(r.lastOpenTick.opened) : "—"],
        ["skipped", r.lastOpenTick.skipped != null ? String(r.lastOpenTick.skipped) : "—"],
        ["candidatesScored", r.lastOpenTick.candidatesScored != null ? String(r.lastOpenTick.candidatesScored) : "—"],
        ["aboveThresholdCount", r.lastOpenTick.aboveThresholdCount != null ? String(r.lastOpenTick.aboveThresholdCount) : "—"],
        ["rejectedBySpreadGuardCount", r.lastOpenTick.rejectedBySpreadGuardCount != null ? String(r.lastOpenTick.rejectedBySpreadGuardCount) : "—"],
        ["rejectedBySlippageGuardCount", r.lastOpenTick.rejectedBySlippageGuardCount != null ? String(r.lastOpenTick.rejectedBySlippageGuardCount) : "—"],
      ])
    );
  } else {
    lines.push("_No last tick state._");
  }
  lines.push("");
  lines.push("## Window trades");
  lines.push("");
  lines.push(
    mdTable([
      ["total", String(r.windowTrades.total)],
      ["open", String(r.windowTrades.open)],
      ["closed", String(r.windowTrades.closed)],
      ["with paperRoiAdmission", String(r.windowTrades.withPaperRoiAdmission)],
    ])
  );
  lines.push("");
  lines.push("## Score distribution (window trades)");
  lines.push("");
  lines.push(r.scoreQuantilesRecentCandidates.note);
  lines.push("");
  lines.push(`- **n:** ${r.scoreQuantilesRecentCandidates.count}`);
  lines.push(`- **p50:** ${r.scoreQuantilesRecentCandidates.p50 ?? "—"}`);
  lines.push(`- **p90:** ${r.scoreQuantilesRecentCandidates.p90 ?? "—"}`);
  lines.push(`- **sample (up to 50 sorted):** \`${JSON.stringify(r.scoreQuantilesRecentCandidates.scores)}\``);
  lines.push("");
  lines.push("## Simulated bucket counts (scores vs effective min + configured tiers)");
  lines.push("");
  for (const [k, v] of Object.entries(r.simulatedBucketCountsOnScores).sort((a, b) => b[1] - a[1])) {
    lines.push(`- **${k}:** ${v}`);
  }
  lines.push("");
  lines.push("## Observed opens by size bucket label (metadata)");
  lines.push("");
  for (const [k, v] of Object.entries(r.opensByConfiguredSizeBucket).sort((a, b) => b[1] - a[1])) {
    lines.push(`- **${k}:** ${v}`);
  }
  lines.push("");
  lines.push("## Closed PnL by size bucket (if samples)");
  lines.push("");
  lines.push("| bucket | closed n | mean pnl | hit rate |");
  lines.push("|--------|----------|----------|----------|");
  for (const row of r.closedPnlByScoreBucket) {
    const mp = row.meanPnlPct != null ? `${(row.meanPnlPct * 100).toFixed(2)}%` : "—";
    const hr = row.hitRatePnl != null ? `${(row.hitRatePnl * 100).toFixed(1)}%` : "—";
    lines.push(`| ${row.bucket} | ${row.closedCount} | ${mp} | ${hr} |`);
  }
  lines.push("");
  lines.push("## Spread / slippage (openAttribution / paperRoi)");
  lines.push("");
  lines.push(
    mdTable([
      ["spread n", String(r.spreadSlippage.spreadBps.count)],
      ["spread mean", r.spreadSlippage.spreadBps.mean != null ? r.spreadSlippage.spreadBps.mean.toFixed(2) : "—"],
      ["spread p50", r.spreadSlippage.spreadBps.p50 != null ? String(r.spreadSlippage.spreadBps.p50) : "—"],
      ["spread p90", r.spreadSlippage.spreadBps.p90 != null ? String(r.spreadSlippage.spreadBps.p90) : "—"],
      ["slippage n", String(r.spreadSlippage.slippageBps.count)],
      ["slippage mean", r.spreadSlippage.slippageBps.mean != null ? r.spreadSlippage.slippageBps.mean.toFixed(2) : "—"],
      ["slippage p50", r.spreadSlippage.slippageBps.p50 != null ? String(r.spreadSlippage.slippageBps.p50) : "—"],
      ["slippage p90", r.spreadSlippage.slippageBps.p90 != null ? String(r.spreadSlippage.slippageBps.p90) : "—"],
    ])
  );
  lines.push("");
  lines.push("## Recommendation");
  lines.push("");
  lines.push(r.recommendation.summary);
  lines.push("");
  lines.push("### Caveat");
  lines.push("");
  lines.push(r.recommendation.caveat);
  lines.push("");

  await fs.writeFile(mdPath, lines.join("\n"), "utf8");
  console.log("Wrote", jsonPath);
  console.log("Wrote", mdPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
