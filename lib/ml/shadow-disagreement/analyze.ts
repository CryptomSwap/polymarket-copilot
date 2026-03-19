/**
 * Advisory disagreement analysis: compare staged decision outcomes vs shadow ML scores.
 * Groups by (staged_cohort, shadow_band), computes outcome counts and usefulness. No runtime change.
 */

import { prisma } from "@/lib/db";
import { getActiveOrApprovedShadowModel } from "@/lib/ml/shadow-score";
import { predictProbaLogistic } from "@/lib/ml/baseline";
import { toShadowFeatureVector } from "@/lib/ml/shadow-train/features";
import type {
  StagedCohort,
  ShadowBand,
  CohortKey,
  CohortStats,
  DisagreementAnalysisFilters,
  DisagreementAnalysisResult,
  DisagreementSampleRow,
  OutcomeClassification,
} from "./types";

const BAND_HIGH = 0.6;
const BAND_MEDIUM = 0.4;

function parseNum(s: string | null | undefined): number | null {
  if (s == null || s === "") return null;
  const n = parseFloat(String(s).trim());
  return Number.isFinite(n) ? n : null;
}

/** Derive staged cohort from row. */
export function getStagedCohort(row: {
  wasBlocked: boolean;
  wasSubmitted: boolean;
  reducedSizeIndicator: boolean;
}): StagedCohort {
  if (row.wasBlocked) return "staged_block";
  if (row.reducedSizeIndicator) return "staged_reduce";
  return "staged_allow";
}

/** Score -> band (same as shadow-score). */
export function getShadowBand(score: number): ShadowBand {
  if (score >= BAND_HIGH) return "high";
  if (score >= BAND_MEDIUM) return "medium";
  return "low";
}

/** Agreement: staged and shadow aligned. Block+low, allow+high, reduce+medium/high. */
function isAgreement(stagedCohort: StagedCohort, shadowBand: ShadowBand): boolean {
  if (stagedCohort === "staged_block") return shadowBand === "low";
  if (stagedCohort === "staged_allow") return shadowBand === "high";
  if (stagedCohort === "staged_reduce") return shadowBand === "medium" || shadowBand === "high";
  return false;
}

/** Outcome favors staged: we blocked and good_block, or we allowed and good_allow. */
function outcomeFavorsStaged(
  outcome: OutcomeClassification | null,
  stagedCohort: StagedCohort
): boolean {
  if (outcome == null) return false;
  if (stagedCohort === "staged_block") return outcome === "good_block";
  if (stagedCohort === "staged_allow" || stagedCohort === "staged_reduce") return outcome === "good_allow";
  return false;
}

/** Outcome favors shadow: we blocked and bad_block (missed opportunity), or we allowed and bad_allow. */
function outcomeFavorsShadow(
  outcome: OutcomeClassification | null,
  stagedCohort: StagedCohort
): boolean {
  if (outcome == null) return false;
  if (stagedCohort === "staged_block") return outcome === "bad_block";
  if (stagedCohort === "staged_allow" || stagedCohort === "staged_reduce") return outcome === "bad_allow";
  return false;
}

