/**
 * Paper-only bot budget allocator v1.
 * Uses recent evidence and overlap to suggest conservative per-bot daily budgets.
 * Does NOT change live trading or execution; paper-only governance signal.
 */

import { getPaperTradingConfig } from "./config";
import { getEffectiveBotProfiles, type EffectiveBotProfile } from "./bot-profiles";
import {
  getPerBotAnalytics,
  getBotOverlapReport,
  type BotAnalyticsSummary,
  type BotOverlapPair,
} from "./analytics";

export const BOT_BUDGET_ALLOCATOR_VERSION = "paper_bot_budget_v1";

export interface BotBudgetDecision {
  botType: string;
  rank: number;
  budgetWeight: number;
  maxNewTradesToday: number;
  reasonSummary: string;
  allocatorVersion: string;
  metrics: {
    lookbackDays: number;
    closedTrades: number;
    winRate: number | null;
    averagePnlPct: number | null;
    cumulativePnlPct: number | null;
    medianPnlPct: number | null;
    overlapScore: number;
    enabled: boolean;
  };
}

export interface ComputeBotBudgetsParams {
  /** Lookback window in days for recent performance (closed trades). */
  lookbackDays?: number;
}

function nowMinusDays(days: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d;
}

function computeOverlapScores(overlap: BotOverlapPair[]): Record<string, number> {
  const scores: Record<string, number> = {};
  for (const p of overlap) {
    const total = p.sameMarketCount + p.sameAssetSideCount;
    if (total <= 0) continue;
    scores[p.botA] = (scores[p.botA] ?? 0) + total;
    scores[p.botB] = (scores[p.botB] ?? 0) + total;
  }
  const max = Object.values(scores).reduce((m, v) => (v > m ? v : m), 0);
  if (max <= 0) return Object.fromEntries(Object.keys(scores).map((k) => [k, 0]));
  const normalized: Record<string, number> = {};
  for (const [bot, v] of Object.entries(scores)) {
    normalized[bot] = v / max;
  }
  return normalized;
}

function scoreBot(
  profile: EffectiveBotProfile,
  analytics: BotAnalyticsSummary | undefined,
  overlapScore: number,
  lookbackDays: number
): BotBudgetDecision {
  const closedTrades = analytics?.closedTrades ?? 0;
  const winRate = analytics?.winRate ?? null;
  const averagePnlPct = analytics?.averagePnlPct ?? null;
  const cumulativePnlPct = analytics?.cumulativePnlPct ?? null;
  const medianPnlPct = analytics?.medianPnlPct ?? null;

  const enabled = profile.effectiveEnabled;

  // Baseline budget weight (0–1) before overlap penalty.
  let weight = 0;
  const reasons: string[] = [];

  if (!enabled) {
    weight = 0;
    reasons.push("profile_disabled");
  } else if (closedTrades < 20) {
    weight = 0.3;
    reasons.push("low_sample_conservative");
  } else {
    // Start from performance: require at least modest win rate and non-negative cumulative PnL.
    const wr = winRate ?? 0;
    const cum = cumulativePnlPct ?? 0;

    if (wr < 0.45 && cum <= 0) {
      weight = 0.3;
      reasons.push("weak_recent_performance_conservative");
    } else {
      // Map win rate and cumulative PnL into a simple blended score.
      const wrScore = Math.min(Math.max((wr - 0.5) * 4, -1), 1); // wr 0.5 -> 0, 0.75 -> 1, 0.25 -> -1
      const cumScore = Math.max(Math.min((cum ?? 0) * 2, 1), -1); // small positive cum -> up to 1, negative -> down
      const perfScore = 0.6 * wrScore + 0.4 * cumScore;
      // Map perfScore (-1..1) to weight baseline 0.3..1.0
      weight = 0.3 + ((perfScore + 1) / 2) * 0.7;
      if (weight < 0.3) weight = 0.3;
      if (weight > 1) weight = 1;
      reasons.push("evidence_driven_budget");
    }
  }

  // Overlap penalty: bots with high overlap get gently reduced budgets.
  const ov = overlapScore || 0;
  if (ov > 0) {
    const penalty = Math.min(0.5, ov * 0.3); // up to 50% reduction
    weight = weight * (1 - penalty);
    reasons.push(`overlap_penalty_${penalty.toFixed(2)}`);
  }

  // Clamp to [0, 1] and add a small floor for enabled bots so they get some paper exposure.
  if (enabled && weight < 0.1) {
    weight = 0.1;
    reasons.push("min_floor_for_enabled_bot");
  }
  if (!enabled) {
    weight = 0;
  }

  const global = getPaperTradingConfig();
  const baseDaily =
    profile.maxDailyNewTrades > 0
      ? profile.maxDailyNewTrades
      : global.maxDailyNewTrades > 0
        ? global.maxDailyNewTrades
        : 50; // conservative default when no explicit cap

  const maxNewTradesToday = Math.max(0, Math.floor(baseDaily * weight));

  const reasonSummary = [
    `lookback=${lookbackDays}d`,
    `closed=${closedTrades}`,
    `wr=${winRate != null ? (winRate * 100).toFixed(1) + "%" : "n/a"}`,
    `avgPnL=${averagePnlPct != null ? (averagePnlPct * 100).toFixed(2) + "%" : "n/a"}`,
    `cumPnL=${cumulativePnlPct != null ? (cumulativePnlPct * 100).toFixed(2) + "%" : "n/a"}`,
    `overlap=${ov.toFixed(2)}`,
    ...reasons,
  ].join(" | ");

  return {
    botType: profile.botType,
    rank: 0, // filled later after sorting
    budgetWeight: Number(weight.toFixed(3)),
    maxNewTradesToday,
    reasonSummary,
    allocatorVersion: BOT_BUDGET_ALLOCATOR_VERSION,
    metrics: {
      lookbackDays,
      closedTrades,
      winRate,
      averagePnlPct,
      cumulativePnlPct,
      medianPnlPct,
      overlapScore: ov,
      enabled,
    },
  };
}

export async function computeBotBudgets(
  params: ComputeBotBudgetsParams = {}
): Promise<BotBudgetDecision[]> {
  const lookbackDays = params.lookbackDays ?? 30;
  const from = nowMinusDays(lookbackDays);

  const [profiles, analytics, overlap] = await Promise.all([
    getEffectiveBotProfiles(),
    getPerBotAnalytics({ from }),
    getBotOverlapReport({ from }),
  ]);

  const analyticsByBot: Record<string, BotAnalyticsSummary> = {};
  for (const a of analytics) {
    analyticsByBot[a.botType] = a;
  }

  const overlapScores = computeOverlapScores(overlap);

  const decisions: BotBudgetDecision[] = profiles.map((p) =>
    scoreBot(p, analyticsByBot[p.botType], overlapScores[p.botType] ?? 0, lookbackDays)
  );

  // Rank by budgetWeight descending, then by botType.
  decisions.sort((a, b) => {
    if (b.budgetWeight !== a.budgetWeight) {
      return b.budgetWeight - a.budgetWeight;
    }
    return a.botType.localeCompare(b.botType);
  });
  decisions.forEach((d, i) => {
    d.rank = i + 1;
  });

  return decisions;
}

