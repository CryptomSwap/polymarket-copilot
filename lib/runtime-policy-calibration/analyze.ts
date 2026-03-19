/**
 * Runtime-policy / freshness threshold calibration analysis.
 * Uses shadow candidates with freshness/runtime-policy blocks to produce reviewable recommendations.
 * Does not auto-apply; descriptive and conservative.
 */

import { prisma } from "@/lib/db";
import { getRuntimePolicyThresholds } from "@/lib/runtime-policy-config";
import {
  hasRuntimePolicyBlock,
  subtypesFromBlockingReasons,
  runtimePolicySubtypeFromRaw,
} from "./subtypes";
import type {
  RuntimePolicyCalibrationReport,
  RuntimePolicySubtypeStats,
  RuntimePolicyCalibrationRecommendationRow,
  RuntimePolicyCalibrationRecommendation,
  RuntimePolicySubtype,
} from "./types";

const ALL_SUBTYPES: RuntimePolicySubtype[] = [
  "stale_market_data",
  "stale_user_feed",
  "stale_portfolio_truth",
  "stale_reconciliation",
  "stale_decision_snapshot",
  "runtime_phase_block",
  "runtime_safety_blocked",
  "runtime_safety_kill_switch",
  "exchange_truth_unavailable",
  "replay_backlog",
  "runtime_error",
  "other_freshness_policy",
];

const MIN_EVALUATED_FOR_RECOMMENDATION = 5;
const HIGH_BAD_BLOCK_RATE = 0.5;
const HIGH_GOOD_BLOCK_RATE = 0.6;
const HIGH_BAD_ALLOW_RATE = 0.5;

export interface RuntimePolicyCalibrationFilters {
  funderAddress?: string;
  minEvaluated?: number;
  subtype?: RuntimePolicySubtype;
  source?: string;
}

function parseNum(s: string | null | undefined): number | null {
  if (s == null || s === "") return null;
  const n = parseFloat(String(s).trim());
  return Number.isFinite(n) ? n : null;
}

