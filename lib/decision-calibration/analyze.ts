/**
 * Decision-stage boundary calibration analysis.
 * Uses shadow candidates and decision snapshots to produce reviewable recommendations.
 * Does not auto-apply; descriptive and conservative.
 */

import { prisma } from "@/lib/db";
import { getDecisionStageThresholds } from "@/lib/decision-config";
import {
  hasDecisionStageBlock,
  decisionSubtypeFromBlockReason,
  subtypesFromDecisionSnapshotJson,
  subtypesFromDecisionSnapshot,
  type DecisionSnapshotLike,
} from "./subtypes";
import type {
  DecisionStageCalibrationReport,
  DecisionStageSubtypeStats,
  DecisionCalibrationRecommendationRow,
  DecisionCalibrationRecommendation,
  DecisionStageSubtype,
} from "./types";

const ALL_SUBTYPES: DecisionStageSubtype[] = [
  "eligibility_block",
  "low_conviction_edge",
  "medium_conviction_edge",
  "high_conviction_edge",
  "poor_market_quality",
  "borderline_market_quality",
  "poor_portfolio_fit",
  "portfolio_fit_penalty",
  "size_reduced",
  "size_zero",
  "exit_trim_logic",
  "other_decision_stage",
];

const MIN_EVALUATED_FOR_RECOMMENDATION = 5;
const HIGH_BAD_BLOCK_RATE = 0.5;
const HIGH_GOOD_BLOCK_RATE = 0.6;
const HIGH_BAD_ALLOW_RATE = 0.5;
const HIGH_BAD_REDUCED_RATE = 0.5;

export interface DecisionCalibrationFilters {
  funderAddress?: string;
  minEvaluated?: number;
  subtype?: DecisionStageSubtype;
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

function emptySubtypeStats(subtype: DecisionStageSubtype): DecisionStageSubtypeStats {
  return {
    subtype,
    blockedCount: 0,
    reducedCount: 0,
    allowedCount: 0,
    evaluatedBlocked: 0,
    evaluatedReduced: 0,
    evaluatedAllowed: 0,
    goodBlockCount: 0,
    badBlockCount: 0,
    goodAllowCount: 0,
    badAllowCount: 0,
    goodReducedCount: 0,
    badReducedCount: 0,
    averageMarkout24hBlocked: null,
    averageMarkout24hAllowed: null,
    averageMarkout24hReduced: null,
    rawSamples: [],
  };
}

export function buildRecommendation(
  subtype: DecisionStageSubtype,
  stats: DecisionStageSubtypeStats,
  minEval: number
): DecisionCalibrationRecommendationRow {
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
    reducedCount: stats.reducedCount,
    evaluatedReduced: stats.evaluatedReduced,
    badReducedCount: stats.badReducedCount,
    allowedCount: stats.allowedCount,
    evaluatedAllowed: stats.evaluatedAllowed,
    badAllowCount: stats.badAllowCount,
    minEvaluatedForRecommendation: minEval,
  };
}

function recommendationFromStats(
  stats: DecisionStageSubtypeStats,
  minEval: number
): DecisionCalibrationRecommendation {
  const evBlocked = stats.evaluatedBlocked;
  const evAllowed = stats.evaluatedAllowed;
  const evReduced = stats.evaluatedReduced;

  if (evBlocked < minEval && evAllowed < minEval && evReduced < minEval) return "insufficient_data";

  if (evBlocked >= minEval) {
    const total = stats.goodBlockCount + stats.badBlockCount;
    if (total > 0) {
      const badRate = stats.badBlockCount / total;
      const goodRate = stats.goodBlockCount / total;
      if (badRate >= HIGH_BAD_BLOCK_RATE) return "review_loosen";
      if (goodRate >= HIGH_GOOD_BLOCK_RATE) return "keep_strict";
    }
  }

  if (evReduced >= minEval && stats.evaluatedReduced > 0) {
    const badReducedRate = stats.badReducedCount / stats.evaluatedReduced;
    if (badReducedRate >= HIGH_BAD_REDUCED_RATE) return "review_tighten";
  }

  if (evAllowed >= minEval && stats.evaluatedAllowed > 0) {
    const badAllowRate = stats.badAllowCount / stats.evaluatedAllowed;
    if (badAllowRate >= HIGH_BAD_ALLOW_RATE) return "review_tighten";
  }

  return "monitor";
}

