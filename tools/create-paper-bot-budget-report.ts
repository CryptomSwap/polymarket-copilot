/**
 * Paper bot budget allocator report v1.
 * Outputs: dump/paper-bot-budget-report.json, dump/paper-bot-budget-report.md
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { getEffectiveBotProfiles } from "../lib/paper-trading/bot-profiles";
import {
  getPerBotAnalytics,
  getBotOverlapReport,
} from "../lib/paper-trading/analytics";
import {
  computeBotBudgets,
  BOT_BUDGET_ALLOCATOR_VERSION,
} from "../lib/paper-trading/bot-budget-allocator";
import { enablePaperBotBudgetAllocatorV1 } from "../lib/ml/config";

const DUMP_DIR = path.join(process.cwd(), "dump");

function nowMinusDays(days: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d;
}

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });
  const timestamp = new Date().toISOString();
  const featureFlag = enablePaperBotBudgetAllocatorV1();

  const lookbackDays = 30;
  const from = nowMinusDays(lookbackDays);

  const [profiles, analytics, overlap, budgets] = await Promise.all([
    getEffectiveBotProfiles(),
    getPerBotAnalytics({ from }),
    getBotOverlapReport({ from }),
    computeBotBudgets({ lookbackDays }),
  ]);

  const analyticsByBot: Record<string, (typeof analytics)[number]> = {};
  for (const a of analytics) analyticsByBot[a.botType] = a;

  const report = {
    generatedAt: timestamp,
    allocatorVersion: BOT_BUDGET_ALLOCATOR_VERSION,
    featureFlagEnabled: featureFlag,
    lookbackDays,
    lookbackFrom: from.toISOString(),
    activeBots: profiles.map((p) => ({
      botType: p.botType,
      displayName: p.displayName,
      effectiveEnabled: p.effectiveEnabled,
      targetLabel: p.targetLabel,
      botVersion: p.botVersion,
      maxDailyNewTrades: p.maxDailyNewTrades,
    })),
    recentMetricsByBot: Object.fromEntries(
      Object.entries(analyticsByBot).map(([botType, a]) => [
        botType,
        {
          totalTrades: a.totalTrades,
          openTrades: a.openTrades,
          closedTrades: a.closedTrades,
          winRate: a.winRate,
          averagePnlPct: a.averagePnlPct,
          medianPnlPct: a.medianPnlPct,
          cumulativePnlPct: a.cumulativePnlPct,
        },
      ])
    ),
    overlapSummary: overlap,
    budgets,
  };

  const jsonPath = path.join(DUMP_DIR, "paper-bot-budget-report.json");
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");

  const md: string[] = [];
  md.push("# Paper bot budget allocator report");
  md.push("");
  md.push(`Generated: ${timestamp}`);
  md.push("");
  md.push(`Allocator version: \`${BOT_BUDGET_ALLOCATOR_VERSION}\``);
  md.push(
    `Feature flag ENABLE_PAPER_BOT_BUDGET_ALLOCATOR_V1: ${
      featureFlag ? "enabled" : "disabled"
    }`
  );
  md.push("");
  md.push(`Lookback window: last ${lookbackDays} days (from ${from.toISOString()})`);
  md.push("");
  md.push("## Active bots");
  md.push("");
  md.push(
    "| botType | displayName | enabled | targetLabel | botVersion | maxDailyNewTrades |"
  );
  md.push(
    "|---------|------------|---------|-------------|------------|-------------------|"
  );
  for (const p of profiles) {
    md.push(
      `| ${p.botType} | ${p.displayName} | ${
        p.effectiveEnabled ? "yes" : "no"
      } | ${p.targetLabel ?? "-"} | ${p.botVersion ?? "-"} | ${
        p.maxDailyNewTrades
      } |`
    );
  }

  md.push("");
  md.push("## Budgets");
  md.push("");
  md.push(
    "| botType | rank | budgetWeight | maxNewTradesToday | closedTrades | winRate | avgPnlPct | cumPnlPct | overlap | reasons |"
  );
  md.push(
    "|---------|------|--------------|-------------------|--------------|---------|-----------|-----------|---------|---------|"
  );
  for (const b of budgets) {
    md.push(
      `| ${b.botType} | ${b.rank} | ${b.budgetWeight.toFixed(
        3
      )} | ${b.maxNewTradesToday} | ${b.metrics.closedTrades} | ${
        b.metrics.winRate != null ? (b.metrics.winRate * 100).toFixed(1) + "%" : "n/a"
      } | ${
        b.metrics.averagePnlPct != null
          ? (b.metrics.averagePnlPct * 100).toFixed(2) + "%"
          : "n/a"
      } | ${
        b.metrics.cumulativePnlPct != null
          ? (b.metrics.cumulativePnlPct * 100).toFixed(2) + "%"
          : "n/a"
      } | ${b.metrics.overlapScore.toFixed(2)} | ${b.reasonSummary} |`
    );
  }

  md.push("");
  md.push("## Overlap summary");
  md.push("");
  if (overlap.length === 0) {
    md.push("No overlapping markets or asset/sides in lookback window.");
  } else {
    md.push("| botA | botB | sameMarkets | sameAssetSide |");
    md.push("|------|------|------------|---------------|");
    for (const o of overlap) {
      md.push(
        `| ${o.botA} | ${o.botB} | ${o.sameMarketCount} | ${o.sameAssetSideCount} |`
      );
    }
  }

  const mdPath = path.join(DUMP_DIR, "paper-bot-budget-report.md");
  await fs.writeFile(mdPath, md.join("\n"), "utf8");

  console.log("Wrote", jsonPath);
  console.log("Wrote", mdPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

