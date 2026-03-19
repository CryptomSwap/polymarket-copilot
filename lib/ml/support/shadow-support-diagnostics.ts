/**
 * Shadow ML support diagnostics (read-only).
 * Distinguishes well-supported scores from sparse/weakly-supported ones.
 * Does not change admission, thresholds, model selection, or training.
 * Reuses lib/ml/support (segment-support, scoring-support) and audit (label coverage).
 */

import { prisma } from "@/lib/db";
import { buildSegmentSupportMap, DEFAULT_MIN_SUPPORT } from "./segment-support";
import type { SegmentSupportSummary } from "./types";
import { runShadowLabelCoverageAudit } from "@/lib/ml/audits/shadow-label-coverage-audit";

export type SupportBucket = "high" | "medium" | "low";

export type SupportReasonCode =
  | "low_label_coverage"
  | "sparse_segment_history"
  | "missing_feature_values"
  | "old_schema_missing_dimensions"
  | "no_training_support_metadata"
  | "coarse_segment_fallback"
  | "challenger_unavailable"
  | "feature_completeness_ok"
  | "segment_supported"
  | "label_coverage_adequate";

export type SupportProvenance = "exact" | "heuristic" | "mixed";

export interface ShadowSupportDiagnostic {
  supportBucket: SupportBucket;
  supportReasonCodes: string[];
  featureCompletenessPct: number | null;
  featureCompletenessWarnings: string[];
  labelCoveragePct: number | null;
  segmentSupportCount: number | null;
  lowSupportWarning: boolean;
  confidenceNotes: string[];
  provenance: SupportProvenance;
}

export interface ShadowSupportDiagnosticsReport {
  generatedAt: string;
  whatSupportMeans: string[];
  exactSignals: string[];
  heuristicSignals: string[];
  cannotCompute: string[];
  global: {
    labelCoveragePct: number | null;
    totalPaperTrades: number;
    totalLabeled: number;
    challengerCoveragePct: number | null;
    segmentCount: number;
    segmentsBelowMinSupport: number;
    modelTrainCount: number | null;
  };
  segmentSupportSummary: Array<{
    segmentKey: string;
    trainingCount: number;
    belowMinSupport: boolean;
  }>;
  lowSupportSegments: Array<{ segmentKey: string; count: number; reason: string }>;
  sampleDiagnostics: Array<{
    id: string;
    botType: string | null;
    score: number;
    diagnostic: ShadowSupportDiagnostic;
  }>;
  caveats: string[];
}

const SHADOW_MODEL_TYPE = "logistic_regression_shadow";
const LOOKBACK_DAYS = 90;
const MIN_SUPPORT_SEGMENT = 10;
const SAMPLE_TRADES_LIMIT = 30;

/**
 * Feature completeness warnings aligned with score-live.ts buildFeatureWarnings.
 * Used when we have partial context (e.g. PaperTrade) to approximate completeness.
 */
function featureWarningsFromPartialContext(ctx: {
  policyState?: string | null;
  qualityState?: string | null;
  spreadBps?: string | null;
  tradable?: boolean | null;
  grossExposure?: string | null;
  totalOpenExposure?: string | null;
  executionAllow?: boolean | null;
}): string[] {
  const w: string[] = [];
  if (ctx.grossExposure == null && ctx.totalOpenExposure == null) w.push("portfolio_exposure_missing");
  if (ctx.qualityState == null && ctx.spreadBps == null && ctx.tradable == null) w.push("execution_quality_partial");
  if (ctx.policyState == null && ctx.executionAllow == null) w.push("decision_policy_partial");
  return w;
}

/**
 * Heuristic feature completeness % from warnings: 3 known check groups, each missing adds ~33%.
 */
function featureCompletenessPctFromWarnings(warnings: string[]): number {
  const totalChecks = 3;
  const missing = Math.min(warnings.length, totalChecks);
  return totalChecks > 0 ? Math.round(((totalChecks - missing) / totalChecks) * 100) : 0;
}