function summaryForRecommendation(
  rec: DecisionCalibrationRecommendation,
  stats: DecisionStageSubtypeStats
): string {
  switch (rec) {
    case "review_loosen":
      return `High bad_block rate (${stats.badBlockCount}/${stats.evaluatedBlocked} evaluated); consider reviewing boundary for possible loosen.`;
    case "keep_strict":
      return `High good_block rate (${stats.goodBlockCount}/${stats.evaluatedBlocked}); block appears beneficial.`;
    case "review_tighten":
      if (stats.evaluatedReduced > 0 && stats.badReducedCount / stats.evaluatedReduced >= HIGH_BAD_REDUCED_RATE) {
        return `Reduced-size cohort has many bad outcomes (${stats.badReducedCount}/${stats.evaluatedReduced}); consider tightening.`;
      }
      return `Allowed cohort has many bad_allows (${stats.badAllowCount}/${stats.evaluatedAllowed}); consider tightening.`;
    case "insufficient_data":
      return `Insufficient evaluated samples (blocked: ${stats.evaluatedBlocked}, reduced: ${stats.evaluatedReduced}, allowed: ${stats.evaluatedAllowed}).`;
    case "monitor":
    default:
      return "No strong signal; keep monitoring.";
  }
}

function thresholdsToRecord(): Record<string, number> {
  const t = getDecisionStageThresholds();
  return {
    eligibilityLowConvictionThreshold: t.eligibilityLowConvictionThreshold,
    edgeHighConvictionThreshold: t.edgeHighConvictionThreshold,
    edgeMediumConvictionThreshold: t.edgeMediumConvictionThreshold,
    edgeLowConvictionThreshold: t.edgeLowConvictionThreshold,
    marketQualityWarnLiquidityThreshold: t.marketQualityWarnLiquidityThreshold,
    marketQualityBlockLiquidityThreshold: t.marketQualityBlockLiquidityThreshold,
    marketQualityCrowdingWarnThreshold: t.marketQualityCrowdingWarnThreshold,
    marketQualityCrowdingBlockThreshold: t.marketQualityCrowdingBlockThreshold,
    portfolioFitPenaltyWarnThreshold: t.portfolioFitPenaltyWarnThreshold,
    portfolioFitPenaltyBlockThreshold: t.portfolioFitPenaltyBlockThreshold,
    portfolioFitTopConcBlockPct: t.portfolioFitTopConcBlockPct,
    sizingMinMultiplier: t.sizingMinMultiplier,
    sizingReviewMultiplier: t.sizingReviewMultiplier,
    sizingStrongConvictionMultiplier: t.sizingStrongConvictionMultiplier,
    concentrationBlockPct: t.concentrationBlockPct,
  };
}

