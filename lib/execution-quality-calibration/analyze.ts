/**
 * Execution-quality threshold calibration analysis.
 * Uses shadow candidates with execution-quality blocks/warnings to produce reviewable recommendations.
 * Does not auto-apply; descriptive and conservative.
 */

import { prisma } from "@/lib/db";
import { getExecutionQualityThresholds } from "@/lib/execution-quality/config";
import {
  hasExecutionQualityBlock,
  snapshotHasEqWarnings,
  subtypesFromBlockingReasons,
  subtypesFromWarnings,
  executionQualitySubtypeFromRaw,
} from "./subtypes";
import type {
  ExecutionQualityCalibrationReport,
  EqSubtypeStats,
  EqCalibrationRecommendationRow,
  EqCalibrationRecommendation,
  ExecutionQualitySubtype,
} from "./types";

const ALL_SUBTYPES: ExecutionQualitySubtype[] = [
  "stale_quote",
  "spread_too_wide",
  "insufficient_depth",
  "slippage_too_high",
  "not_tradable",
  "low_liquidity_score",
  "price_too_far_from_market",
  "other",
];

const MIN_EVALUATED_FOR_RECOMMENDATION = 5;
const HIGH_BAD_BLOCK_RATE = 0.5;
const HIGH_GOOD_BLOCK_RATE = 0.6;
const HIGH_BAD_ALLOW_RATE = 0.5;

export interface EqCalibrationFilters {
  funderAddress?: string;
  minEvaluated?: number;
  subtype?: ExecutionQualitySubtype;
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

function emptySubtypeStats(subtype: ExecutionQualitySubtype): EqSubtypeStats {
  return {
    subtype,
    blockedCount: 0,
    evaluatedBlocked: 0,
    goodBlockCount: 0,
    badBlockCount: 0,
    allowedWithWarningCount: 0,
    evaluatedAllowedWithWarning: 0,
    goodAllowCount: 0,
    badAllowCount: 0,
    averageMarkout24hBlocked: null,
    averageMarkout24hAllowedWithWarning: null,
    rawSamples: [],
  };
}

/** Extract raw execution-quality reasons from blockingReasons (e.g. "execution_quality:quote_stale" or "quote_stale"). */
function eqRawReasons(blockingReasons: unknown): string[] {
  const arr = Array.isArray(blockingReasons) ? blockingReasons : [];
  const out: string[] = [];
  for (const r of arr) {
    const s = String(r).trim();
    if (executionQualitySubtypeFromRaw(s) != null) out.push(s);
  }
  return out;
}

/** Extract raw execution-quality reasons from executionQualitySnapshotJson (blockingReasons + warnings). */
function eqRawFromSnapshot(json: string | null | undefined): { blocks: string[]; warnings: string[] } {
  if (!json) return { blocks: [], warnings: [] };
  try {
    const o = JSON.parse(json) as { blockingReasons?: unknown[]; warnings?: unknown[] };
    const blocks = Array.isArray(o?.blockingReasons)
      ? (o.blockingReasons as string[]).filter((r) => executionQualitySubtypeFromRaw(r) != null)
      : [];
    const warnings = Array.isArray(o?.warnings)
      ? (o.warnings as string[]).filter((r) => executionQualitySubtypeFromRaw(r) != null)
      : [];
    return { blocks, warnings };
  } catch {
    return { blocks: [], warnings: [] };
  }
}

/** Exported for tests: build recommendation row from subtype stats and min evaluated threshold. */
export function buildRecommendation(
  subtype: ExecutionQualitySubtype,
  stats: EqSubtypeStats,
  minEval: number
): EqCalibrationRecommendationRow {
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
    allowedWithWarningCount: stats.allowedWithWarningCount,
    evaluatedAllowedWithWarning: stats.evaluatedAllowedWithWarning,
    badAllowCount: stats.badAllowCount,
    minEvaluatedForRecommendation: minEval,
  };
}