function bucketFromSignals(params: {
  labelCoveragePct: number | null;
  segmentSupportCount: number | null;
  featureWarningsCount: number;
  challengerAvailable: boolean | null;
}): { bucket: SupportBucket; reasonCodes: string[] } {
  const { labelCoveragePct, segmentSupportCount, featureWarningsCount, challengerAvailable } = params;
  const reasons: string[] = [];

  const lowCoverage = labelCoveragePct != null && labelCoveragePct < 20;
  const sparseSegment = segmentSupportCount != null && segmentSupportCount < MIN_SUPPORT_SEGMENT;
  const hasFeatureGaps = featureWarningsCount > 0;
  const noChallenger = challengerAvailable === false;

  if (lowCoverage) reasons.push("low_label_coverage");
  if (sparseSegment) reasons.push("sparse_segment_history");
  if (hasFeatureGaps) reasons.push("missing_feature_values");
  if (noChallenger) reasons.push("challenger_unavailable");
  if (labelCoveragePct != null && labelCoveragePct >= 50) reasons.push("label_coverage_adequate");
  if (segmentSupportCount != null && segmentSupportCount >= MIN_SUPPORT_SEGMENT) reasons.push("segment_supported");
  if (!hasFeatureGaps) reasons.push("feature_completeness_ok");

  const lowReasons = [lowCoverage, sparseSegment, hasFeatureGaps].filter(Boolean).length;
  if (lowReasons >= 2) return { bucket: "low", reasonCodes: reasons };
  if (lowReasons >= 1 || noChallenger) return { bucket: "medium", reasonCodes: reasons };
  return { bucket: "high", reasonCodes: reasons };
}

