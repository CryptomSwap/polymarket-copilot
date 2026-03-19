/**
 * Paper decision controls summary report.
 * Outputs: dump/paper-control-summary-report.json, dump/paper-control-summary-report.md
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { getPaperTradingControlSummary } from "../lib/paper-trading/control-summary";

const DUMP_DIR = path.join(process.cwd(), "dump");

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });
  const timestamp = new Date().toISOString();

  const bots = await getPaperTradingControlSummary();

  const report = {
    generatedAt: timestamp,
    bots,
  };

  const jsonPath = path.join(DUMP_DIR, "paper-control-summary-report.json");
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");

  const md: string[] = [];
  md.push("# Paper decision controls summary");
  md.push("");
  md.push(`Generated: ${timestamp}`);
  md.push("");
  md.push(
    "| botType | thresholdAdmissions | explorationAdmissions | challengerCoverageCount | challengerCoveragePct | budgetRank | budgetWeight | maxNewTradesToday | lastTickOpened | lastTickRejectedByBudgetCount | constrainedByBudget |"
  );
  md.push(
    "|---------|----------------------|-----------------------|-------------------------|------------------------|------------|-------------|-------------------|---------------|-------------------------------|---------------------|"
  );

  for (const b of bots) {
    md.push(
      `| ${b.botType} | ${b.thresholdAdmissions} | ${b.explorationAdmissions} | ${b.challengerCoverageCount} | ${
        b.challengerCoveragePct != null ? (b.challengerCoveragePct * 100).toFixed(1) + "%" : "n/a"
      } | ${b.budgetRank ?? "n/a"} | ${
        b.budgetWeight != null ? b.budgetWeight.toFixed(3) : "n/a"
      } | ${b.maxNewTradesToday ?? "n/a"} | ${b.lastTickOpened ?? "n/a"} | ${
        b.lastTickRejectedByBudgetCount ?? 0
      } | ${
        b.constrainedByBudget != null ? (b.constrainedByBudget ? "yes" : "no") : "n/a"
      } |`
    );
  }

  md.push("");
  md.push("## Operator notes");
  md.push("");
  md.push(
    "- **Threshold vs exploration**: thresholdAdmissions uses explorationAdmissionMode=threshold (or null) and explorationAdmissions uses explorationAdmissionMode=exploration."
  );
  md.push(
    "- **Challenger coverage**: counts trades with challengerAvailable=true and coveragePct is relative to total trades in the lookback window."
  );
  md.push(
    "- **Budget**: budgetRank/weight/cap and constrainedByBudget are derived from the paper-only budget allocator v1 and last open tick diagnostics."
  );

  const mdPath = path.join(DUMP_DIR, "paper-control-summary-report.md");
  await fs.writeFile(mdPath, md.join("\n"), "utf8");

  console.log("Wrote", jsonPath);
  console.log("Wrote", mdPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