function recommendationFromStats(
  stats: EqSubtypeStats,
  minEval: number
): EqCalibrationRecommendation {
  const evBlocked = stats.evaluatedBlocked;
  const evAllowedWarn = stats.evaluatedAllowedWithWarning;

  if (evBlocked < minEval && evAllowedWarn < minEval) {
    return "insufficient_data";
  }

  if (evBlocked >= minEval) {
    const total = stats.goodBlockCount + stats.badBlockCount;
    if (total > 0) {
      const badRate = stats.badBlockCount / total;
      const goodRate = stats.goodBlockCount / total;
      if (badRate >= HIGH_BAD_BLOCK_RATE) return "review_loosen";
      if (goodRate >= HIGH_GOOD_BLOCK_RATE) return "keep_strict";
    }
  }

  if (evAllowedWarn >= minEval && stats.evaluatedAllowedWithWarning > 0) {
    const badAllowRate = stats.badAllowCount / stats.evaluatedAllowedWithWarning;
    if (badAllowRate >= HIGH_BAD_ALLOW_RATE) return "review_tighten";
  }

  return "monitor";
}

function summaryForRecommendation(rec: EqCalibrationRecommendation, stats: EqSubtypeStats): string {
  switch (rec) {
    case "review_loosen":
      return `High bad_block rate (${stats.badBlockCount}/${stats.evaluatedBlocked} evaluated); consider reviewing threshold for possible loosen.`;
    case "keep_strict":
      return `High good_block rate (${stats.goodBlockCount}/${stats.evaluatedBlocked}); block appears beneficial.`;
    case "review_tighten":
      return `Warn-only cohort has many bad_allows (${stats.badAllowCount}/${stats.evaluatedAllowedWithWarning}); consider tightening to block.`;
    case "insufficient_data":
      return `Insufficient evaluated samples (blocked: ${stats.evaluatedBlocked}, allowed+warn: ${stats.evaluatedAllowedWithWarning}).`;
    case "monitor":
    default:
      return "No strong signal; keep monitoring.";
  }
}

/** Flatten thresholds to a string-keyed record for API (no type leakage). */
function thresholdsToRecord(): Record<string, number> {
  const t = getExecutionQualityThresholds();
  return {
    staleQuoteBlockMs: t.staleQuoteBlockMs,
    staleQuoteWarnMs: t.staleQuoteWarnMs,
    spreadBlockBps: t.spreadBlockBps,
    spreadWarnBps: t.spreadWarnBps,
    minDepthBlockRatio: t.minDepthBlockRatio,
    minDepthWarnRatio: t.minDepthWarnRatio,
    maxPriceDeviationPct: t.maxPriceDeviationPct,
    slippageBlockBps: t.slippageBlockBps,
    slippageWarnBps: t.slippageWarnBps,
    minLiquidityScoreBlock: t.minLiquidityScoreBlock,
    minLiquidityScoreWarn: t.minLiquidityScoreWarn,
  };
}

