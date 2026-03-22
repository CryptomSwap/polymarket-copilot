/**
 * Read-only diagnostic: open PaperTrade rows vs global/per-bot maxOpenTotal from config + effective profiles.
 * Prints JSON to stdout (valid JSON even on DB failure).
 *
 * Run: npx tsx tools/create-paper-open-capacity-debug.ts
 * Docker: docker compose exec -T worker npm run dump:paper-open-capacity-debug > dump/paper-open-capacity-debug.json
 */

import "dotenv/config";
import { prisma } from "../lib/db";
import { getPaperTradingConfig } from "../lib/paper-trading/config";
import { getEffectiveBotProfiles } from "../lib/paper-trading/bot-profiles";

function countMapFromGroupBy(
  rows: { botType: string; _count: { id: number } }[]
): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) {
    m.set(r.botType, r._count.id);
  }
  return m;
}

async function main(): Promise<void> {
  const generatedAt = new Date().toISOString();
  const config = getPaperTradingConfig();
  let profiles: Awaited<ReturnType<typeof getEffectiveBotProfiles>> = [];
  try {
    profiles = await getEffectiveBotProfiles();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.log(
      JSON.stringify(
        {
          generatedAt,
          error: `getEffectiveBotProfiles: ${message}`,
          totals: { openTradesTotal: null },
          byBot: [],
          globalCapacity: {
            maxOpenTotal: config.maxOpenTotal,
            currentOpen: null,
            remaining: null,
          },
          configCapacity: {
            maxOpenTotal: config.maxOpenTotal,
            maxDailyNewTrades: config.maxDailyNewTrades,
          },
          profiles: [],
          sampleOpenTrades: [],
        },
        null,
        2
      )
    );
    return;
  }

  try {
    const [openTradesAll, openByBotRows, openTradesTotal] = await Promise.all([
      prisma.paperTrade.findMany({
        where: { status: "open" },
        select: {
          id: true,
          botType: true,
          assetId: true,
          marketId: true,
          createdAt: true,
        },
        orderBy: { createdAt: "asc" },
      }),
      prisma.paperTrade.groupBy({
        by: ["botType"],
        where: { status: "open" },
        _count: { id: true },
      }),
      prisma.paperTrade.count({ where: { status: "open" } }),
    ]);

    const openByBot = countMapFromGroupBy(openByBotRows);

    const profileBotTypes = new Set(profiles.map((p) => p.botType));
    const extraBotTypes = [...openByBot.keys()].filter((bt) => !profileBotTypes.has(bt)).sort();

    const byBot = [
      ...profiles.map((p) => {
        const openCount = openByBot.get(p.botType) ?? 0;
        const maxOpenTotal = p.maxOpenTotal;
        const remainingCapacity =
          maxOpenTotal > 0 ? Math.max(0, maxOpenTotal - openCount) : null;
        return {
          botType: p.botType,
          openCount,
          maxOpenTotal,
          remainingCapacity,
        };
      }),
      ...extraBotTypes.map((botType) => {
        const openCount = openByBot.get(botType) ?? 0;
        return {
          botType,
          openCount,
          maxOpenTotal: null,
          remainingCapacity: null,
          note: "open trades exist for botType not present in getEffectiveBotProfiles()",
        };
      }),
    ].sort((a, b) => a.botType.localeCompare(b.botType));

    const globalMax = config.maxOpenTotal;
    const globalRemaining =
      globalMax > 0 ? Math.max(0, globalMax - openTradesTotal) : null;

    const sampleOpenTrades = openTradesAll.slice(0, 20).map((r) => ({
      id: r.id,
      botType: r.botType,
      assetId: r.assetId,
      marketId: r.marketId,
      createdAt: r.createdAt.toISOString(),
    }));

    const out = {
      generatedAt,
      totals: {
        openTradesTotal,
      },
      byBot,
      globalCapacity: {
        maxOpenTotal: globalMax,
        currentOpen: openTradesTotal,
        remaining: globalRemaining,
        note:
          globalMax <= 0
            ? "config.maxOpenTotal is 0 — engine treats global open cap as disabled (no limit)."
            : undefined,
      },
      configCapacity: {
        maxOpenTotal: config.maxOpenTotal,
        maxDailyNewTrades: config.maxDailyNewTrades,
      },
      profiles: profiles.map((p) => ({
        botType: p.botType,
        maxOpenTotal: p.maxOpenTotal,
        maxDailyNewTrades: p.maxDailyNewTrades,
      })),
      sampleOpenTrades,
    };

    console.log(JSON.stringify(out, null, 2));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.log(
      JSON.stringify(
        {
          generatedAt,
          error: message,
          totals: { openTradesTotal: null },
          byBot: [],
          globalCapacity: {
            maxOpenTotal: config.maxOpenTotal,
            currentOpen: null,
            remaining: null,
          },
          configCapacity: {
            maxOpenTotal: config.maxOpenTotal,
            maxDailyNewTrades: config.maxDailyNewTrades,
          },
          profiles: profiles.map((p) => ({
            botType: p.botType,
            maxOpenTotal: p.maxOpenTotal,
            maxDailyNewTrades: p.maxDailyNewTrades,
          })),
          sampleOpenTrades: [],
        },
        null,
        2
      )
    );
  }
}

main().catch((e) => {
  const message = e instanceof Error ? e.message : String(e);
  let cfg: ReturnType<typeof getPaperTradingConfig> | null = null;
  try {
    cfg = getPaperTradingConfig();
  } catch {
    // ignore
  }
  console.log(
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        error: message,
        totals: { openTradesTotal: null },
        byBot: [],
        globalCapacity: {
          maxOpenTotal: cfg?.maxOpenTotal ?? null,
          currentOpen: null,
          remaining: null,
        },
        configCapacity: cfg
          ? { maxOpenTotal: cfg.maxOpenTotal, maxDailyNewTrades: cfg.maxDailyNewTrades }
          : null,
        profiles: [],
        sampleOpenTrades: [],
      },
      null,
      2
    )
  );
  process.exit(1);
});
