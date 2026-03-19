/**
 * Paper bot profile report: active profiles, config, and per-bot open/closed counts.
 * Run: npx tsx tools/create-paper-bot-profile-report.ts
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import { getPaperTradingConfig } from "../lib/paper-trading/config";
import { BOT_PROFILES, getActiveBotProfiles } from "../lib/paper-trading/bot-profiles";

const DUMP_DIR = path.join(process.cwd(), "dump");

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });
  const timestamp = new Date().toISOString();

  const globalConfig = getPaperTradingConfig();
  const activeProfiles = getActiveBotProfiles();

  const botTypes = BOT_PROFILES.map((p) => p.botType);
  const counts = await prisma.paperTrade.groupBy({
    by: ["botType", "status"],
    where: { botType: { in: botTypes } },
    _count: { id: true },
  });

  const perBotCounts: Record<string, { open: number; closed: number; total: number }> =
    {};
  for (const p of BOT_PROFILES) {
    perBotCounts[p.botType] = { open: 0, closed: 0, total: 0 };
  }
  for (const row of counts) {
    const botType = (row.botType ?? "default") as string;
    if (!perBotCounts[botType]) {
      perBotCounts[botType] = { open: 0, closed: 0, total: 0 };
    }
    const n = row._count.id;
    perBotCounts[botType].total += n;
    if (row.status === "open") perBotCounts[botType].open += n;
    if (row.status === "closed") perBotCounts[botType].closed += n;
  }

  const report = {
    timestamp,
    globalConfig,
    profiles: BOT_PROFILES.map((p) => ({
      botType: p.botType,
      displayName: p.displayName,
      enabled: p.enabled,
      targetLabel: p.targetLabel ?? null,
      botVersion: p.botVersion ?? null,
      threshold: p.threshold ?? globalConfig.threshold,
      minScoreBuffer: p.minScoreBuffer ?? globalConfig.minScoreBuffer,
      cooldownHours: p.cooldownHours ?? globalConfig.cooldownHours,
      cooldownMarketHours: p.cooldownMarketHours ?? globalConfig.cooldownMarketHours,
      maxOpenTotal: p.maxOpenTotal ?? globalConfig.maxOpenTotal,
      maxOpenPerMarket: p.maxOpenPerMarket ?? globalConfig.maxOpenPerMarket,
      maxOpenPerTheme: p.maxOpenPerTheme ?? globalConfig.maxOpenPerTheme,
      maxOpenPerCategory: p.maxOpenPerCategory ?? globalConfig.maxOpenPerCategory,
      maxDailyNewTrades: p.maxDailyNewTrades ?? globalConfig.maxDailyNewTrades,
      allowReviewRequired: p.allowReviewRequired ?? false,
      allowPaperRelaxation: p.allowPaperRelaxation ?? true,
      allowRelaxationReasons: p.allowRelaxationReasons ?? null,
      allowedPolicyStates: p.allowedPolicyStates ?? null,
      allowedPriceBands: p.allowedPriceBands ?? null,
      excludedThemes: p.excludedThemes ?? [],
      excludedCategories: p.excludedCategories ?? [],
      notes: p.notes ?? null,
      counts: perBotCounts[p.botType] ?? { open: 0, closed: 0, total: 0 },
    })),
    activeProfileBotTypes: activeProfiles.map((p) => p.botType),
  };

  const jsonPath = path.join(DUMP_DIR, "paper-bot-profile-report.json");
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");

  const mdLines: string[] = [];
  mdLines.push("# Paper bot profiles");
  mdLines.push("");
  mdLines.push("**Generated:** " + timestamp);
  mdLines.push("");
  mdLines.push("## Profiles");
  mdLines.push("");
  mdLines.push(
    "| botType | displayName | enabled | threshold | minScoreBuffer | cooldownHours | maxOpenTotal | open | closed | total |"
  );
  mdLines.push(
    "|---------|------------|---------|-----------|----------------|---------------|--------------|------|--------|-------|"
  );
  for (const p of report.profiles) {
    mdLines.push(
      `| ${p.botType} | ${p.displayName} | ${
        p.enabled ? "yes" : "no"
      } | ${p.threshold} | ${p.minScoreBuffer} | ${p.cooldownHours} | ${
        p.maxOpenTotal
      } | ${p.counts.open} | ${p.counts.closed} | ${p.counts.total} |`
    );
  }
  mdLines.push("");
  mdLines.push("## Global config snapshot");
  mdLines.push("");
  mdLines.push("```json");
  mdLines.push(JSON.stringify(globalConfig, null, 2));
  mdLines.push("```");

  const mdPath = path.join(DUMP_DIR, "paper-bot-profile-report.md");
  await fs.writeFile(mdPath, mdLines.join("\n"), "utf8");

  console.log("Wrote", jsonPath);
  console.log("Wrote", mdPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

