/**
 * Read-only: paper per-bot open cap vs global cap and live open counts.
 *
 * Engine rule (multi-bot): `maxOpenTotal = profile.maxOpenTotal ?? config.maxOpenTotal`, then
 * `openCount(botType) + openedThisTick >= maxOpenTotal` → `rejectReasonCode: max_open_total`.
 * There is no min(global, per-bot); an explicit profile cap replaces the global fallback for that bot.
 *
 * Writes:
 * - dump/paper-bot-cap-snapshot.json
 * - dump/paper-bot-cap-snapshot.md
 *
 * Run: npx tsx tools/create-paper-bot-cap-snapshot.ts
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import { getPaperTradingConfig } from "../lib/paper-trading/config";
import { BOT_PROFILES, getEffectiveBotProfiles } from "../lib/paper-trading/bot-profiles";

const DUMP_DIR = path.join(process.cwd(), "dump");
const JSON_PATH = path.join(DUMP_DIR, "paper-bot-cap-snapshot.json");
const MD_PATH = path.join(DUMP_DIR, "paper-bot-cap-snapshot.md");

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });

  const global = getPaperTradingConfig();
  const engineRule =
    "Multi-bot `lib/paper-trading/engine.ts`: `maxOpenTotal = profile.maxOpenTotal ?? config.maxOpenTotal`; gate uses `prisma.paperTrade.count({ status: open, botType }) + openedForBot >= maxOpenTotal`. Legacy single-bot path uses global `config.maxOpenTotal` only.";

  const mergeRule =
    "`getEffectiveBotProfiles` (`lib/paper-trading/bot-profiles.ts`): `maxOpenTotal: p.maxOpenTotal ?? global.maxOpenTotal`. Optimizer file overrides do not include maxOpenTotal.";

  let dbAvailable = true;
  let dbError: string | null = null;
  let openByBot: Record<string, number> = {};

  try {
    const grouped = await prisma.paperTrade.groupBy({
      by: ["botType"],
      where: { status: "open" },
      _count: { id: true },
    });
    for (const row of grouped) {
      openByBot[row.botType] = row._count.id;
    }
  } catch (e) {
    dbAvailable = false;
    dbError = e instanceof Error ? e.message : String(e);
  }

  const effectiveProfiles = await getEffectiveBotProfiles();

  const perBot = effectiveProfiles.map((eff) => {
    const raw = BOT_PROFILES.find((p) => p.botType === eff.botType);
    const configuredMax = raw?.maxOpenTotal;
    const inheritsGlobal = configuredMax == null || configuredMax === undefined;
    const effectiveMax = eff.maxOpenTotal;
    const open = openByBot[eff.botType] ?? 0;
    const atCapNow = effectiveMax > 0 && open >= effectiveMax;
    return {
      botType: eff.botType,
      displayName: eff.displayName,
      effectiveEnabled: eff.effectiveEnabled,
      configuredMaxOpenTotalInProfileFile: configuredMax ?? null,
      inheritsGlobalMaxOpenTotal: inheritsGlobal,
      effectiveMaxOpenTotalUsedByEngine: effectiveMax,
      currentOpenCount: dbAvailable ? open : null,
      atCapNow: dbAvailable ? atCapNow : null,
      maxDailyNewTrades: eff.maxDailyNewTrades,
      cooldownHours: eff.cooldownHours,
      cooldownMarketHours: eff.cooldownMarketHours,
    };
  });

  const enabledAtCap = perBot.filter((b) => b.effectiveEnabled && b.atCapNow === true);
  const totalOpen = Object.values(openByBot).reduce((a, b) => a + b, 0);
  const globalMax = global.maxOpenTotal;

  const anyEnabledBotAtPerBotCap = enabledAtCap.length > 0;
  const atGlobalAggregateCap = globalMax > 0 && totalOpen >= globalMax;

  const diagnosis = {
    maxOpenTotalRejectsLikelyFrom:
      anyEnabledBotAtPerBotCap
        ? "per_bot_cap (one or more bots have open count >= that bot's effectiveMaxOpenTotal; same reject code as global)"
        : atGlobalAggregateCap
          ? "possible_global_or_other (total open ≥ global maxOpenTotal; legacy path uses global only; multi-bot checks per-bot first)"
          : "not_at_cap_by_snapshot_counts (re-run after tick if diagnosing rejects)",
    botsCurrentlyPinnedAtCap: enabledAtCap.map((b) => b.botType),
    totalOpenAllBots: dbAvailable ? totalOpen : null,
    globalMaxOpenTotal: globalMax,
    note:
      "Same `rejectReasonCode` for global vs per-bot. Compare `currentOpenCount` to `effectiveMaxOpenTotalUsedByEngine` per bot; relaxed concentration overload also uses `max_open_total` but tick sets `loadDiagnostics.relaxedConcentrationRejectedByCap` when that path fires.",
  };

  const report = {
    generatedAt: new Date().toISOString(),
    dbAvailable,
    dbError,
    globalConfig: {
      maxOpenTotal: global.maxOpenTotal,
    },
    engineOpenCapRule: engineRule,
    profileMergeRule: mergeRule,
    perBot,
    diagnosis,
  };

  await fs.writeFile(JSON_PATH, JSON.stringify(report, null, 2), "utf8");

  const md: string[] = [
    "# Paper bot open-cap snapshot",
    "",
    `Generated: \`${report.generatedAt}\` · DB: **${dbAvailable ? "ok" : "unavailable"}**${dbError ? ` (${dbError})` : ""}`,
    "",
    "## Global config",
    "",
    `- **maxOpenTotal:** ${global.maxOpenTotal}`,
    "",
    "## Engine / merge rules",
    "",
    report.engineOpenCapRule,
    "",
    report.profileMergeRule,
    "",
    "## Per bot",
    "",
    "| botType | enabled | profile maxOpenTotal | effective max | open | atCap |",
    "|---------|---------|----------------------|---------------|------|-------|",
  ];

  for (const b of perBot) {
    md.push(
      `| ${b.botType} | ${b.effectiveEnabled} | ${b.configuredMaxOpenTotalInProfileFile ?? "— (inherit)"} | ${b.effectiveMaxOpenTotalUsedByEngine} | ${b.currentOpenCount ?? "—"} | ${b.atCapNow === true ? "yes" : b.atCapNow === false ? "no" : "—"} |`
    );
  }

  md.push("", "## Diagnosis", "", JSON.stringify(diagnosis, null, 2), "");
  await fs.writeFile(MD_PATH, md.join("\n"), "utf8");

  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
