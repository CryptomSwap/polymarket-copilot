import { prisma } from "@/lib/db";
import { computeBotBudgets, type BotBudgetDecision } from "./bot-budget-allocator";

export interface BotControlSummary {
  botType: string;
  thresholdAdmissions: number;
  explorationAdmissions: number;
  challengerCoverageCount: number;
  challengerCoveragePct: number | null;
  budgetRank: number | null;
  budgetWeight: number | null;
  maxNewTradesToday: number | null;
  lastTickOpened: number | null;
  lastTickRejectedByBudgetCount: number | null;
  constrainedByBudget: boolean | null;
  budgetReasonSummary: string | null;
}

function nowMinusDays(days: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d;
}

export async function getPaperTradingControlSummary(): Promise<BotControlSummary[]> {
  const lookbackDays = 30;
  const from = nowMinusDays(lookbackDays);

  const [explorationAgg, challengerAgg, budgets, state] = await Promise.all([
    prisma.paperTrade.groupBy({
      by: ["botType", "explorationAdmissionMode"],
      where: { entryTime: { gte: from } },
      _count: { _all: true },
    }),
    prisma.paperTrade.groupBy({
      by: ["botType", "challengerAvailable"],
      where: { entryTime: { gte: from } },
      _count: { _all: true },
    }),
    computeBotBudgets({ lookbackDays }),
    prisma.paperTradingState.findUnique({ where: { id: "default" } }),
  ]);

  const decisionsByBot: Record<string, BotBudgetDecision> = {};
  for (const d of budgets) {
    decisionsByBot[d.botType] = d;
  }

  const admissionsByBot: Record<
    string,
    { threshold: number; exploration: number; total: number }
  > = {};
  for (const row of explorationAgg) {
    const bot = row.botType ?? "default";
    if (!admissionsByBot[bot]) {
      admissionsByBot[bot] = { threshold: 0, exploration: 0, total: 0 };
    }
    const mode = row.explorationAdmissionMode ?? "threshold";
    const count = row._count._all;
    if (mode === "exploration") {
      admissionsByBot[bot].exploration += count;
    } else {
      // Treat null / legacy values as threshold-like.
      admissionsByBot[bot].threshold += count;
    }
    admissionsByBot[bot].total += count;
  }

  const challengerByBot: Record<string, { trueCount: number; total: number }> = {};
  for (const row of challengerAgg) {
    const bot = row.botType ?? "default";
    if (!challengerByBot[bot]) {
      challengerByBot[bot] = { trueCount: 0, total: 0 };
    }
    const count = row._count._all;
    const avail = row.challengerAvailable;
    if (avail === true) {
      challengerByBot[bot].trueCount += count;
    }
    challengerByBot[bot].total += count;
  }

  let lastOpenResult: any = null;
  if (state?.lastOpenTickResultJson) {
    try {
      lastOpenResult = JSON.parse(state.lastOpenTickResultJson);
    } catch {
      lastOpenResult = null;
    }
  }
  const perBotResults: Record<string, any> =
    lastOpenResult && typeof lastOpenResult.perBotResults === "object"
      ? (lastOpenResult.perBotResults as Record<string, any>)
      : {};

  const botTypes = new Set<string>([
    ...Object.keys(admissionsByBot),
    ...Object.keys(challengerByBot),
    ...Object.keys(decisionsByBot),
    ...Object.keys(perBotResults),
  ]);

  const summaries: BotControlSummary[] = [];

  for (const botType of Array.from(botTypes).sort()) {
    const admissions = admissionsByBot[botType] ?? {
      threshold: 0,
      exploration: 0,
      total: 0,
    };
    const challenger = challengerByBot[botType] ?? { trueCount: 0, total: 0 };
    const decision = decisionsByBot[botType];
    const perBot = perBotResults[botType] ?? {};

    const challengerCoveragePct =
      challenger.total > 0 ? challenger.trueCount / challenger.total : null;

    const budgetRank = decision?.rank ?? null;
    const budgetWeight = decision?.budgetWeight ?? null;
    const maxNewTradesToday = decision?.maxNewTradesToday ?? null;
    const budgetReasonSummary = decision?.reasonSummary ?? null;

    const lastTickOpened =
      typeof perBot.opened === "number" ? (perBot.opened as number) : null;
    const lastTickRejectedByBudgetCount =
      typeof perBot.rejectedByBudgetCount === "number"
        ? (perBot.rejectedByBudgetCount as number)
        : null;
    const constrainedByBudget =
      perBot.budgetDecision && typeof perBot.budgetDecision.constrainedByBudget === "boolean"
        ? (perBot.budgetDecision.constrainedByBudget as boolean)
        : null;

    summaries.push({
      botType,
      thresholdAdmissions: admissions.threshold,
      explorationAdmissions: admissions.exploration,
      challengerCoverageCount: challenger.trueCount,
      challengerCoveragePct,
      budgetRank,
      budgetWeight,
      maxNewTradesToday,
      lastTickOpened,
      lastTickRejectedByBudgetCount,
      constrainedByBudget,
      budgetReasonSummary,
    });
  }

  return summaries;
}