export async function runDecisionStageCalibration(
  filters: DecisionCalibrationFilters = {}
): Promise<DecisionStageCalibrationReport> {
  const where: Record<string, unknown> = {};
  if (filters.funderAddress) where.funderAddress = filters.funderAddress.toLowerCase();
  if (filters.source) where.candidateSource = filters.source;

  const candidates = await prisma.shadowCandidate.findMany({
    where,
    orderBy: { createdAt: "desc" },
  });

  const decisionRelevant = candidates.filter((c) => {
    if (c.wasBlocked && hasDecisionStageBlock(c.blockingReasons)) return true;
    if (c.wasBlocked) {
      const reasons = (c.blockingReasons as string[] | null) ?? [];
      for (const r of reasons) {
        if (decisionSubtypeFromBlockReason(r) != null) return true;
      }
    }
    if (c.decisionSnapshotJson) {
      const subs = subtypesFromDecisionSnapshotJson(c.decisionSnapshotJson);
      if (subs.length > 0) return true;
    }
    if (c.executionPolicySnapshotJson) {
      try {
        const o = JSON.parse(c.executionPolicySnapshotJson) as { recommendationBlock?: boolean; blockReason?: string };
        if (o?.recommendationBlock || (o?.blockReason && decisionSubtypeFromBlockReason(o.blockReason))) return true;
      } catch {
        // ignore
      }
    }
    return false;
  });

  let filtered = decisionRelevant;
  if (filters.subtype) {
    filtered = decisionRelevant.filter((c) => {
      const fromBlock: DecisionStageSubtype[] = [];
      const arr = (c.blockingReasons as string[] | null) ?? [];
      for (const r of arr) {
        const sub = decisionSubtypeFromBlockReason(r);
        if (sub) fromBlock.push(sub);
      }
      const fromSnap = c.decisionSnapshotJson ? subtypesFromDecisionSnapshotJson(c.decisionSnapshotJson) : [];
      const all = new Set([...fromBlock, ...fromSnap]);
      return all.has(filters.subtype!);
    });
  }
  if (filters.minEvaluated != null) {
    const withEval = filtered.filter((c) => c.evaluatedAt != null);
    if (withEval.length < filters.minEvaluated) filtered = [];
  }

  const perSubtype: Record<string, DecisionStageSubtypeStats> = {};
  const markoutBlockedBySub: Record<string, number[]> = {};
  const markoutAllowedBySub: Record<string, number[]> = {};
  const markoutReducedBySub: Record<string, number[]> = {};
  for (const sub of ALL_SUBTYPES) {
    perSubtype[sub] = { ...emptySubtypeStats(sub) };
    markoutBlockedBySub[sub] = [];
    markoutAllowedBySub[sub] = [];
    markoutReducedBySub[sub] = [];
  }

  for (const c of filtered) {
    const fromBlock: DecisionStageSubtype[] = [];
    const arr = (c.blockingReasons as string[] | null) ?? [];
    for (const r of arr) {
      const sub = decisionSubtypeFromBlockReason(r);
      if (sub) fromBlock.push(sub);
    }
    let fromSnap: DecisionStageSubtype[] = [];
    let snapshot: DecisionSnapshotLike | null = null;
    if (c.decisionSnapshotJson) {
      try {
        snapshot = JSON.parse(c.decisionSnapshotJson) as DecisionSnapshotLike;
        fromSnap = subtypesFromDecisionSnapshot(snapshot);
      } catch {
        // ignore
      }
    }
    const subtypes = new Set<DecisionStageSubtype>([...fromBlock, ...fromSnap]);
    if (subtypes.size === 0 && (fromBlock.length > 0 || fromSnap.length > 0)) subtypes.add("other_decision_stage");
    if (subtypes.size === 0) continue;

    const evaluated = c.evaluatedAt != null;
    const goodBlock = c.outcomeClassification === "good_block";
    const badBlock = c.outcomeClassification === "bad_block";
    const goodAllow = c.outcomeClassification === "good_allow";
    const badAllow = c.outcomeClassification === "bad_allow";
    const markout24h = parseNum(c.markout24h);

    const isReduced =
      snapshot != null &&
      typeof snapshot.sizeMultiplier === "number" &&
      snapshot.sizeMultiplier > 0 &&
      snapshot.sizeMultiplier < 1;

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
        for (const r of arr.slice(0, 2)) {
          if (decisionSubtypeFromBlockReason(r) && !st.rawSamples.includes(r)) st.rawSamples.push(r);
        }
      }
    } else if (isReduced) {
      for (const sub of subtypes) {
        const st = perSubtype[sub]!;
        st.reducedCount++;
        if (evaluated) {
          st.evaluatedReduced++;
          if (goodAllow) st.goodReducedCount++;
          if (badAllow) st.badReducedCount++;
          if (markout24h != null) markoutReducedBySub[sub]!.push(markout24h);
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
  const recommendations: DecisionCalibrationRecommendationRow[] = [];
  for (const sub of ALL_SUBTYPES) {
    const st = perSubtype[sub]!;
    st.averageMarkout24hBlocked = avg(markoutBlockedBySub[sub] ?? []);
    st.averageMarkout24hAllowed = avg(markoutAllowedBySub[sub] ?? []);
    st.averageMarkout24hReduced = avg(markoutReducedBySub[sub] ?? []);
    recommendations.push(buildRecommendation(sub, st, minEval));
  }

  const perSubtypeTyped: Record<DecisionStageSubtype, DecisionStageSubtypeStats | undefined> = {} as Record<
    DecisionStageSubtype,
    DecisionStageSubtypeStats | undefined
  >;
  for (const k of ALL_SUBTYPES) {
    perSubtypeTyped[k] = perSubtype[k];
  }

  return {
    currentThresholds: thresholdsToRecord(),
    perSubtype: perSubtypeTyped,
    recommendations,
    totalCandidates: candidates.length,
    decisionRelevantCandidates: decisionRelevant.length,
    filters: {
      funderAddress: filters.funderAddress,
      minEvaluated: filters.minEvaluated,
      subtype: filters.subtype,
      source: filters.source,
    },
  };
}
