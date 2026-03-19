/**
 * Paper bot governance report: profiles, overrides, effective configs, and recent trade provenance.
 * Run: npx tsx tools/create-paper-bot-governance-report.ts
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import { BOT_PROFILES, getEffectiveBotProfiles } from "../lib/paper-trading/bot-profiles";

const DUMP_DIR = path.join(process.cwd(), "dump");

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });
  const timestamp = new Date().toISOString();

  const effective = await getEffectiveBotProfiles();

  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const recentTrades = await prisma.paperTrade.findMany({
    where: { createdAt: { gte: since } },
    select: { botType: true, botVersion: true, profileSnapshotJson: true },
  });

  const tradeCountsByBotVersion: Record<string, Record<string, number>> = {};
  const tradeCountsByProfileSnapshot: Record<string, number> = {};

  for (const t of recentTrades) {
    const bot = t.botType ?? "default";
    const version = t.botVersion ?? "unknown";
    if (!tradeCountsByBotVersion[bot]) tradeCountsByBotVersion[bot] = {};
    tradeCountsByBotVersion[bot][version] =
      (tradeCountsByBotVersion[bot][version] ?? 0) + 1;

    if (t.profileSnapshotJson) {
      tradeCountsByProfileSnapshot[t.profileSnapshotJson] =
        (tradeCountsByProfileSnapshot[t.profileSnapshotJson] ?? 0) + 1;
    }
  }

  const report = {
    generatedAt: timestamp,
    profilesCodeDefined: BOT_PROFILES,
    profilesEffective: effective,
    tradeCountsByBotVersion,
    tradeCountsByProfileSnapshot,
  };

  const jsonPath = path.join(DUMP_DIR, "paper-bot-governance-report.json");
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");

  const md: string[] = [];
  md.push("# Paper bot governance report");
  md.push("");
  md.push(`Generated: ${timestamp}`);
  md.push("");
  md.push("## Effective profiles");
  md.push("");
  md.push(
    "| botType | displayName | effectiveEnabled | botVersion | targetLabel | threshold | minScoreBuffer | cooldownHours | maxOpenTotal | overrideSource |"
  );
  md.push(
    "|---------|------------|------------------|------------|-------------|-----------|----------------|--------------|--------------|---------------|"
  );
  for (const p of effective) {
    md.push(
      `| ${p.botType} | ${p.displayName} | ${p.effectiveEnabled ? "yes" : "no"} | ${p.botVersion ?? "-"} | ${p.targetLabel ?? "-"} | ${p.threshold} | ${p.minScoreBuffer} | ${p.cooldownHours} | ${p.maxOpenTotal} | ${p.overrideSource ?? "-"} |`
    );
  }

  md.push("");
  md.push("## Recent trade counts by botVersion (last 30d)");
  md.push("");
  md.push("```json");
  md.push(JSON.stringify(tradeCountsByBotVersion, null, 2));
  md.push("```");

  md.push("");
  md.push("## Profile snapshot provenance (last 30d)");
  md.push("");
  md.push("```json");
  md.push(JSON.stringify(tradeCountsByProfileSnapshot, null, 2));
  md.push("```");

  const mdPath = path.join(DUMP_DIR, "paper-bot-governance-report.md");
  await fs.writeFile(mdPath, md.join("\n"), "utf8");

  console.log("Wrote", jsonPath);
  console.log("Wrote", mdPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