/** Build feature input from MlShadowTrainingExample row. */
function rowToFeatureInput(row: {
  policyState: string | null;
  sizeMultiplier: string | null;
  finalSuggestedSize: string | null;
  eligibilityBlockersCount: number;
  reducedSizeIndicator: boolean;
  blockedIndicator: boolean;
  executionAllow: boolean | null;
  executionWarningCount: number;
  qualityState: string | null;
  spreadBps: string | null;
  estimatedSlippage: string | null;
  tradable: boolean | null;
  grossExposure: string | null;
  totalOpenExposure: string | null;
  maxSingleMarketConcentrationPct: string | null;
  maxSingleThemeConcentrationPct: string | null;
  portfolioRiskFlagsCount: number;
  runtimeWarningCount: number;
  runtimeBlockingCount: number;
  intendedPrice: string;
  intendedSize: string;
  recommendationPresent: boolean;
  side: string;
  outcomeBlockedVsAllowedVsSubmitted: string | null;
}) {
  return {
    policyState: row.policyState,
    sizeMultiplier: row.sizeMultiplier,
    finalSuggestedSize: row.finalSuggestedSize,
    eligibilityBlockersCount: row.eligibilityBlockersCount,
    reducedSizeIndicator: row.reducedSizeIndicator,
    blockedIndicator: row.blockedIndicator,
    executionAllow: row.executionAllow,
    executionWarningCount: row.executionWarningCount,
    qualityState: row.qualityState,
    spreadBps: row.spreadBps,
    estimatedSlippage: row.estimatedSlippage,
    tradable: row.tradable,
    grossExposure: row.grossExposure,
    totalOpenExposure: row.totalOpenExposure,
    maxSingleMarketConcentrationPct: row.maxSingleMarketConcentrationPct,
    maxSingleThemeConcentrationPct: row.maxSingleThemeConcentrationPct,
    portfolioRiskFlagsCount: row.portfolioRiskFlagsCount,
    runtimeWarningCount: row.runtimeWarningCount,
    runtimeBlockingCount: row.runtimeBlockingCount,
    intendedPrice: row.intendedPrice,
    intendedSize: row.intendedSize,
    recommendationPresent: row.recommendationPresent,
    side: row.side,
    outcomeBlockedVsAllowedVsSubmitted: row.outcomeBlockedVsAllowedVsSubmitted as
      | "blocked"
      | "allowed"
      | "submitted"
      | null,
  };
}

