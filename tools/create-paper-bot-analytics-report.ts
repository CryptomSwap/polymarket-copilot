/**
 * Paper bot analytics report: per-bot stats and bot overlap summary.
 * Run: npx tsx tools/create-paper-bot-analytics-report.ts
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { getPerBotAnalytics, getBotOverlapReport } from "../lib/paper-trading/analytics";
import { BOT_PROFILES } from "../lib/paper-trading/bot-profiles";
import { getPaperTradingConfig } from "../lib/paper-trading/config";

const DUMP_DIR = path.join(process.cwd(), "dump");

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });
  const timestamp = new Date().toISOString();

  const globalConfig = getPaperTradingConfig();
  const perBot = await getPerBotAnalytics();
  const overlap = await getBotOverlapReport();

  const report = {
    generatedAt: timestamp,
    globalConfig,
    profiles: BOT_PROFILES,
    perBot,
    overlap,
  };

  const jsonPath = path.join(DUMP_DIR, "paper-bot-analytics-report.json");
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");

  const md: string[] = [];
  md.push("# Paper bot analytics report");
  md.push("");
  md.push(`Generated: ${timestamp}`);
  md.push("");
  md.push("## Profiles");
  md.push("");
  md.push("| botType | displayName | enabled | targetLabel | threshold |");
  md.push("|---------|------------|---------|-------------|-----------|");
  for (const p of BOT_PROFILES) {
    md.push(
      `| ${p.botType} | ${p.displayName} | ${p.enabled ? "yes" : "no"} | ${p.targetLabel ?? "-"} | ${p.threshold ?? globalConfig.threshold} |`
    );
  }
  md.push("");
  md.push("## Per-bot stats");
  md.push("");
  md.push(
    "| botType | total | open | closed | winRate | avgPnlPct | medianPnlPct | cumPnlPct | avgScore | avgThresholdGap |"
  );
  md.push(
    "|---------|-------|------|--------|---------|-----------|--------------|-----------|----------|-----------------|"
  );
  for (const b of perBot) {
    md.push(
      `| ${b.botType} | ${b.totalTrades} | ${b.openTrades} | ${b.closedTrades} | ${b.winRate ?? "-"} | ${b.averagePnlPct ?? "-"} | ${b.medianPnlPct ?? "-"} | ${b.cumulativePnlPct ?? "-"} | ${b.averageScore ?? "-"} | ${b.averageThresholdGap ?? "-"} |`
    );
  }

  md.push("");
  md.push("## Segmentation (entryPriceBand / policy / relaxation / theme / category / targetLabel)");
  md.push("");
  for (const b of perBot) {
    md.push(`### Bot ${b.botType}`);
    md.push("");
    md.push("**Entry price band counts**");
    md.push("");
    md.push("```json");
    md.push(JSON.stringify(b.byEntryPriceBand, null, 2));
    md.push("```");
    md.push("");
    md.push("**Paper policy mode counts**");
    md.push("");
    md.push("```json");
    md.push(JSON.stringify(b.byPaperPolicyMode, null, 2));
    md.push("```");
    md.push("");
    md.push("**Paper relaxation reason counts**");
    md.push("");
    md.push("```json");
    md.push(JSON.stringify(b.byPaperRelaxationReason, null, 2));
    md.push("```");
    md.push("");
    md.push("**Theme counts**");
    md.push("");
    md.push("```json");
    md.push(JSON.stringify(b.byTheme, null, 2));
    md.push("```");
    md.push("");
    md.push("**Category counts**");
    md.push("");
    md.push("```json");
    md.push(JSON.stringify(b.byCategory, null, 2));
    md.push("```");
    md.push("");
    md.push("**Target label distribution**");
    md.push("");
    md.push("```json");
    md.push(JSON.stringify(b.byTargetLabel, null, 2));
    md.push("```");
    md.push("");
  }

  md.push("");
  md.push("## Bot overlap");
  md.push("");
  md.push("| botA | botB | sameMarketCount | sameAssetSideCount |");
  md.push("|------|------|-----------------|--------------------|");
  for (const o of overlap) {
    md.push(
      `| ${o.botA} | ${o.botB} | ${o.sameMarketCount} | ${o.sameAssetSideCount} |`
    );
  }

  const mdPath = path.join(DUMP_DIR, "paper-bot-analytics-report.md");
  await fs.writeFile(mdPath, md.join("\n"), "utf8");

  console.log("Wrote", jsonPath);
  console.log("Wrote", mdPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

