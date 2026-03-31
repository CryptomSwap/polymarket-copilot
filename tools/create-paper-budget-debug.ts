/**
 * Read-only paper trading budget / `budget_cap` forensics.
 *
 * Traces how the daily new-trade limit is computed (engine.ts), compares diagnostics vs effective caps,
 * and dumps DB-backed counts. No mutations.
 *
 * Writes: dump/paper-budget-debug.json
 *
 * Run: npx tsx tools/create-paper-budget-debug.ts
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import { getPaperTradingConfig } from "../lib/paper-trading/config";
import { getEffectiveBotProfiles } from "../lib/paper-trading/bot-profiles";
import { computeBotBudgets } from "../lib/paper-trading/bot-budget-allocator";
import { enablePaperBotBudgetAllocatorV1 } from "../lib/ml/config";

const DUMP_DIR = path.join(process.cwd(), "dump");
const OUT_JSON = path.join(DUMP_DIR, "paper-budget-debug.json");

function utcStartOfDay(d: Date): Date {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });

  const now = new Date();
  const todayStart = utcStartOfDay(now);
  const msSinceReset = now.getTime() - todayStart.getTime();
  const hoursSinceReset = Math.round((msSinceReset / (60 * 60 * 1000)) * 1000) / 1000;

  const config = getPaperTradingConfig();
  const budgetAllocatorEnabled = enablePaperBotBudgetAllocatorV1();

  const state = await prisma.paperTradingState.findUnique({ where: { id: "default" } });
  let lastTickBudgetEcho: Record<string, unknown> | null = null;
  if (state?.lastOpenTickResultJson) {
    try {
      const tick = JSON.parse(state.lastOpenTickResultJson) as Record<string, unknown>;
      const per = tick.perBotResults as Record<string, Record<string, unknown>> | undefined;
      if (per && typeof per === "object") {
        const echo: Record<string, unknown> = {};
        for (const [bot, row] of Object.entries(per)) {
          echo[bot] = row?.budgetDecision ?? null;
        }
        lastTickBudgetEcho = echo;
      }
    } catch {
      lastTickBudgetEcho = { parseError: true };
    }
  }

  const tradesOpenedTodayGlobal = await prisma.paperTrade.count({
    where: { createdAt: { gte: todayStart } },
  });

  const profiles = await getEffectiveBotProfiles();
  let budgetDecisions: Awaited<ReturnType<typeof computeBotBudgets>> = [];
  let allocatorComputeError: string | null = null;
  if (budgetAllocatorEnabled) {
    try {
      budgetDecisions = await computeBotBudgets({ lookbackDays: 30 });
    } catch (e) {
      budgetDecisions = [];
      allocatorComputeError = e instanceof Error ? e.message : String(e);
    }
  }
  const decisionByBot = Object.fromEntries(budgetDecisions.map((d) => [d.botType, d]));

  const perBot = await Promise.all(
    profiles.map(async (p) => {
      const createdToday = await prisma.paperTrade.count({
        where: { createdAt: { gte: todayStart }, botType: p.botType },
      });
      const maxDailyFromConfig = p.maxDailyNewTrades ?? config.maxDailyNewTrades;
      const decision = decisionByBot[p.botType];
      const budgetCap = decision?.maxNewTradesToday ?? maxDailyFromConfig;
      const maxDailyNewTradesEffective =
        budgetAllocatorEnabled && budgetCap > 0
          ? Math.min(maxDailyFromConfig || budgetCap, budgetCap)
          : maxDailyFromConfig;

      const isBudgetExceeded =
        maxDailyNewTradesEffective > 0 && createdToday >= maxDailyNewTradesEffective;

      return {
        botType: p.botType,
        effectiveEnabled: p.effectiveEnabled,
        maxDailyNewTrades_profileOrGlobal: maxDailyFromConfig,
        maxNewTradesToday_allocator: decision?.maxNewTradesToday ?? null,
        budgetWeight: decision?.budgetWeight ?? null,
        allocatorReasonSummary: decision?.reasonSummary ?? null,
        maxDailyNewTrades_effectiveEngine: maxDailyNewTradesEffective,
        tradesCreatedToday_utcDay_botScoped: createdToday,
        isBudgetExceeded,
        engineConditionPreview: `createdToday + openedForTick >= ${maxDailyNewTradesEffective} (openedForTick increments during same tick)`,
      };
    })
  );

  const sampleRecentTrades = await prisma.paperTrade.findMany({
    where: { createdAt: { gte: todayStart } },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: {
      id: true,
      botType: true,
      createdAt: true,
      status: true,
      marketId: true,
      assetId: true,
      paperPolicyMode: true,
    },
  });

  const createdTodayOpen = await prisma.paperTrade.count({
    where: { createdAt: { gte: todayStart }, status: "open" },
  });
  const createdTodayClosed = await prisma.paperTrade.count({
    where: { createdAt: { gte: todayStart }, status: "closed" },
  });

  const anyBotExceeded = perBot.some((b) => b.effectiveEnabled && b.isBudgetExceeded);

  const report = {
    maxDailyNewTrades: config.maxDailyNewTrades,
    maxDailyNewTrades_note:
      "Value from getPaperTradingConfig() only. Multi-bot engine uses per-profile `maxDailyNewTrades` first, then optional allocator `maxNewTradesToday` (see perBot).",

    tradesOpenedTodayCount: tradesOpenedTodayGlobal,
    tradesOpenedTodayCount_note:
      "All `PaperTrade` rows with `createdAt >=` UTC midnight today, **all bots**, **any status** (closed still count toward daily new-trade budget).",

    sourceOfCount:
      "Derived live from PostgreSQL: `prisma.paperTrade.count({ where: { createdAt: { gte: todayStart } } })` with `todayStart = setUTCHours(0,0,0,0)` on tick `now`. No `PaperTradingState` counter field; not read from `lastOpenTickResultJson`.",

    lastResetAt: todayStart.toISOString(),
    lastResetAt_note:
      "Implicit reset at start of each UTC calendar day (no persisted counter to reset).",

    currentTime: now.toISOString(),
    hoursSinceReset,

    sampleRecentTrades,

    isBudgetExceeded: anyBotExceeded,

    /** Per-bot engine-equivalent view (multi-bot path). */
    perBot,

    openTradesTotal: await prisma.paperTrade.count({ where: { status: "open" } }),

    todayTradeRows_byStatus: {
      open: createdTodayOpen,
      closed: createdTodayClosed,
      total: tradesOpenedTodayGlobal,
    },

    lastOpenTickAt: state?.lastOpenTickAt?.toISOString() ?? null,
    lastTickBudgetEcho_fromPersistedTick: lastTickBudgetEcho,
    lastTickBudgetEcho_note:
      "Echo of `perBotResults[*].budgetDecision` from `PaperTradingState.lastOpenTickResultJson` (tick-time snapshot).",

    featureFlags: {
      ENABLE_PAPER_BOT_BUDGET_ALLOCATOR_V1: budgetAllocatorEnabled,
      allocatorComputeError,
    },

    engineReference: {
      multiBot:
        "lib/paper-trading/engine.ts: `todayStart.setUTCHours(0,0,0,0)`; `createdToday = count({ createdAt gte todayStart, botType })`; `maxDailyFromConfig = profile.maxDailyNewTrades ?? config.maxDailyNewTrades`; `budgetCap = decision?.maxNewTradesToday ?? maxDailyFromConfig`; if allocator on: `maxDailyNewTrades = min(maxDailyFromConfig||budgetCap, budgetCap)`; gate: `maxDailyNewTrades > 0 && createdToday + openedForBot >= maxDailyNewTrades` → `budget_cap`.",
      legacy:
        "Same file (legacy path): `createdToday` counts **without** `botType` (all bots combined).",
      allocator:
        "lib/paper-trading/bot-budget-allocator.ts: `maxNewTradesToday = floor(baseDaily * weight)` where `baseDaily` prefers `profile.maxDailyNewTrades` over global — weights often 0.3 for low sample, shrinking the cap far below env.",
    },

    bugChecks: {
      counterNeverResets:
        "Not applicable: there is no monotonic stored counter; each tick recomputes from DB + UTC day boundary.",
      doubleCounts:
        "Each `PaperTrade` insert is one row; normal operation should not double-count unless duplicate rows exist.",
      closedTradesIncludedInDailyBudget: true,
      closedTradesIncluded_note:
        "Engine counts all rows created today regardless of `status`. Closing a trade does not remove it from today's `createdToday`. High `budget_cap` with few **open** positions can occur if many positions were opened and closed the same UTC day.",
      timezoneUtcMidnight: true,
      timezone_note:
        "Day boundary is **UTC** (`setUTCHours`), not local wall clock.",
      lifetimeVsDaily:
        "Query is scoped to `createdAt >= todayStart` only — not lifetime total.",
      diagnosticsVsEffectiveCapMismatch: {
        likely:
          budgetAllocatorEnabled ||
          profiles.some((p) => (p.maxDailyNewTrades ?? 0) > 0 && p.maxDailyNewTrades !== config.maxDailyNewTrades),
        explanation:
          "GET /api/paper-trading/diagnostics exposes `maxDailyNewTrades` from **global config only**. It does **not** show allocator `maxNewTradesToday` or per-profile caps. Observing `maxDailyNewTrades=100` in diagnostics while 100% `budget_cap` usually means **effective cap is lower** (allocator and/or profile=20) or **createdToday >= effective cap** including closed trades.",
      },
    },

    rootCause: budgetAllocatorEnabled
      ? "When ENABLE_PAPER_BOT_BUDGET_ALLOCATOR_V1 is on, the engine uses `min(profileOrGlobalDaily, floor(baseDaily * weight))` as the daily cap. `baseDaily` is taken from **per-bot `maxDailyNewTrades` (often 20)** before env 100, so the allocator can cap each bot at a small integer (e.g. 6) even though diagnostics show global 100. Alternatively, `createdToday` may already equal or exceed that effective cap (including many **closed** trades today)."
      : profiles.some((p) => (p.maxDailyNewTrades ?? 0) > 0 && p.maxDailyNewTrades! < config.maxDailyNewTrades)
        ? "Per-bot `maxDailyNewTrades` in bot-profiles (e.g. 20) overrides global env for each bot; diagnostics still show global 100."
        : tradesOpenedTodayGlobal >= config.maxDailyNewTrades && config.maxDailyNewTrades > 0
          ? "`createdToday` (all statuses) for at least one bot path has reached the configured daily limit."
          : "Review `perBot` rows: compare `tradesCreatedToday_utcDay_botScoped` to `maxDailyNewTrades_effectiveEngine`.",

    recommendedFix_minimal: budgetAllocatorEnabled
      ? "Safest: set `ENABLE_PAPER_BOT_BUDGET_ALLOCATOR_V1=0` (or false) to use only profile/global `maxDailyNewTrades` until allocator behavior is intentional. Alternatively raise allocator floor / use global `maxDailyNewTrades` as `baseDaily` when profile duplicates it."
      : "Align `lib/paper-trading/bot-profiles.ts` `maxDailyNewTrades` with env, or set profile field unset so global applies; extend diagnostics API to return effective `maxDailyNewTrades` per bot and allocator cap when enabled.",
  };

  await fs.writeFile(OUT_JSON, JSON.stringify(report, null, 2), "utf8");

  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
