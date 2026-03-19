/**
 * Execution realism gap report: are we learning forecast quality vs trade quality?
 * Outputs: dump/ml-execution-realism-gap-report.json, dump/ml-execution-realism-gap-report.md
 */

import * as fs from "fs";
import * as path from "path";

const DUMP_DIR = path.join(process.cwd(), "dump");

const GAP_REPORT = {
  generatedAt: new Date().toISOString(),
  summary: "Labels are based on mark-to-market price movement (markout). Execution realism (spread, fill, slippage) is not yet reflected in labels.",
  gaps: [
    {
      area: "spread_realism",
      description: "Entry/exit assume mid price. Real fills are at bid/ask; spread cost not in label.",
      severity: "medium",
      suggestedAction: "Add spread at decision time and at horizon to label (e.g. labelSpreadAdjustedGoodDecision12h).",
    },
    {
      area: "liquidity_realism",
      description: "Label does not condition on whether size could be filled at observed price. Thin books may prevent fill.",
      severity: "medium",
      suggestedAction: "Segment by liquidity band; consider realizable volume in outcome.",
    },
    {
      area: "fill_realism",
      description: "Paper and backtest assume full fill at entry price. Partial fills and rejections not modeled.",
      severity: "high",
      suggestedAction: "Use fill-ledger or order outcome when available; else document as limitation.",
    },
    {
      area: "slippage_assumptions",
      description: "No slippage applied to entry or exit in markout. Slippage can flip sign of small edge.",
      severity: "medium",
      suggestedAction: "Apply conservative slippage (e.g. spread/2) in backtest; add slippage-adjusted label if data allows.",
    },
    {
      area: "entry_execution_assumptions",
      description: "Decision snapshot time = assumed execution time. Latency and queue position not modeled.",
      severity: "low",
      suggestedAction: "Document; consider timestamp of first fill when available.",
    },
    {
      area: "exit_assumptions",
      description: "12h/24h markout uses single price at horizon. No exit execution cost or timing within window.",
      severity: "medium",
      suggestedAction: "Use exit spread or TWAP-style exit assumption for realizable PnL.",
    },
    {
      area: "label_interpretation",
      description: "Current label measures 'price was right' (favorable move) not 'trade was realistically good' (after costs and fill).",
      severity: "high",
      suggestedAction: "Add execution-aware targets (e.g. labelRealizablePnlPositive12h) when data allows.",
    },
  ],
  additiveDesignPlan: [
    "1. Keep current markout-based labels as primary; add spread-adjusted and realizable-PnL as optional targets.",
    "2. Attach execution-quality snapshot (spread, depth) to training rows for segmenting.",
    "3. In evaluation, segment by spread band and liquidity band; report metrics per segment.",
    "4. Do not change live execution or safety rules; improve labels and evaluation only.",
  ],
};

function ensureDumpDir(): void {
  if (!fs.existsSync(DUMP_DIR)) fs.mkdirSync(DUMP_DIR, { recursive: true });
}

function main(): void {
  ensureDumpDir();
  const jsonPath = path.join(DUMP_DIR, "ml-execution-realism-gap-report.json");
  const mdPath = path.join(DUMP_DIR, "ml-execution-realism-gap-report.md");
  fs.writeFileSync(jsonPath, JSON.stringify(GAP_REPORT, null, 2), "utf-8");
  console.log(`Wrote ${jsonPath}`);
  const md = [
    "# ML Execution Realism Gap Report",
    "",
    `Generated: ${GAP_REPORT.generatedAt}`,
    "",
    "## Summary",
    GAP_REPORT.summary,
    "",
    "## Gaps",
    "| Area | Description | Severity | Suggested action |",
    "|------|-------------|----------|-------------------|",
    ...GAP_REPORT.gaps.map(
      (g) => `| ${g.area} | ${g.description} | ${g.severity} | ${g.suggestedAction} |`
    ),
    "",
    "## Additive design plan",
    ...GAP_REPORT.additiveDesignPlan.map((s) => `- ${s}`),
    "",
  ].join("\n");
  fs.writeFileSync(mdPath, md, "utf-8");
  console.log(`Wrote ${mdPath}`);
}

main();
