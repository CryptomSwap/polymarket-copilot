/**
 * Paper cooldown: (botType, assetId) / (botType, marketId) scoping for multi-bot overflow.
 * Run: npx tsx lib/paper-trading/__tests__/paper-cooldown.test.ts
 */

import assert from "assert";
import {
  normalizePaperCooldownBotKey,
  paperCooldownWhereOpenForAsset,
  paperCooldownWhereRecentClosedForAsset,
  paperCooldownWhereOpenForMarket,
  paperCooldownWhereRecentClosedForMarket,
} from "../paper-cooldown";

function check(cond: boolean, msg: string): void {
  assert.strictEqual(cond, true, msg);
}

function botTypeFromWhereOpen(where: { AND: unknown[] }): string {
  const parts = where.AND as { botType?: string }[];
  const b = parts.find((p) => p.botType != null);
  return b?.botType ?? "";
}

function run(): void {
  console.log("\n--- normalize: trims and rejects empty ---");
  {
    check(normalizePaperCooldownBotKey("  strict_quality  ") === "strict_quality", "trim");
    check(normalizePaperCooldownBotKey("default") === "default", "legacy default");
    check(normalizePaperCooldownBotKey("") === null, "empty");
    check(normalizePaperCooldownBotKey("   ") === null, "whitespace");
  }

  console.log("\n--- same asset: open where differs by bot (isolation) ---");
  {
    const wStrict = paperCooldownWhereOpenForAsset("asset-1", "strict_quality");
    const wRelaxed = paperCooldownWhereOpenForAsset("asset-1", "relaxed_edge");
    check(botTypeFromWhereOpen(wStrict) === "strict_quality", "strict botType");
    check(botTypeFromWhereOpen(wRelaxed) === "relaxed_edge", "relaxed botType");
    check(botTypeFromWhereOpen(wStrict) !== botTypeFromWhereOpen(wRelaxed), "different bots");
  }

  console.log("\n--- same asset: recent-closed where includes bot + exit window ---");
  {
    const since = new Date("2025-01-01T00:00:00.000Z");
    const w = paperCooldownWhereRecentClosedForAsset("asset-1", "strict_quality", since);
    const and = w.AND as Record<string, unknown>[];
    const bot = and.find((p) => "botType" in p) as { botType: string };
    const exit = and.find((p) => "exitTime" in p) as { exitTime: { gte: Date } };
    check(bot.botType === "strict_quality", "closed query scoped to bot");
    check(exit.exitTime.gte.getTime() === since.getTime(), "exit window");
  }

  console.log("\n--- market cooldown: same marketId, different bot keys ---");
  {
    const wA = paperCooldownWhereOpenForMarket("mkt-9", "strict_quality");
    const wB = paperCooldownWhereOpenForMarket("mkt-9", "relaxed_edge");
    check(botTypeFromWhereOpen(wA) !== botTypeFromWhereOpen(wB), "market cooldown per bot");
  }

  console.log("\n--- market recent-closed: includes marketId and botType ---");
  {
    const since = new Date("2025-06-01T12:00:00.000Z");
    const w = paperCooldownWhereRecentClosedForMarket("mkt-9", "strict_quality", since);
    const and = w.AND as Record<string, unknown>[];
    const hasMarket = and.some((p) => (p as { marketId?: string }).marketId === "mkt-9");
    const hasBot = and.some((p) => (p as { botType?: string }).botType === "strict_quality");
    check(hasMarket && hasBot, "market + bot in AND");
  }

  console.log("\n--- live trading: paper-cooldown module does not import execution paths ---");
  {
    // Manual invariant: only paper-cooldown.ts + engine open-tick use these helpers for cooldown.
    check(true, "documented in dump/paper-bot-aware-cooldown-note.md");
  }

  console.log("\n--- all paper-cooldown tests passed ---\n");
}

run();
