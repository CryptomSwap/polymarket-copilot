/**
 * Shadow outcome analysis: group by reason, compute quality stats, produce calibration suggestions.
 * Descriptive only; no automatic threshold changes.
 */

import { prisma } from "@/lib/db";
import { normalizeBlockingReasons } from "./reasons";
import type {
  ShadowAnalysisSummary,
  ShadowAnalysisFilters,
  ShadowReasonStats,
  ShadowThresholdCalibrationReport,
  CalibrationSuggestion,
} from "./types";

const MIN_EVALUATED_FOR_SUGGESTION = 5;
const HIGH_BAD_BLOCK_RATE = 0.5;
const HIGH_GOOD_BLOCK_RATE = 0.6;

function parseNum(s: string | null | undefined): number | null {
  if (s == null || s === "") return null;
  const n = parseFloat(String(s).trim());
  return Number.isFinite(n) ? n : null;
}

function avg(arr: number[]): number | null {
  if (arr.length === 0) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

export async function runShadowAnalysis(
  filters: ShadowAnalysisFilters = {}
): Promise<ShadowAnalysisSummary> {
  const where: Record<string, unknown> = {};
  if (filters.funderAddress) where.funderAddress = filters.funderAddress.toLowerCase();
  if (filters.onlyEvaluated) where.evaluatedAt = { not: null };
  if (filters.source) where.candidateSource = filters.source;

  const candidates = await prisma.shadowCandidate.findMany({
    where,
    orderBy: { createdAt: "desc" },
  });

  let filtered = candidates;
  if (filters.reasonGroup) {
    filtered = candidates.filter((c) => {
      if (!c.wasBlocked || !c.blockingReasons) return false;
      const { groups } = normalizeBlockingReasons(c.blockingReasons as string[]);
      return groups.includes(filters.reasonGroup!);
    });
  }
  if (filters.minCandidates != null && filtered.length < filters.minCandidates) {
    filtered = [];
  }

  const totalCandidates = filtered.length;
  const blocked = filtered.filter((c) => c.wasBlocked);
  const allowed = filtered.filter((c) => !c.wasBlocked);
  const evaluated = filtered.filter((c) => c.evaluatedAt != null);
  const withClassification = evaluated.filter((c) => c.outcomeClassification != null);

  const goodBlocks = withClassification.filter((c) => c.outcomeClassification === "good_block").length;
  const badBlocks = withClassification.filter((c) => c.outcomeClassification === "bad_block").length;
  const goodAllows = withClassification.filter((c) => c.outcomeClassification === "good_allow").length;
  const badAllows = withClassification.filter((c) => c.outcomeClassification === "bad_allow").length;

  const markouts1h = evaluated.map((c) => parseNum(c.markout1h)).filter((n): n is number => n != null);
  const markouts6h = evaluated.map((c) => parseNum(c.markout6h)).filter((n): n is number => n != null);
  const markouts24h = evaluated.map((c) => parseNum(c.markout24h)).filter((n): n is number => n != null);

  type ReasonStatsAcc = ShadowReasonStats & { _markout24hBlocked: number[] };
  const byReasonGroupAcc: Record<string, ReasonStatsAcc> = {};
  for (const c of blocked) {
    const rawReasons = (c.blockingReasons as string[] | null) ?? [];
    const { groups, rawByGroup } = normalizeBlockingReasons(rawReasons);
    if (groups.length === 0) {
      const g = "other";
      if (!byReasonGroupAcc[g]) byReasonGroupAcc[g] = initReasonStats(g) as ReasonStatsAcc;
      byReasonGroupAcc[g].totalBlocked++;
      byReasonGroupAcc[g].rawSamples.push(...rawReasons.slice(0, 3));
      if (c.evaluatedAt != null) {
        byReasonGroupAcc[g].evaluatedBlocked++;
        if (c.outcomeClassification === "good_block") byReasonGroupAcc[g].goodBlocks++;
        if (c.outcomeClassification === "bad_block") byReasonGroupAcc[g].badBlocks++;
        const m = parseNum(c.markout24h);
        if (m != null) byReasonGroupAcc[g]._markout24hBlocked.push(m);
      }
      continue;
    }
    for (const g of groups) {
      if (!byReasonGroupAcc[g]) byReasonGroupAcc[g] = initReasonStats(g) as ReasonStatsAcc;
      byReasonGroupAcc[g].totalBlocked++;
      const samples = rawByGroup[g] ?? [];
      for (const raw of samples.slice(0, 2)) {
        if (!byReasonGroupAcc[g].rawSamples.includes(raw)) byReasonGroupAcc[g].rawSamples.push(raw);
      }
      if (c.evaluatedAt != null) {
        byReasonGroupAcc[g].evaluatedBlocked++;
        if (c.outcomeClassification === "good_block") byReasonGroupAcc[g].goodBlocks++;
        if (c.outcomeClassification === "bad_block") byReasonGroupAcc[g].badBlocks++;
        const m = parseNum(c.markout24h);
        if (m != null) byReasonGroupAcc[g]._markout24hBlocked.push(m);
      }
    }
  }

  const byReasonGroup: Record<string, ShadowReasonStats> = {};
  const allowedEvaluated = allowed.filter((c) => c.evaluatedAt != null);
  const allowedMarkouts = allowedEvaluated.map((c) => parseNum(c.markout24h)).filter((n): n is number => n != null);
  for (const g of Object.keys(byReasonGroupAcc)) {
    const r = byReasonGroupAcc[g];
    const { _markout24hBlocked, ...rest } = r;
    byReasonGroup[g] = {
      ...rest,
      averageMarkout24hBlocked: avg(_markout24hBlocked),
      allowedCount: allowed.length,
      evaluatedAllowed: allowedEvaluated.length,
      goodAllows,
      badAllows,
      averageMarkout24hAllowed: avg(allowedMarkouts),
    };
  }

  const bySource: Record<string, { total: number; blocked: number; allowed: number; evaluated: number; goodBlock: number; badBlock: number; goodAllow: number; badAllow: number }> = {};
  for (const c of filtered) {
    const src = c.candidateSource || "unknown";
    if (!bySource[src]) {
      bySource[src] = { total: 0, blocked: 0, allowed: 0, evaluated: 0, goodBlock: 0, badBlock: 0, goodAllow: 0, badAllow: 0 };
    }
    bySource[src].total++;
    if (c.wasBlocked) bySource[src].blocked++;
    else bySource[src].allowed++;
    if (c.evaluatedAt != null) {
      bySource[src].evaluated++;
      if (c.outcomeClassification === "good_block") bySource[src].goodBlock++;
      if (c.outcomeClassification === "bad_block") bySource[src].badBlock++;
      if (c.outcomeClassification === "good_allow") bySource[src].goodAllow++;
      if (c.outcomeClassification === "bad_allow") bySource[src].badAllow++;
    }
  }

  let warningOnlyAllowedCount = 0;
  let warningOnlyEvaluatedCount = 0;
  let warningOnlyGoodAllowCount = 0;
  let warningOnlyBadAllowCount = 0;
  for (const c of allowed) {
    const hasWarnings = c.executionPolicySnapshotJson != null && String(c.executionPolicySnapshotJson).includes('"warnings":');
    if (hasWarnings) warningOnlyAllowedCount++;
    if (hasWarnings && c.evaluatedAt != null) {
      warningOnlyEvaluatedCount++;
      if (c.outcomeClassification === "good_allow") warningOnlyGoodAllowCount++;
      if (c.outcomeClassification === "bad_allow") warningOnlyBadAllowCount++;
    }
  }

  const calibrationSuggestions = buildCalibrationSuggestions(byReasonGroup);

  return {
    totalCandidates,
    blockedCandidates: blocked.length,
    allowedCandidates: allowed.length,
    evaluatedCandidates: evaluated.length,
    goodBlocks,
    badBlocks,
    goodAllows,
    badAllows,
    averageMarkout1h: avg(markouts1h),
    averageMarkout6h: avg(markouts6h),
    averageMarkout24h: avg(markouts24h),
    byReasonGroup,
    bySource,
    calibrationSuggestions,
    warningOnlyAllowedCount,
    warningOnlyEvaluatedCount,
    warningOnlyGoodAllowCount,
    warningOnlyBadAllowCount,
  };
}

function initReasonStats(reasonGroup: string): ShadowReasonStats & { _markout24hBlocked: number[] } {
  return {
    reasonGroup,
    totalBlocked: 0,
    evaluatedBlocked: 0,
    goodBlocks: 0,
    badBlocks: 0,
    allowedCount: 0,
    evaluatedAllowed: 0,
    goodAllows: 0,
    badAllows: 0,
    averageMarkout24hBlocked: null,
    averageMarkout24hAllowed: null,
    rawSamples: [],
    _markout24hBlocked: [],
  };
}

function buildCalibrationSuggestions(
  byReasonGroup: Record<string, ShadowReasonStats>
): ShadowThresholdCalibrationReport[] {
  const out: ShadowThresholdCalibrationReport[] = [];
  for (const [group, stats] of Object.entries(byReasonGroup)) {
    const evaluated = stats.evaluatedBlocked;
    const good = stats.goodBlocks;
    const bad = stats.badBlocks;
    let suggestion: CalibrationSuggestion = "insufficient_data";
    let summary = "Insufficient evaluated blocks to suggest calibration.";

    if (evaluated >= MIN_EVALUATED_FOR_SUGGESTION) {
      const badRate = bad / evaluated;
      const goodRate = good / evaluated;
      if (badRate >= HIGH_BAD_BLOCK_RATE) {
        suggestion = "review_threshold";
        summary = `High missed-opportunity rate (${(badRate * 100).toFixed(0)}% bad_block). Consider reviewing whether this gate is too strict.`;
      } else if (goodRate >= HIGH_GOOD_BLOCK_RATE) {
        suggestion = "keep_strict";
        summary = `High beneficial-block rate (${(goodRate * 100).toFixed(0)}% good_block). Gate appears well-calibrated.`;
      } else {
        suggestion = "monitor";
        summary = `Mixed outcomes (${good} good_block, ${bad} bad_block). Monitor for changes.`;
      }
    }

    out.push({
      suggestion,
      reasonGroup: group,
      summary,
      goodBlockCount: good,
      badBlockCount: bad,
      evaluatedCount: evaluated,
      minEvaluatedForSuggestion: MIN_EVALUATED_FOR_SUGGESTION,
    });
  }
  return out.sort((a, b) => b.evaluatedCount - a.evaluatedCount);
}
