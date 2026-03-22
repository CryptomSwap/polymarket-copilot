/**
 * Read-only diagnostic: per-bot paper trading capacity vs usage and last-tick trace cross-check.
 * Prints JSON to stdout. No runtime or admission behavior changes.
 *
 * Run: npx tsx tools/create-paper-bot-capacity-report.ts
 */

import "dotenv/config";
import { prisma } from "../lib/db";
import { getEffectiveBotProfiles } from "../lib/paper-trading/bot-profiles";
import type { PaperDecisionTraceBundle } from "../lib/paper-trading/decision-trace-types";

const STATE_ID = "default";

function utcDayStart(d: Date): Date {
  const t = new Date(d);
  t.setUTCHours(0, 0, 0, 0);
  return t;
}

function countByBotType(rows: { botType: string; _count: { id: number } }[]): Record<string, number> {
  const m: Record<string, number> = {};
  for (const r of rows) {
    m[r.botType] = r._count.id;
  }
  return m;
}

function traceCrossCheck(bundle: PaperDecisionTraceBundle | null): {
  lastTickPresent: boolean;
  scoreEligibleByBot: Record<string, number>;
  budgetCapRejectByBot: Record<string, number>;
} {
  const scoreEligibleByBot: Record<string, number> = {};
  const budgetCapRejectByBot: Record<string, number> = {};
  if (!bundle?.traces?.length) {
    return { lastTickPresent: bundle != null, scoreEligibleByBot, budgetCapRejectByBot };
  }
  for (const t of bundle.traces) {
    const bt = t.botType ?? "unknown";
    if (t.thresholdEligible === true) {
      scoreEligibleByBot[bt] = (scoreEligibleByBot[bt] ?? 0) + 1;
    }
    if (t.rejectReasonCode === "budget_cap") {
      budgetCapRejectByBot[bt] = (budgetCapRejectByBot[bt] ?? 0) + 1;
    }
  }
  return { lastTickPresent: true, scoreEligibleByBot, budgetCapRejectByBot };
}

async function main(): Promise<void> {
  const generatedAt = new Date().toISOString();
  const todayStart = utcDayStart(new Date());

  let error: string | null = null;
  let profiles: Awaited<ReturnType<typeof getEffectiveBotProfiles>> = [];
  let openedTodayByBot: Record<string, number> = {};
  let openNowByBot: Record<string, number> = {};
  let lastOpenTickAt: string | null = null;
  let bundle: PaperDecisionTraceBundle | null = null;

  try {
    profiles = await getEffectiveBotProfiles();

    const [openedRows, openRows, state] = await Promise.all([
      prisma.paperTrade.groupBy({
        by: ["botType"],
        where: { createdAt: { gte: todayStart } },
        _count: { id: true },
      }),
      prisma.paperTrade.groupBy({
        by: ["botType"],
        where: { status: "open" },
        _count: { id: true },
      }),
      prisma.paperTradingState.findUnique({ where: { id: STATE_ID } }),
    ]);

    openedTodayByBot = countByBotType(openedRows);
    openNowByBot = countByBotType(openRows);
    lastOpenTickAt = state?.lastOpenTickAt?.toISOString() ?? null;

    if (state?.lastOpenTickResultJson) {
      try {
        const parsed = JSON.parse(state.lastOpenTickResultJson) as Record<string, unknown>;
        if (parsed.decisionTraceBundle && typeof parsed.decisionTraceBundle === "object") {
          bundle = parsed.decisionTraceBundle as unknown as PaperDecisionTraceBundle;
        }
      } catch {
        // leave bundle null
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const cross = traceCrossCheck(bundle);

  const bots = profiles.map((p) => {
    const openedToday = openedTodayByBot[p.botType] ?? 0;
    const currentlyOpen = openNowByBot[p.botType] ?? 0;
    const maxDaily = p.maxDailyNewTrades ?? 0;
    const maxOpen = p.maxOpenTotal ?? 0;

    const remainingDailyCapacity =
      maxDaily > 0 ? Math.max(0, maxDaily - openedToday) : null;
    const remainingOpenCapacity =
      maxOpen > 0 ? Math.max(0, maxOpen - currentlyOpen) : null;

    const fullySaturated =
      (maxDaily > 0 || maxOpen > 0) &&
      (maxDaily <= 0 || remainingDailyCapacity === 0) &&
      (maxOpen <= 0 || remainingOpenCapacity === 0);

    return {
      botType: p.botType,
      maxDailyNewTrades: maxDaily,
      maxOpenTotal: maxOpen,
      openedToday,
      currentlyOpen,
      remainingDailyCapacity,
      remainingOpenCapacity,
      fullySaturated,
    };
  });

  const botsWithRemainingDailyCapacity = bots.filter(
    (b) => b.maxDailyNewTrades > 0 && (b.remainingDailyCapacity ?? 0) > 0
  ).length;

  const fullySaturatedCount = bots.filter((b) => b.fullySaturated).length;

  let totalRemainingDailySlots = 0;
  let totalRemainingOpenSlots = 0;
  for (const b of bots) {
    if (b.maxDailyNewTrades > 0) totalRemainingDailySlots += b.remainingDailyCapacity ?? 0;
    if (b.maxOpenTotal > 0) totalRemainingOpenSlots += b.remainingOpenCapacity ?? 0;
  }

  const report = {
    generatedAt,
    ...(error ? { error } : {}),
    utcDayStart: todayStart.toISOString(),
    lastOpenTickAt,
    bots,
    summary: {
      botsWithRemainingDailyCapacity,
      fullySaturatedBotCount: fullySaturatedCount,
      totalRemainingDailySlots,
      totalRemainingOpenSlots,
    },
    lastTickCrossCheck: {
      note: "From decisionTraceBundle.traces on last persisted open tick (bounded; not all candidates may appear).",
      ...cross,
    },
  };

  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