export async function runExecutionQualityCalibration(
  filters: EqCalibrationFilters = {}
): Promise<ExecutionQualityCalibrationReport> {
  const where: Record<string, unknown> = {};
  if (filters.funderAddress) where.funderAddress = filters.funderAddress.toLowerCase();
  if (filters.source) where.candidateSource = filters.source;

  const candidates = await prisma.shadowCandidate.findMany({
    where,
    orderBy: { createdAt: "desc" },
  });

  const eqRelevant = candidates.filter((c) => {
    if (c.wasBlocked && hasExecutionQualityBlock(c.blockingReasons)) return true;
    if (!c.wasBlocked && snapshotHasEqWarnings(c.executionQualitySnapshotJson)) return true;
    return false;
  });

  let filtered = eqRelevant;
  if (filters.subtype) {
    filtered = eqRelevant.filter((c) => {
      if (c.wasBlocked) {
        const subs = subtypesFromBlockingReasons(c.blockingReasons);
        if (subs.length === 0 && c.executionQualitySnapshotJson) {
          const { blocks } = eqRawFromSnapshot(c.executionQualitySnapshotJson);
          for (const r of blocks) {
            const sub = executionQualitySubtypeFromRaw(r);
            if (sub === filters.subtype) return true;
          }
        }
        return subs.includes(filters.subtype!);
      }
      if (snapshotHasEqWarnings(c.executionQualitySnapshotJson)) {
        try {
          const o = JSON.parse(c.executionQualitySnapshotJson!) as { warnings?: string[] };
          const w = (o?.warnings ?? []) as string[];
          const subs = subtypesFromWarnings(w);
          return subs.includes(filters.subtype!);
        } catch {
          return false;
        }
      }
      return false;
    });
  }
  if (filters.minEvaluated != null) {
    const withEval = filtered.filter((c) => c.evaluatedAt != null);
    if (withEval.length < filters.minEvaluated) filtered = [];
  }

  const perSubtype: Record<string, EqSubtypeStats> = {};
  const markoutBlockedBySub: Record<string, number[]> = {};
  const markoutAllowedBySub: Record<string, number[]> = {};
  for (const sub of ALL_SUBTYPES) {
    perSubtype[sub] = { ...emptySubtypeStats(sub) };
    markoutBlockedBySub[sub] = [];
    markoutAllowedBySub[sub] = [];
  }

  for (const c of filtered) {
    if (c.wasBlocked) {
      const rawReasons = eqRawReasons(c.blockingReasons);
      const fromSnap = eqRawFromSnapshot(c.executionQualitySnapshotJson);
      const allRaw = [...new Set([...rawReasons, ...fromSnap.blocks])];
      const subtypes = new Set<ExecutionQualitySubtype>();
      for (const r of allRaw) {
        const sub = executionQualitySubtypeFromRaw(r);
        if (sub != null) subtypes.add(sub);
      }
      if (subtypes.size === 0) subtypes.add("other");
      const evaluated = c.evaluatedAt != null;
      const goodBlock = c.outcomeClassification === "good_block";
      const badBlock = c.outcomeClassification === "bad_block";
      const markout24h = parseNum(c.markout24h);

      for (const sub of subtypes) {
        const st = perSubtype[sub]!;
        st.blockedCount++;
        if (evaluated) {
          st.evaluatedBlocked++;
          if (goodBlock) st.goodBlockCount++;
          if (badBlock) st.badBlockCount++;
          if (markout24h != null) markoutBlockedBySub[sub]!.push(markout24h);
        }
        for (const r of allRaw.slice(0, 2)) {
          if (!st.rawSamples.includes(r)) st.rawSamples.push(r);
        }
      }
    } else {
      if (!snapshotHasEqWarnings(c.executionQualitySnapshotJson)) continue;
      try {
        const o = JSON.parse(c.executionQualitySnapshotJson!) as { warnings?: string[] };
        const w = ((o?.warnings ?? []) as string[]).filter((r) => executionQualitySubtypeFromRaw(r) != null);
        const subtypes = new Set<ExecutionQualitySubtype>();
        for (const r of w) {
          const sub = executionQualitySubtypeFromRaw(r);
          if (sub != null && sub !== "other") subtypes.add(sub);
        }
        if (subtypes.size === 0) continue;
        const evaluated = c.evaluatedAt != null;
        const goodAllow = c.outcomeClassification === "good_allow";
        const badAllow = c.outcomeClassification === "bad_allow";
        const markout24h = parseNum(c.markout24h);

        for (const sub of subtypes) {
          const st = perSubtype[sub]!;
          st.allowedWithWarningCount++;
          if (evaluated) {
            st.evaluatedAllowedWithWarning++;
            if (goodAllow) st.goodAllowCount++;
            if (badAllow) st.badAllowCount++;
            if (markout24h != null) markoutAllowedBySub[sub]!.push(markout24h);
          }
          for (const r of w.slice(0, 2)) {
            if (!st.rawSamples.includes(r)) st.rawSamples.push(r);
          }
        }
      } catch {
        // skip
      }
    }
  }

  const minEval = filters.minEvaluated ?? MIN_EVALUATED_FOR_RECOMMENDATION;
  const recommendations: EqCalibrationRecommendationRow[] = [];
  for (const sub of ALL_SUBTYPES) {
    const st = perSubtype[sub]!;
    st.averageMarkout24hBlocked = avg(markoutBlockedBySub[sub] ?? []);
    st.averageMarkout24hAllowedWithWarning = avg(markoutAllowedBySub[sub] ?? []);
    recommendations.push(buildRecommendation(sub, st, minEval));
  }

  const perSubtypeTyped: Record<ExecutionQualitySubtype, EqSubtypeStats | undefined> = {} as Record<
    ExecutionQualitySubtype,
    EqSubtypeStats | undefined
  >;
  for (const k of ALL_SUBTYPES) {
    perSubtypeTyped[k] = perSubtype[k];
  }

  return {
    currentThresholds: thresholdsToRecord(),
    perSubtype: perSubtypeTyped,
    recommendations,
    totalCandidates: candidates.length,
    eqRelevantCandidates: eqRelevant.length,
    filters: {
      funderAddress: filters.funderAddress,
      minEvaluated: filters.minEvaluated,
      subtype: filters.subtype,
      source: filters.source,
    },
  };
}