function avg(arr: number[]): number | null {
  if (arr.length === 0) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function emptySubtypeStats(subtype: RuntimePolicySubtype): RuntimePolicySubtypeStats {
  return {
    subtype,
    blockedCount: 0,
    evaluatedBlocked: 0,
    goodBlockCount: 0,
    badBlockCount: 0,
    allowedCount: 0,
    evaluatedAllowed: 0,
    goodAllowCount: 0,
    badAllowCount: 0,
    averageMarkout24hBlocked: null,
    averageMarkout24hAllowed: null,
    rawSamples: [],
  };
}

function policyRawReasons(blockingReasons: unknown): string[] {
  const arr = Array.isArray(blockingReasons) ? blockingReasons : [];
  const out: string[] = [];
  for (const r of arr) {
    const s = String(r).trim();
    if (runtimePolicySubtypeFromRaw(s) != null) out.push(s);
  }
  return out;
}

export function buildRecommendation(
  subtype: RuntimePolicySubtype,
  stats: RuntimePolicySubtypeStats,
  minEval: number
): RuntimePolicyCalibrationRecommendationRow {
  const rec = recommendationFromStats(stats, minEval);
  const summary = summaryForRecommendation(rec, stats);
  return {
    subtype,
    recommendation: rec,
    summary,
    blockedCount: stats.blockedCount,
    evaluatedBlocked: stats.evaluatedBlocked,
    goodBlockCount: stats.goodBlockCount,
    badBlockCount: stats.badBlockCount,
    allowedCount: stats.allowedCount,
    evaluatedAllowed: stats.evaluatedAllowed,
    badAllowCount: stats.badAllowCount,
    minEvaluatedForRecommendation: minEval,
  };
}

function recommendationFromStats(
  stats: RuntimePolicySubtypeStats,
  minEval: number
): RuntimePolicyCalibrationRecommendation {
  const evBlocked = stats.evaluatedBlocked;
  const evAllowed = stats.evaluatedAllowed;

  if (evBlocked < minEval && evAllowed < minEval) return "insufficient_data";

  if (evBlocked >= minEval) {
    const total = stats.goodBlockCount + stats.badBlockCount;
    if (total > 0) {
      const badRate = stats.badBlockCount / total;
      const goodRate = stats.goodBlockCount / total;
      if (badRate >= HIGH_BAD_BLOCK_RATE) return "review_loosen";
      if (goodRate >= HIGH_GOOD_BLOCK_RATE) return "keep_strict";
    }
  }

  if (evAllowed >= minEval && stats.evaluatedAllowed > 0) {
    const badAllowRate = stats.badAllowCount / stats.evaluatedAllowed;
    if (badAllowRate >= HIGH_BAD_ALLOW_RATE) return "review_tighten";
  }

  return "monitor";
}

function summaryForRecommendation(
  rec: RuntimePolicyCalibrationRecommendation,
  stats: RuntimePolicySubtypeStats
): string {
  switch (rec) {
    case "review_loosen":
      return `High bad_block rate (${stats.badBlockCount}/${stats.evaluatedBlocked} evaluated); consider reviewing threshold for possible loosen.`;
    case "keep_strict":
      return `High good_block rate (${stats.goodBlockCount}/${stats.evaluatedBlocked}); block appears beneficial.`;
    case "review_tighten":
      return `Allowed cohort has many bad_allows (${stats.badAllowCount}/${stats.evaluatedAllowed}); consider tightening.`;
    case "insufficient_data":
      return `Insufficient evaluated samples (blocked: ${stats.evaluatedBlocked}, allowed: ${stats.evaluatedAllowed}).`;
    case "monitor":
    default:
      return "No strong signal; keep monitoring.";
  }
}

function thresholdsToRecord(): Record<string, number | boolean> {
  const t = getRuntimePolicyThresholds();
  return {
    marketDataFreshnessWarnMs: t.marketDataFreshnessWarnMs,
    marketDataFreshnessBlockMs: t.marketDataFreshnessBlockMs,
    userFeedFreshnessWarnMs: t.userFeedFreshnessWarnMs,
    userFeedFreshnessBlockMs: t.userFeedFreshnessBlockMs,
    portfolioTruthFreshnessWarnMs: t.portfolioTruthFreshnessWarnMs,
    portfolioTruthFreshnessBlockMs: t.portfolioTruthFreshnessBlockMs,
    reconciliationFreshnessWarnMs: t.reconciliationFreshnessWarnMs,
    reconciliationFreshnessBlockMs: t.reconciliationFreshnessBlockMs,
    decisionSnapshotMaxAgeMs: t.decisionSnapshotMaxAgeMs,
    runtimeErrorWarnCount: t.runtimeErrorWarnCount,
    runtimeErrorBlockCount: t.runtimeErrorBlockCount,
    fillReplayBacklogWarn: t.fillReplayBacklogWarn,
    fillReplayBacklogBlock: t.fillReplayBacklogBlock,
    exchangeTruthUnavailableBlocks: t.exchangeTruthUnavailableBlocks,
    runtimePhaseBlockOnStartup: t.runtimePhaseBlockOnStartup,
    runtimePhaseBlockOnRebuilding: t.runtimePhaseBlockOnRebuilding,
    runtimePhaseBlockOnReconciling: t.runtimePhaseBlockOnReconciling,
  };
}

export async function runRuntimePolicyCalibration(
  filters: RuntimePolicyCalibrationFilters = {}
): Promise<RuntimePolicyCalibrationReport> {
  const where: Record<string, unknown> = {};
  if (filters.funderAddress) where.funderAddress = filters.funderAddress.toLowerCase();
  if (filters.source) where.candidateSource = filters.source;

  const candidates = await prisma.shadowCandidate.findMany({
    where,
    orderBy: { createdAt: "desc" },
  });

  const policyRelevant = candidates.filter((c) => {
    if (c.wasBlocked && hasRuntimePolicyBlock(c.blockingReasons)) return true;
    if (!c.wasBlocked && c.runtimeSafetySnapshotJson) {
      try {
        const o = JSON.parse(c.runtimeSafetySnapshotJson) as { reasons?: string[] };
        const reasons = (o?.reasons ?? []) as string[];
        if (reasons.some((r) => runtimePolicySubtypeFromRaw(r) != null)) return true;
      } catch {
        // ignore
      }
    }
    return false;
  });

  let filtered = policyRelevant;
  if (filters.subtype) {
    filtered = policyRelevant.filter((c) => {
      const subs = subtypesFromBlockingReasons(c.blockingReasons);
      if (subs.includes(filters.subtype!)) return true;
      if (c.runtimeSafetySnapshotJson) {
        try {
          const o = JSON.parse(c.runtimeSafetySnapshotJson) as { reasons?: string[] };
          for (const r of (o?.reasons ?? []) as string[]) {
            if (runtimePolicySubtypeFromRaw(r) === filters.subtype) return true;
          }
        } catch {
          // ignore
        }
      }
      return false;
    });
  }
  if (filters.minEvaluated != null) {
    const withEval = filtered.filter((c) => c.evaluatedAt != null);
    if (withEval.length < filters.minEvaluated) filtered = [];
  }

  const perSubtype: Record<string, RuntimePolicySubtypeStats> = {};
  const markoutBlockedBySub: Record<string, number[]> = {};
  const markoutAllowedBySub: Record<string, number[]> = {};
  for (const sub of ALL_SUBTYPES) {
    perSubtype[sub] = { ...emptySubtypeStats(sub) };
    markoutBlockedBySub[sub] = [];
    markoutAllowedBySub[sub] = [];
  }

  for (const c of filtered) {
    const rawReasons = policyRawReasons(c.blockingReasons);
    const subtypes = new Set<RuntimePolicySubtype>();
    for (const r of rawReasons) {
      const sub = runtimePolicySubtypeFromRaw(r);
      if (sub != null) subtypes.add(sub);
    }
    if (c.runtimeSafetySnapshotJson) {
      try {
        const o = JSON.parse(c.runtimeSafetySnapshotJson) as { reasons?: string[] };
        for (const r of (o?.reasons ?? []) as string[]) {
          const sub = runtimePolicySubtypeFromRaw(r);
          if (sub != null) subtypes.add(sub);
        }
      } catch {
        // ignore
      }
    }
    if (subtypes.size === 0) continue;

    const evaluated = c.evaluatedAt != null;
    const goodBlock = c.outcomeClassification === "good_block";
    const badBlock = c.outcomeClassification === "bad_block";
    const goodAllow = c.outcomeClassification === "good_allow";
    const badAllow = c.outcomeClassification === "bad_allow";
    const markout24h = parseNum(c.markout24h);

    if (c.wasBlocked) {
      for (const sub of subtypes) {
        const st = perSubtype[sub]!;
        st.blockedCount++;
        if (evaluated) {
          st.evaluatedBlocked++;
          if (goodBlock) st.goodBlockCount++;
          if (badBlock) st.badBlockCount++;
          if (markout24h != null) markoutBlockedBySub[sub]!.push(markout24h);
        }
        for (const r of rawReasons.slice(0, 2)) {
          if (!st.rawSamples.includes(r)) st.rawSamples.push(r);
        }
      }
    } else {
      for (const sub of subtypes) {
        const st = perSubtype[sub]!;
        st.allowedCount++;
        if (evaluated) {
          st.evaluatedAllowed++;
          if (goodAllow) st.goodAllowCount++;
          if (badAllow) st.badAllowCount++;
          if (markout24h != null) markoutAllowedBySub[sub]!.push(markout24h);
        }
      }
    }
  }

  const minEval = filters.minEvaluated ?? MIN_EVALUATED_FOR_RECOMMENDATION;
  const recommendations: RuntimePolicyCalibrationRecommendationRow[] = [];
  for (const sub of ALL_SUBTYPES) {
    const st = perSubtype[sub]!;
    st.averageMarkout24hBlocked = avg(markoutBlockedBySub[sub] ?? []);
    st.averageMarkout24hAllowed = avg(markoutAllowedBySub[sub] ?? []);
    recommendations.push(buildRecommendation(sub, st, minEval));
  }

  const perSubtypeTyped: Record<RuntimePolicySubtype, RuntimePolicySubtypeStats | undefined> = {} as Record<
    RuntimePolicySubtype,
    RuntimePolicySubtypeStats | undefined
  >;
  for (const k of ALL_SUBTYPES) {
    perSubtypeTyped[k] = perSubtype[k];
  }

  return {
    currentThresholds: thresholdsToRecord(),
    perSubtype: perSubtypeTyped,
    recommendations,
    totalCandidates: candidates.length,
    runtimePolicyRelevantCandidates: policyRelevant.length,
    filters: {
      funderAddress: filters.funderAddress,
      minEvaluated: filters.minEvaluated,
      subtype: filters.subtype,
      source: filters.source,
    },
  };
}