export async function runDisagreementAnalysis(
  filters: DisagreementAnalysisFilters = {}
): Promise<DisagreementAnalysisResult> {
  const { funderAddress, candidateSource, shadowBand, stagedCohort, limit = 5000 } = filters;

  const where: { funderAddress?: string; candidateSource?: string } = {};
  if (funderAddress) where.funderAddress = funderAddress.toLowerCase().trim();
  if (candidateSource) where.candidateSource = candidateSource;

  const modelResult = await getActiveOrApprovedShadowModel();
  const rows = await prisma.mlShadowTrainingExample.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  const cohortMap = new Map<string, {
    total: number;
    evaluated: number;
    goodBlock: number;
    badBlock: number;
    goodAllow: number;
    badAllow: number;
    markout24hSum: number;
    markout24hCount: number;
    stagedRightCount: number;
    shadowRightCount: number;
  }>();

  const key = (c: StagedCohort, b: ShadowBand) => `${c}:${b}`;
  const init = (c: StagedCohort, b: ShadowBand) => {
    const k = key(c, b);
    if (!cohortMap.has(k)) {
      cohortMap.set(k, {
        total: 0,
        evaluated: 0,
        goodBlock: 0,
        badBlock: 0,
        goodAllow: 0,
        badAllow: 0,
        markout24hSum: 0,
        markout24hCount: 0,
        stagedRightCount: 0,
        shadowRightCount: 0,
      });
    }
  };

  let agreementCount = 0;
  let disagreementCount = 0;
  const samples: DisagreementSampleRow[] = [];
  const maxSamples = 50;

  const emptyCohort = (
    stagedCohort: StagedCohort,
    shadowBand: ShadowBand
  ): CohortStats => ({
    cohortKey: { stagedCohort, shadowBand },
    total: 0,
    evaluated: 0,
    goodBlock: 0,
    badBlock: 0,
    goodAllow: 0,
    badAllow: 0,
    averageMarkout24h: null,
    stagedRightCount: 0,
    shadowRightCount: 0,
    usefulnessSummary: "insufficient",
  });

  if (!modelResult) {
    const emptyCohorts: CohortStats[] = [];
    for (const staged of ["staged_block", "staged_allow", "staged_reduce"] as StagedCohort[]) {
      for (const band of ["low", "medium", "high"] as ShadowBand[]) {
        emptyCohorts.push(emptyCohort(staged, band));
      }
    }
    return {
      modelId: null,
      cohortStats: emptyCohorts,
      agreementRate: null,
      disagreementRate: null,
      totalRows: rows.length,
      evaluatedRows: 0,
      recentSamples: [],
      advisoryOnly: true,
    };
  }

  const { model, run } = modelResult;

  for (const staged of ["staged_block", "staged_allow", "staged_reduce"] as StagedCohort[]) {
    for (const band of ["low", "medium", "high"] as ShadowBand[]) {
      init(staged, band);
    }
  }

  for (const row of rows) {
    const staged = getStagedCohort({
      wasBlocked: row.wasBlocked,
      wasSubmitted: row.wasSubmitted,
      reducedSizeIndicator: row.reducedSizeIndicator,
    });
    const vec = toShadowFeatureVector(rowToFeatureInput(row));
    const score = predictProbaLogistic(model, vec);
    const band = getShadowBand(score);

    if (stagedCohort != null && staged !== stagedCohort) continue;
    if (shadowBand != null && band !== shadowBand) continue;

    init(staged, band);
    const agg = cohortMap.get(key(staged, band))!;
    agg.total += 1;

    const outcome = row.outcomeClassification as OutcomeClassification | null;
    const hasOutcome = outcome != null;
    if (hasOutcome) {
      agg.evaluated += 1;
      if (outcome === "good_block") agg.goodBlock += 1;
      if (outcome === "bad_block") agg.badBlock += 1;
      if (outcome === "good_allow") agg.goodAllow += 1;
      if (outcome === "bad_allow") agg.badAllow += 1;
      const m = parseNum(row.markout24h);
      if (m != null) {
        agg.markout24hSum += m;
        agg.markout24hCount += 1;
      }
      if (outcomeFavorsStaged(outcome, staged)) agg.stagedRightCount += 1;
      if (outcomeFavorsShadow(outcome, staged)) agg.shadowRightCount += 1;
    }

    if (isAgreement(staged, band)) agreementCount++;
    else disagreementCount++;

    if (samples.length < maxSamples) {
      samples.push({
        shadowCandidateId: row.shadowCandidateId,
        stagedCohort: staged,
        shadowBand: band,
        shadowScore: score,
        outcomeClassification: outcome,
        markout24h: parseNum(row.markout24h),
        candidateSource: row.candidateSource,
        createdAt: row.createdAt.toISOString(),
      });
    }
  }

  const cohortStats: CohortStats[] = [];
  const stagedCohorts: StagedCohort[] = ["staged_block", "staged_allow", "staged_reduce"];
  const bands: ShadowBand[] = ["low", "medium", "high"];
  for (const staged of stagedCohorts) {
    for (const band of bands) {
      const k = key(staged, band);
      const agg = cohortMap.get(k)!;
      let usefulnessSummary: CohortStats["usefulnessSummary"] = "insufficient";
      if (agg.evaluated >= 3) {
        if (agg.stagedRightCount > agg.shadowRightCount) usefulnessSummary = "staged_more_right";
        else if (agg.shadowRightCount > agg.stagedRightCount) usefulnessSummary = "shadow_more_right";
        else usefulnessSummary = "tie";
      }
      cohortStats.push({
        cohortKey: { stagedCohort: staged, shadowBand: band },
        total: agg.total,
        evaluated: agg.evaluated,
        goodBlock: agg.goodBlock,
        badBlock: agg.badBlock,
        goodAllow: agg.goodAllow,
        badAllow: agg.badAllow,
        averageMarkout24h:
          agg.markout24hCount > 0 ? agg.markout24hSum / agg.markout24hCount : null,
        stagedRightCount: agg.stagedRightCount,
        shadowRightCount: agg.shadowRightCount,
        usefulnessSummary,
      });
    }
  }

  const totalWithCohort = agreementCount + disagreementCount;
  const agreementRate = totalWithCohort > 0 ? agreementCount / totalWithCohort : null;
  const disagreementRate = totalWithCohort > 0 ? disagreementCount / totalWithCohort : null;
  const evaluatedRows = rows.filter((r) => r.outcomeClassification != null).length;

  return {
    modelId: run.id,
    cohortStats,
    agreementRate,
    disagreementRate,
    totalRows: rows.length,
    evaluatedRows,
    recentSamples: samples,
    advisoryOnly: true,
  };
}