export async function getShadowSupportDiagnosticsReport(): Promise<ShadowSupportDiagnosticsReport> {
  const from = new Date();
  from.setDate(from.getDate() - LOOKBACK_DAYS);

  const whatSupportMeans: string[] = [
    "Support = how much we can trust a score given feature completeness, training/segment support, and label coverage.",
    "Exact: from persisted data (audit label coverage, segment counts from PaperTrade/MlShadowTrainingExample, model trainCount if in metricsJson).",
    "Heuristic: feature completeness inferred from stored fields when full ShadowScoreInput is not available; segment keys from coarse dimensions.",
  ];
  const exactSignals: string[] = [
    "Label coverage % from shadow-label-coverage-audit (PaperTrade joined to MlShadowTrainingExample).",
    "Segment support counts from PaperTrade grouped by botType, targetLabel, policyState, entryPriceBand, theme, category.",
    "Challenger coverage from PaperTrade.challengerAvailable.",
    "Model trainCount from MlModelRun.metricsJson when present.",
  ];
  const heuristicSignals: string[] = [
    "Feature completeness inferred from PaperTrade fields (sourceDecisionState, etc.) when full scoring input not stored.",
    "Support bucket (high/medium/low) from thresholds on label coverage, segment count, feature warnings.",
  ];
  const cannotCompute: string[] = [
    "True out-of-distribution or distance-to-training without retraining or persisted training distribution.",
    "Per-feature importance or per-segment calibration without richer persisted metadata.",
  ];

  let auditResult: Awaited<ReturnType<typeof runShadowLabelCoverageAudit>>;
  let auditFallback = false;
  try {
    auditResult = await runShadowLabelCoverageAudit({ lookbackDays: LOOKBACK_DAYS, minSupport: MIN_SUPPORT_SEGMENT });
  } catch {
    auditFallback = true;
    auditResult = {
      global: {
        totalPaperTrades: 0,
        totalWithResolvedExample: 0,
        totalLabeled: 0,
        totalUnlabeled: 0,
        labelCoveragePct: null,
        avgScore: null,
        empiricalPositiveRate: null,
        calibrationGap: null,
        brierLikeError: null,
        winCount: 0,
        lossCount: 0,
        scoreBucketCounts: {},
      },
      byBotType: [],
      byTargetLabel: [],
      byPolicyState: [],
      byPaperPolicyMode: [],
      byPaperRelaxationReason: [],
      byEntryPriceBand: [],
      byTheme: [],
      byCategory: [],
      byChallengerAvailable: [],
      byExplorationAdmissionMode: [],
      riskSegments: [],
      caveats: [],
      dimensionsNotAvailable: [],
      generatedAt: new Date().toISOString(),
      assumptions: [],
      primaryTarget: "labelGoodDecision12h",
      lookbackDays: LOOKBACK_DAYS,
      minSupport: MIN_SUPPORT_SEGMENT,
    };
  }

  const globalLabelCoveragePct = auditResult.global.labelCoveragePct;
  const totalPaperTrades = auditResult.global.totalPaperTrades;
  const totalLabeled = auditResult.global.totalLabeled;

  type TradeRow = {
    id: string;
    score: number;
    botType?: string | null;
    targetLabel?: string | null;
    sourceDecisionState?: string | null;
    entryPriceBand?: string | null;
    theme?: string | null;
    category?: string | null;
    challengerAvailable?: boolean | null;
  };

  let trades: TradeRow[];
  let usedMinimalTradeSelect = false;
  try {
    trades = (await prisma.paperTrade.findMany({
      where: { entryTime: { gte: from } },
      select: {
        id: true,
        score: true,
        botType: true,
        targetLabel: true,
        sourceDecisionState: true,
        entryPriceBand: true,
        theme: true,
        category: true,
        challengerAvailable: true,
      },
      orderBy: { entryTime: "desc" },
      take: 500,
    })) as TradeRow[];
  } catch {
    usedMinimalTradeSelect = true;
    trades = (await prisma.paperTrade.findMany({
      where: { entryTime: { gte: from } },
      select: { id: true, score: true },
      orderBy: { entryTime: "desc" },
      take: 500,
    })) as TradeRow[];
  }

  const segmentValues = trades.map((t) => ({
    botType: t.botType ?? "unknown",
    targetLabel: t.targetLabel ?? "unknown",
    policyState: t.sourceDecisionState ?? "unknown",
    entryPriceBand: t.entryPriceBand ?? "unknown",
    theme: t.theme ?? "unknown",
    category: t.category ?? "unknown",
  }));
  const segmentMap = buildSegmentSupportMap(segmentValues, MIN_SUPPORT_SEGMENT);
  const segmentEntries = Array.from(segmentMap.entries()).map(([k, v]) => ({
    segmentKey: k,
    trainingCount: v.trainingCount,
    belowMinSupport: v.trainingCount < MIN_SUPPORT_SEGMENT,
  }));
  const segmentsBelowMinSupport = segmentEntries.filter((e) => e.belowMinSupport).length;

  let challengerCoveragePct: number | null = null;
  if (trades.length > 0 && "challengerAvailable" in trades[0]) {
    const withChallenger = trades.filter((t) => (t as TradeRow).challengerAvailable === true).length;
    challengerCoveragePct = (withChallenger / trades.length) * 100;
  }

  let modelTrainCount: number | null = null;
  try {
    const run = await prisma.mlModelRun.findFirst({
      where: { modelType: SHADOW_MODEL_TYPE, status: { in: ["ACTIVE", "APPROVED"] } },
      orderBy: { updatedAt: "desc" },
      select: { metricsJson: true },
    });
    if (run?.metricsJson) {
      try {
        const parsed = JSON.parse(run.metricsJson) as Record<string, unknown>;
        if (typeof parsed.trainCount === "number") modelTrainCount = parsed.trainCount;
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }

  const lowSupportSegments: Array<{ segmentKey: string; count: number; reason: string }> = [];
  for (const [key, summary] of segmentMap) {
    if (summary.trainingCount < MIN_SUPPORT_SEGMENT) {
      lowSupportSegments.push({
        segmentKey: key,
        count: summary.trainingCount,
        reason: "sparse_segment_history",
      });
    }
  }
  lowSupportSegments.sort((a, b) => a.count - b.count);

  const sampleDiagnostics: ShadowSupportDiagnosticsReport["sampleDiagnostics"] = [];
  const sample = trades.slice(0, SAMPLE_TRADES_LIMIT);
  for (const t of sample) {
    const segmentKeys: Record<string, string> = {
      botType: t.botType ?? "unknown",
      targetLabel: t.targetLabel ?? "unknown",
      policyState: t.sourceDecisionState ?? "unknown",
      entryPriceBand: t.entryPriceBand ?? "unknown",
      theme: t.theme ?? "unknown",
      category: t.category ?? "unknown",
    };
    const segmentKey = Object.entries(segmentKeys)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([k, v]) => `${k}=${v}`)
      .join("|");
    const segmentSummary = segmentMap.get(segmentKey);
    const segmentSupportCount = segmentSummary?.trainingCount ?? null;

    const featureWarnings = featureWarningsFromPartialContext({
      policyState: t.sourceDecisionState ?? null,
      qualityState: null,
      spreadBps: null,
      tradable: null,
      grossExposure: null,
      totalOpenExposure: null,
      executionAllow: null,
    });
    const featureCompletenessPct = featureCompletenessPctFromWarnings(featureWarnings);

    const { bucket, reasonCodes } = bucketFromSignals({
      labelCoveragePct: globalLabelCoveragePct,
      segmentSupportCount,
      featureWarningsCount: featureWarnings.length,
      challengerAvailable: t.challengerAvailable ?? null,
    });

    const lowSupportWarning = bucket === "low" || bucket === "medium";
    const confidenceNotes: string[] = [];
    if (globalLabelCoveragePct != null && globalLabelCoveragePct < 30) confidenceNotes.push("Global label coverage low; calibration uncertain.");
    if (segmentSupportCount != null && segmentSupportCount < MIN_SUPPORT_SEGMENT) confidenceNotes.push("Segment has few historical trades.");
    if (featureWarnings.length > 0) confidenceNotes.push("Some feature groups missing or partial (heuristic from stored fields).");

    const provenance: SupportProvenance =
      featureWarnings.length > 0 && (segmentSupportCount == null || globalLabelCoveragePct == null) ? "heuristic" : segmentSupportCount != null && globalLabelCoveragePct != null ? "mixed" : "exact";

    sampleDiagnostics.push({
      id: t.id,
      botType: t.botType ?? null,
      score: Number.isFinite(t.score) ? (t.score as number) : 0,
      diagnostic: {
        supportBucket: bucket,
        supportReasonCodes: reasonCodes,
        featureCompletenessPct,
        featureCompletenessWarnings: featureWarnings,
        labelCoveragePct: globalLabelCoveragePct,
        segmentSupportCount,
        lowSupportWarning,
        confidenceNotes,
        provenance,
      },
    });
  }

  const caveats: string[] = [
    "Feature completeness for past trades is inferred from stored dimensions (e.g. sourceDecisionState), not from full ShadowScoreInput.",
    "Segment support uses coarse dimensions (botType, targetLabel, policyState, entryPriceBand, theme, category); fine-grained support not computed.",
    "Support bucket is diagnostic only; no behavior gates or admission changes.",
  ];
  if (usedMinimalTradeSelect) {
    caveats.push("Segment dimension columns were unavailable (older schema); segment keys use fallback 'unknown'.");
  }
  if (auditFallback) {
    caveats.push("Label coverage audit failed (e.g. missing DB columns); global label coverage and totals are fallback values.");
  }

  return {
    generatedAt: new Date().toISOString(),
    whatSupportMeans,
    exactSignals,
    heuristicSignals,
    cannotCompute,
    global: {
      labelCoveragePct: globalLabelCoveragePct,
      totalPaperTrades,
      totalLabeled,
      challengerCoveragePct,
      segmentCount: segmentMap.size,
      segmentsBelowMinSupport,
      modelTrainCount,
    },
    segmentSupportSummary: segmentEntries.sort((a, b) => b.trainingCount - a.trainingCount).slice(0, 50),
    lowSupportSegments: lowSupportSegments.slice(0, 20),
    sampleDiagnostics,
    caveats,
  };
}

/**
 * Build a support diagnostic for a candidate at score time when full ShadowScoreInput and optional segment map are available.
 * Exact feature warnings; segment support exact if map provided.
 */
export function buildSupportDiagnosticForCandidate(params: {
  featureCompletenessWarnings: string[];
  labelCoveragePct: number | null;
  segmentSupportMap?: Map<string, SegmentSupportSummary>;
  segmentKeys?: Record<string, string>;
  challengerAvailable?: boolean | null;
}): ShadowSupportDiagnostic {
  const {
    featureCompletenessWarnings,
    labelCoveragePct,
    segmentSupportMap,
    segmentKeys,
    challengerAvailable,
  } = params;

  let segmentSupportCount: number | null = null;
  if (segmentSupportMap && segmentKeys) {
    const key = Object.entries(segmentKeys)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([k, v]) => `${k}=${v ?? "unknown"}`)
      .join("|");
    segmentSupportCount = segmentSupportMap.get(key)?.trainingCount ?? null;
  }

  const featureCompletenessPct = featureCompletenessPctFromWarnings(featureCompletenessWarnings);
  const { bucket, reasonCodes } = bucketFromSignals({
    labelCoveragePct,
    segmentSupportCount,
    featureWarningsCount: featureCompletenessWarnings.length,
    challengerAvailable,
  });

  const confidenceNotes: string[] = [];
  if (labelCoveragePct != null && labelCoveragePct < 30) confidenceNotes.push("Label coverage low.");
  if (segmentSupportCount != null && segmentSupportCount < MIN_SUPPORT_SEGMENT) confidenceNotes.push("Segment sparse.");
  if (featureCompletenessWarnings.length > 0) confidenceNotes.push("Feature completeness gaps (from score-time warnings).");

  const provenance: SupportProvenance =
    featureCompletenessWarnings.length > 0 ? (segmentSupportMap && segmentKeys ? "mixed" : "heuristic") : segmentSupportMap && segmentKeys ? "exact" : "heuristic";

  return {
    supportBucket: bucket,
    supportReasonCodes: reasonCodes,
    featureCompletenessPct,
    featureCompletenessWarnings,
    labelCoveragePct,
    segmentSupportCount,
    lowSupportWarning: bucket === "low" || bucket === "medium",
    confidenceNotes,
    provenance,
  };
}
