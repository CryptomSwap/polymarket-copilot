/**
 * Portfolio-risk threshold calibration analysis.
 * Uses shadow candidates with portfolio-risk/concentration blocks to produce reviewable recommendations.
 * Does not auto-apply; descriptive and conservative.
 */

import { prisma } from "@/lib/db";
import { getPortfolioRiskThresholds } from "@/lib/portfolio-risk/config";
import {
  hasPortfolioRiskBlock,
  subtypesFromBlockingReasons,
  subtypesFromPortfolioRiskSnapshot,
  portfolioRiskSubtypeFromRaw,
} from "./subtypes";
import type {
  PortfolioRiskCalibrationReport,
  RiskSubtypeStats,
  RiskCalibrationRecommendationRow,
  RiskCalibrationRecommendation,
  PortfolioRiskSubtype,
} from "./types";

const ALL_SUBTYPES: PortfolioRiskSubtype[] = [
  "total_exposure",
  "single_market_concentration",
  "single_theme_concentration",
  "near_resolution_exposure",
  "illiquid_exposure",
  "correlated_exposure",
  "portfolio_fit_penalty",
  "behavior_conflict",
  "other_portfolio_risk",
];

const MIN_EVALUATED_FOR_RECOMMENDATION = 5;
const HIGH_BAD_BLOCK_RATE = 0.5;
const HIGH_GOOD_BLOCK_RATE = 0.6;
const HIGH_BAD_ALLOW_RATE = 0.5;

export interface RiskCalibrationFilters {
  funderAddress?: string;
  minEvaluated?: number;
  subtype?: PortfolioRiskSubtype;
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

function emptySubtypeStats(subtype: PortfolioRiskSubtype): RiskSubtypeStats {
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

function riskRawReasons(blockingReasons: unknown): string[] {
  const arr = Array.isArray(blockingReasons) ? blockingReasons : [];
  const out: string[] = [];
  for (const r of arr) {
    const s = String(r).trim();
    if (portfolioRiskSubtypeFromRaw(s) != null) out.push(s);
  }
  return out;
}

export function buildRecommendation(
  subtype: PortfolioRiskSubtype,
  stats: RiskSubtypeStats,
  minEval: number
): RiskCalibrationRecommendationRow {
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

function recommendationFromStats(stats: RiskSubtypeStats, minEval: number): RiskCalibrationRecommendation {
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

function summaryForRecommendation(rec: RiskCalibrationRecommendation, stats: RiskSubtypeStats): string {
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

function thresholdsToRecord(): Record<string, number> {
  const t = getPortfolioRiskThresholds();
  return {
    maxTotalExposure: t.maxTotalExposure,
    maxSingleMarketConcentrationPct: t.maxSingleMarketConcentrationPct,
    maxSingleThemeConcentrationPct: t.maxSingleThemeConcentrationPct,
    nearResolutionHoursThreshold: t.nearResolutionHoursThreshold,
    nearResolutionExposureWarnPct: t.nearResolutionExposureWarnPct,
    nearResolutionExposureBlockPct: t.nearResolutionExposureBlockPct,
    illiquidExposureWarnPct: t.illiquidExposureWarnPct,
    illiquidExposureBlockPct: t.illiquidExposureBlockPct,
    correlatedExposureWarnPct: t.correlatedExposureWarnPct,
    correlatedExposureBlockPct: t.correlatedExposureBlockPct,
  };
}

export async function runPortfolioRiskCalibration(
  filters: RiskCalibrationFilters = {}
): Promise<PortfolioRiskCalibrationReport> {
  const where: Record<string, unknown> = {};
  if (filters.funderAddress) where.funderAddress = filters.funderAddress.toLowerCase();
  if (filters.source) where.candidateSource = filters.source;

  const candidates = await prisma.shadowCandidate.findMany({
    where,
    orderBy: { createdAt: "desc" },
  });

  const riskRelevant = candidates.filter((c) => {
    if (c.wasBlocked && hasPortfolioRiskBlock(c.blockingReasons)) return true;
    if (c.wasBlocked && c.portfolioRiskSnapshotJson) {
      const subs = subtypesFromPortfolioRiskSnapshot(c.portfolioRiskSnapshotJson);
      if (subs.length > 0) return true;
    }
    if (!c.wasBlocked && c.portfolioRiskSnapshotJson) {
      const subs = subtypesFromPortfolioRiskSnapshot(c.portfolioRiskSnapshotJson);
      if (subs.length > 0) return true;
    }
    return false;
  });

  let filtered = riskRelevant;
  if (filters.subtype) {
    filtered = riskRelevant.filter((c) => {
      const fromBlock = subtypesFromBlockingReasons(c.blockingReasons);
      const fromSnap = c.portfolioRiskSnapshotJson
        ? subtypesFromPortfolioRiskSnapshot(c.portfolioRiskSnapshotJson)
        : [];
      const all = new Set([...fromBlock, ...fromSnap]);
      return all.has(filters.subtype!);
    });
  }
  if (filters.minEvaluated != null) {
    const withEval = filtered.filter((c) => c.evaluatedAt != null);
    if (withEval.length < filters.minEvaluated) filtered = [];
  }

  const perSubtype: Record<string, RiskSubtypeStats> = {};
  const markoutBlockedBySub: Record<string, number[]> = {};
  const markoutAllowedBySub: Record<string, number[]> = {};
  for (const sub of ALL_SUBTYPES) {
    perSubtype[sub] = { ...emptySubtypeStats(sub) };
    markoutBlockedBySub[sub] = [];
    markoutAllowedBySub[sub] = [];
  }

  for (const c of filtered) {
    const fromBlock = riskRawReasons(c.blockingReasons);
    const fromSnap = c.portfolioRiskSnapshotJson
      ? subtypesFromPortfolioRiskSnapshot(c.portfolioRiskSnapshotJson)
      : [];
    const rawReasons = fromBlock.length > 0 ? fromBlock : [];
    const subtypes = new Set<PortfolioRiskSubtype>();
    for (const r of rawReasons) {
      const sub = portfolioRiskSubtypeFromRaw(r);
      if (sub != null) subtypes.add(sub);
    }
    for (const sub of fromSnap) subtypes.add(sub);
    if (subtypes.size === 0 && (fromBlock.length > 0 || fromSnap.length > 0)) subtypes.add("other_portfolio_risk");
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
  const recommendations: RiskCalibrationRecommendationRow[] = [];
  for (const sub of ALL_SUBTYPES) {
    const st = perSubtype[sub]!;
    st.averageMarkout24hBlocked = avg(markoutBlockedBySub[sub] ?? []);
    st.averageMarkout24hAllowed = avg(markoutAllowedBySub[sub] ?? []);
    recommendations.push(buildRecommendation(sub, st, minEval));
  }

  const perSubtypeTyped: Record<PortfolioRiskSubtype, RiskSubtypeStats | undefined> = {} as Record<
    PortfolioRiskSubtype,
    RiskSubtypeStats | undefined
  >;
  for (const k of ALL_SUBTYPES) {
    perSubtypeTyped[k] = perSubtype[k];
  }

  return {
    currentThresholds: thresholdsToRecord(),
    perSubtype: perSubtypeTyped,
    recommendations,
    totalCandidates: candidates.length,
    riskRelevantCandidates: riskRelevant.length,
    filters: {
      funderAddress: filters.funderAddress,
      minEvaluated: filters.minEvaluated,
      subtype: filters.subtype,
      source: filters.source,
    },
  };
}

