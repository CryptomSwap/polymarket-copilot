import { prisma } from "@/lib/db";
import { getFunderForPaperTradingTick } from "@/lib/decision/recompute";
import { getActiveOrApprovedShadowModel, scoreShadowCandidate } from "@/lib/ml/shadow-score";
import { getActiveBotProfiles, type EffectiveBotProfile } from "./bot-profiles";
import {
  loadShadowCandidatesForPaperTick,
  normalizePreferredFunderForShadowLoad,
  type PaperTradingCandidate,
  type ShadowTickLoadDiagnostics,
} from "./candidates";
import { getPaperTradingConfig } from "./config";
import { evaluatePaperLiquidityGuards } from "./paper-roi-admission";
import { buildExternalSignalFeatureVectors } from "./features/external_signal_features";
import { buildStructuredScoringModel, scoreStructuredCandidates } from "./structured_scorer";

export type PaperTickV2RejectReason =
  | "score_failed"
  | "below_threshold"
  | "liquidity_spread"
  | "liquidity_slippage"
  | "global_max_open_total"
  | "bot_max_open"
  | "dedupe";

export interface PaperTickV2TraceEntry {
  botType: string;
  candidateId: string | null;
  recommendationId: string;
  assetId: string;
  marketId: string;
  side: string;
  score: number | null;
  admitted: boolean;
  rejectReason: PaperTickV2RejectReason | null;
}

export interface PaperTradingTickV2Result {
  enabled: boolean;
  modelRunId: string | null;
  tickTime: string;
  funderUsedForCandidateLoad: string | null;
  candidatesLoaded: number;
  candidatesPassedFilter: number;
  tradesOpened: number;
  errors: string[];
  shadowDiagnostics: ShadowTickLoadDiagnostics | null;
  trace: PaperTickV2TraceEntry[];
  rejectReasonDistribution: Record<PaperTickV2RejectReason, number>;
  duplicateExposureSuppression?: {
    enabled: boolean;
    totalSuppressed: number;
    byBotType: Record<string, number>;
    byBand: Record<string, number>;
  };
  dedupeCollisionBreakdown?: {
    preSuppressedAlreadyOpen: number;
    sameTickCollision: number;
    existingDbCollision: number;
    uniqueConstraintCollision: number;
    openRowCollision: number;
    closedRowCollision: number;
    closedRowBypassed: number;
  };
  scorePopulationSnapshot?: {
    scorerSource: "structured" | "shadow_ml";
    uniqueCandidatesScored: number;
    scoreBucketCountsAllCandidates: Record<string, number>;
    scoreBucketCountsFromTraceAdmitted: Record<string, number>;
    scoreBucketCountsFromTraceRejected: Record<string, number>;
  };
  scoreProvenanceSample?: Array<{
    recommendationId: string;
    assetId: string;
    scorerSource: "structured" | "shadow_ml";
    structuredBaseScore: number | null;
    structuredBlendedScore: number | null;
    shadowMlScoreRaw: number | null;
    shadowMlScoreCalibrated: number | null;
    shadowBand: string | null;
    shadowBandRankScore: number | null;
    shadowBandSignal: number | null;
    shadowBandPenaltyMultiplier: number | null;
    finalBandAwareScore: number | null;
    actualScoreUsedForOrdering: number | null;
    actualScoreUsedForThreshold: number | null;
    thresholdApplied: number | null;
    outcomes: Array<{ botType: string; admitted: boolean; rejectReason: PaperTickV2RejectReason | null }>;
  }>;
}

export interface RunPaperTradingTickV2Options {
  funderAddress?: string;
  dryRun?: boolean;
  preloadedCandidates?: PaperTradingCandidate[];
  preloadedShadowDiagnostics?: ShadowTickLoadDiagnostics | null;
  preloadedProfiles?: EffectiveBotProfile[];
  initialOpenTotal?: number;
  initialOpenByBot?: Record<string, number>;
}

type ScoredCandidate = {
  candidate: PaperTradingCandidate;
  score: number;
  shadowMlScoreRaw?: number | null;
  shadowMlScoreCalibrated?: number | null;
  shadowBand?: string | null;
  shadowBandRankScore?: number | null;
  shadowBandSignal?: number | null;
  shadowBandPenaltyMultiplier?: number | null;
  shadowBandAwareScore?: number | null;
  structuredBaseScore?: number | null;
  structuredBandRankScore?: number | null;
  structuredBandSignal?: number | null;
  structuredPriceBand?: string | null;
  structuredSpreadQuartile?: string | null;
};

function parseNum(s: string | null | undefined): number | null {
  if (s == null || s === "") return null;
  const n = parseFloat(String(s).trim());
  return Number.isFinite(n) ? n : null;
}

function estimateSlippageBps(c: PaperTradingCandidate): number | null {
  const dec = parseNum(c.shadowInput.estimatedSlippage);
  if (dec == null) return null;
  return dec * 10_000;
}

function buildDedupeKeyV2(
  modelRunId: string,
  botType: string,
  assetId: string,
  side: string,
  cooldownHours: number
): string {
  const bucketMs = cooldownHours * 60 * 60 * 1000 || 60 * 60 * 1000;
  const nowMs = Date.now();
  const timeBucket = Math.floor(nowMs / bucketMs);
  return `${modelRunId}|v2|${botType}|${assetId}|${side}|${timeBucket}`;
}

function emptyRejectCounts(): Record<PaperTickV2RejectReason, number> {
  return {
    score_failed: 0,
    below_threshold: 0,
    liquidity_spread: 0,
    liquidity_slippage: 0,
    global_max_open_total: 0,
    bot_max_open: 0,
    dedupe: 0,
  };
}

function parseBoolEnv(key: string, fallback: boolean): boolean {
  const raw = typeof process !== "undefined" ? process.env[key]?.trim().toLowerCase() : "";
  if (!raw) return fallback;
  if (raw === "1" || raw === "true" || raw === "yes" || raw === "on") return true;
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") return false;
  return fallback;
}

function parseNonNegFloatEnv(key: string, fallback: number): number {
  const raw = typeof process !== "undefined" ? process.env[key]?.trim() : "";
  if (!raw) return fallback;
  const n = parseFloat(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

type ShadowBandLabel =
  | "<0.1"
  | "0.1-0.2"
  | "0.2-0.3"
  | "0.3-0.4"
  | "0.4-0.6"
  | "0.6-0.8"
  | "0.8-0.9"
  | ">=0.9";

function classifyShadowBand(entryPriceRaw: string | null | undefined): ShadowBandLabel {
  const p = parseNum(entryPriceRaw);
  if (p == null) return "0.4-0.6";
  if (p < 0.1) return "<0.1";
  if (p < 0.2) return "0.1-0.2";
  if (p < 0.3) return "0.2-0.3";
  if (p < 0.4) return "0.3-0.4";
  if (p < 0.6) return "0.4-0.6";
  if (p < 0.8) return "0.6-0.8";
  if (p < 0.9) return "0.8-0.9";
  return ">=0.9";
}

function loadShadowBandAwareOverlayConfig(): {
  wBand: number;
  wRank: number;
  bandSignal: Record<ShadowBandLabel, number>;
  bandPenaltyMultiplier: Record<ShadowBandLabel, number>;
} {
  const wBand = parseNonNegFloatEnv("PAPER_SHADOW_ML_GLOBAL_BAND_WEIGHT", 0.35);
  const wRank = parseNonNegFloatEnv("PAPER_SHADOW_ML_GLOBAL_RANK_WEIGHT", 0.65);
  const bandSignal: Record<ShadowBandLabel, number> = {
    "<0.1": clamp01(parseNonNegFloatEnv("PAPER_SHADOW_ML_BAND_SIGNAL_LT_01", 0.15)),
    "0.1-0.2": clamp01(parseNonNegFloatEnv("PAPER_SHADOW_ML_BAND_SIGNAL_01_02", 0.45)),
    "0.2-0.3": clamp01(parseNonNegFloatEnv("PAPER_SHADOW_ML_BAND_SIGNAL_02_03", 0.5)),
    "0.3-0.4": clamp01(parseNonNegFloatEnv("PAPER_SHADOW_ML_BAND_SIGNAL_03_04", 0.55)),
    "0.4-0.6": clamp01(parseNonNegFloatEnv("PAPER_SHADOW_ML_BAND_SIGNAL_04_06", 0.9)),
    "0.6-0.8": clamp01(parseNonNegFloatEnv("PAPER_SHADOW_ML_BAND_SIGNAL_06_08", 0.8)),
    "0.8-0.9": clamp01(parseNonNegFloatEnv("PAPER_SHADOW_ML_BAND_SIGNAL_08_09", 0.6)),
    ">=0.9": clamp01(parseNonNegFloatEnv("PAPER_SHADOW_ML_BAND_SIGNAL_GTE_09", 0.75)),
  };
  const bandPenaltyMultiplier: Record<ShadowBandLabel, number> = {
    "<0.1": parseNonNegFloatEnv("PAPER_SHADOW_ML_BAND_PENALTY_MULTIPLIER_LT_01", 0.5),
    "0.1-0.2": parseNonNegFloatEnv("PAPER_SHADOW_ML_BAND_PENALTY_MULTIPLIER_01_02", 0.25),
    "0.2-0.3": parseNonNegFloatEnv("PAPER_SHADOW_ML_BAND_PENALTY_MULTIPLIER_02_03", 1),
    "0.3-0.4": parseNonNegFloatEnv("PAPER_SHADOW_ML_BAND_PENALTY_MULTIPLIER_03_04", 1),
    "0.4-0.6": parseNonNegFloatEnv("PAPER_SHADOW_ML_BAND_PENALTY_MULTIPLIER_04_06", 1.5),
    "0.6-0.8": parseNonNegFloatEnv("PAPER_SHADOW_ML_BAND_PENALTY_MULTIPLIER_06_08", 1),
    "0.8-0.9": parseNonNegFloatEnv("PAPER_SHADOW_ML_BAND_PENALTY_MULTIPLIER_08_09", 0.5),
    ">=0.9": parseNonNegFloatEnv("PAPER_SHADOW_ML_BAND_PENALTY_MULTIPLIER_GTE_09", 1),
  };
  return { wBand, wRank, bandSignal, bandPenaltyMultiplier };
}

function summarizeScoreDistribution(values: number[]): {
  min: number;
  max: number;
  mean: number;
  std: number;
} {
  if (values.length === 0) return { min: 0, max: 0, mean: 0, std: 0 };
  const min = Math.min(...values);
  const max = Math.max(...values);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / values.length;
  return { min, max, mean, std: Math.sqrt(Math.max(0, variance)) };
}

function scoreBucketLabel(score: number): string {
  if (score < 0.2) return "[0.0,0.2)";
  if (score < 0.4) return "[0.2,0.4)";
  if (score < 0.6) return "[0.4,0.6)";
  if (score < 0.8) return "[0.6,0.8)";
  return "[0.8,1.0]";
}

export async function runPaperTradingTickV2(
  opts?: string | RunPaperTradingTickV2Options
): Promise<PaperTradingTickV2Result> {
  const options: RunPaperTradingTickV2Options =
    typeof opts === "string" ? { funderAddress: opts } : (opts ?? {});
  const useStructuredScorer = parseBoolEnv("PAPER_TRADING_USE_STRUCTURED_SCORER", false);
  const suppressAlreadyOpenDuplicateExposures = parseBoolEnv(
    "PAPER_V2_SUPPRESS_ALREADY_OPEN_DUPLICATE_EXPOSURES",
    true
  );
  const ignoreClosedRowsInOpenDedupe = parseBoolEnv(
    "PAPER_V2_IGNORE_CLOSED_ROWS_IN_OPEN_DEDUPE",
    true
  );
  const cfg = getPaperTradingConfig();
  const now = new Date();
  const errors: string[] = [];
  const rejectReasonDistribution = emptyRejectCounts();
  const trace: PaperTickV2TraceEntry[] = [];

  const baseResult: PaperTradingTickV2Result = {
    enabled: cfg.enabled,
    modelRunId: null,
    tickTime: now.toISOString(),
    funderUsedForCandidateLoad: null,
    candidatesLoaded: 0,
    candidatesPassedFilter: 0,
    tradesOpened: 0,
    errors,
    shadowDiagnostics: null,
    trace,
    rejectReasonDistribution,
  };

  if (!cfg.enabled) return baseResult;

  let activeModel;
  try {
    activeModel = await getActiveOrApprovedShadowModel();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    errors.push(`Failed to load active shadow model: ${msg}`);
    return baseResult;
  }
  if (!activeModel) {
    errors.push("No ACTIVE or APPROVED shadow model.");
    return baseResult;
  }
  baseResult.modelRunId = activeModel.run.id;

  const explicitHint =
    options.funderAddress != null && String(options.funderAddress).trim() !== ""
      ? String(options.funderAddress).trim()
      : null;
  const preferredFunder = normalizePreferredFunderForShadowLoad(
    explicitHint ?? (await getFunderForPaperTradingTick())
  );

  let candidates: PaperTradingCandidate[] = [];
  let shadowDiagnostics: ShadowTickLoadDiagnostics | null = options.preloadedShadowDiagnostics ?? null;
  if (options.preloadedCandidates) {
    candidates = options.preloadedCandidates;
  } else {
    try {
      const loaded = await loadShadowCandidatesForPaperTick({
        preferredFunder,
      });
      candidates = loaded.candidates;
      shadowDiagnostics = loaded.shadowDiagnostics;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`Failed to load candidates: ${msg}`);
      return baseResult;
    }
  }
  baseResult.shadowDiagnostics = shadowDiagnostics;
  baseResult.funderUsedForCandidateLoad = shadowDiagnostics?.funderUsedForLoad ?? preferredFunder ?? null;
  baseResult.candidatesLoaded = candidates.length;

  const scoredByCandidate = new Map<string, ScoredCandidate>();
  const scoreFailed = new Set<string>();
  if (useStructuredScorer) {
    try {
      const model = await buildStructuredScoringModel(30);
      const externalSignals = await buildExternalSignalFeatureVectors(candidates);
      const scored = scoreStructuredCandidates(candidates, model, externalSignals.byRecommendationId);
      for (const s of scored) {
        scoredByCandidate.set(s.candidate.recommendationId, {
          candidate: s.candidate,
          score: s.score,
          shadowMlScoreRaw: null,
          shadowMlScoreCalibrated: null,
          structuredBaseScore: s.baseScore,
          structuredBandRankScore: s.bandRankScore,
          structuredBandSignal: s.bandSignal,
          structuredPriceBand: s.priceBand,
          structuredSpreadQuartile: s.spreadQuartile,
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`Structured scorer failed: ${msg}`);
      for (const c of candidates) scoreFailed.add(c.recommendationId);
    }
  } else {
    for (const candidate of candidates) {
      const scoreRes = await scoreShadowCandidate(candidate.shadowInput);
      if (!scoreRes.success || !scoreRes.result) {
        errors.push(`Score failed for ${candidate.recommendationId}: ${scoreRes.error ?? "unknown"}`);
        scoreFailed.add(candidate.recommendationId);
        continue;
      }
      scoredByCandidate.set(candidate.recommendationId, {
        candidate,
        score: scoreRes.result.shadowMlScore,
        shadowMlScoreRaw: scoreRes.result.shadowMlScore,
        shadowMlScoreCalibrated: scoreRes.result.shadowMlScoreCalibrated,
        shadowBand: classifyShadowBand(candidate.entryPrice ?? candidate.shadowInput.intendedPrice),
        shadowBandRankScore: null,
        shadowBandSignal: null,
        shadowBandPenaltyMultiplier: null,
        shadowBandAwareScore: null,
        structuredBaseScore: null,
        structuredBandRankScore: null,
        structuredBandSignal: null,
        structuredPriceBand: null,
        structuredSpreadQuartile: null,
      });
    }
    const overlay = loadShadowBandAwareOverlayConfig();
    const byBand = new Map<ShadowBandLabel, ScoredCandidate[]>();
    for (const s of scoredByCandidate.values()) {
      const band = (s.shadowBand as ShadowBandLabel | null) ?? "0.4-0.6";
      const arr = byBand.get(band) ?? [];
      arr.push(s);
      byBand.set(band, arr);
    }
    for (const [band, arr] of byBand.entries()) {
      const sorted = [...arr].sort((a, b) => {
        const sa = a.shadowMlScoreRaw ?? -Infinity;
        const sb = b.shadowMlScoreRaw ?? -Infinity;
        if (sb !== sa) return sb - sa; // higher raw score should rank first inside band
        return a.candidate.recommendationId.localeCompare(b.candidate.recommendationId);
      });
      const denom = sorted.length > 1 ? sorted.length - 1 : 1;
      for (let i = 0; i < sorted.length; i++) {
        const rank = sorted.length === 1 ? 0.5 : 1 - i / denom;
        const signal = overlay.bandSignal[band];
        const blendBase = clamp01((overlay.wBand * signal + overlay.wRank * rank) / Math.max(1e-9, overlay.wBand + overlay.wRank));
        const penalty = Math.max(0, overlay.bandPenaltyMultiplier[band] ?? 1);
        const blend = clamp01(blendBase * penalty);
        sorted[i]!.shadowBandRankScore = rank;
        sorted[i]!.shadowBandSignal = signal;
        sorted[i]!.shadowBandPenaltyMultiplier = penalty;
        sorted[i]!.shadowBandAwareScore = blend;
        sorted[i]!.score = blend;
      }
    }
    console.info("[paper-trading-v2] shadow_ml band-aware overlay", {
      wBand: overlay.wBand,
      wRank: overlay.wRank,
      bandSignal: overlay.bandSignal,
      bandPenaltyMultiplier: overlay.bandPenaltyMultiplier,
    });
  }
  const allScores = [...scoredByCandidate.values()].map((x) => x.score);
  const scoreSummary = summarizeScoreDistribution(allScores);
  const topScoreSample = [...scoredByCandidate.values()]
    .sort((a, b) =>
      b.score === a.score
        ? a.candidate.recommendationId.localeCompare(b.candidate.recommendationId)
        : b.score - a.score
    )
    .slice(0, 10)
    .map((x) => ({
      recommendationId: x.candidate.recommendationId,
      assetId: x.candidate.assetId,
      shadowMlScoreRaw: x.shadowMlScoreRaw ?? null,
      shadowMlScoreCalibrated: x.shadowMlScoreCalibrated ?? null,
      shadowBand: x.shadowBand ?? null,
      shadowBandRankScore: x.shadowBandRankScore ?? null,
      shadowBandSignal: x.shadowBandSignal ?? null,
      shadowBandPenaltyMultiplier: x.shadowBandPenaltyMultiplier ?? null,
      shadowBandAwareScore: x.shadowBandAwareScore ?? null,
      baseScore: x.structuredBaseScore ?? null,
      bandRankScore: x.structuredBandRankScore ?? null,
      bandSignal: x.structuredBandSignal ?? null,
      score: x.score,
      priceBand: x.structuredPriceBand ?? null,
      spreadQuartile: x.structuredSpreadQuartile ?? null,
    }));
  console.info("[paper-trading-v2] score distribution", {
    scorer: useStructuredScorer ? "structured" : "shadow_ml",
    count: allScores.length,
    min: scoreSummary.min,
    max: scoreSummary.max,
    mean: scoreSummary.mean,
    std: scoreSummary.std,
  });
  console.info("[paper-trading-v2] top scored candidates", {
    scorer: useStructuredScorer ? "structured" : "shadow_ml",
    top: topScoreSample,
  });

  const scoreBucketCountsAllCandidates: Record<string, number> = {
    "[0.0,0.2)": 0,
    "[0.2,0.4)": 0,
    "[0.4,0.6)": 0,
    "[0.6,0.8)": 0,
    "[0.8,1.0]": 0,
  };
  for (const v of scoredByCandidate.values()) {
    const b = scoreBucketLabel(v.score);
    scoreBucketCountsAllCandidates[b] = (scoreBucketCountsAllCandidates[b] ?? 0) + 1;
  }

  const activeProfiles = options.preloadedProfiles ?? (await getActiveBotProfiles());
  const profiles: EffectiveBotProfile[] =
    activeProfiles.length > 0
      ? activeProfiles
      : [
          {
            botType: "default",
            displayName: "Default",
            enabled: true,
            targetLabel: null,
            botVersion: null,
            threshold: cfg.threshold,
            minScoreBuffer: cfg.minScoreBuffer,
            allowReviewRequired: true,
            allowPaperRelaxation: false,
            allowRelaxationReasons: null,
            allowedPolicyStates: null,
            allowedPriceBands: null,
            excludedThemes: [],
            excludedCategories: [],
            cooldownHours: cfg.cooldownHours,
            cooldownMarketHours: cfg.cooldownMarketHours,
            maxOpenTotal: cfg.maxOpenTotal,
            maxOpenPerMarket: cfg.maxOpenPerMarket,
            maxOpenPerTheme: cfg.maxOpenPerTheme,
            maxOpenPerCategory: cfg.maxOpenPerCategory,
            maxDailyNewTrades: cfg.maxDailyNewTrades,
            notes: "v2_minimal_fallback_profile",
            effectiveEnabled: true,
            overrideSource: null,
            explorationEnabled: false,
            explorationBandBelowMinScore: 0,
            explorationMaxPerTick: 0,
            explorationMaxPerDay: 0,
          },
        ];

  let openTotal =
    options.initialOpenTotal ??
    (await prisma.paperTrade.count({ where: { status: "open" } }));
  let dedupeRejectedPreInsertCount = 0;
  let dedupeRejectedSameTickCount = 0;
  let dedupeRejectedExistingDbCount = 0;
  let dedupeRejectedUniqueConstraintCount = 0;
  let dedupeOpenRowCollisionCount = 0;
  let dedupeClosedRowCollisionCount = 0;
  let dedupeClosedRowBypassedCount = 0;
  let suppressedAlreadyOpenExposureCount = 0;
  const suppressedByBotType = new Map<string, number>();
  const suppressedByBand = new Map<string, number>();
  const dedupeKeysSelectedThisTick = new Set<string>();
  const openByBot = new Map<string, number>();
  for (const profile of profiles) {
    const n =
      options.initialOpenByBot?.[profile.botType] ??
      (await prisma.paperTrade.count({ where: { status: "open", botType: profile.botType } }));
    openByBot.set(profile.botType, n);
  }

  for (const profile of profiles) {
    const threshold = profile.threshold + profile.minScoreBuffer;
    const passedFilter: ScoredCandidate[] = [];
    const openExposurePairs = new Set<string>();
    if (suppressAlreadyOpenDuplicateExposures) {
      const assetIds = Array.from(new Set(candidates.map((c) => c.assetId)));
      const sides = Array.from(new Set(candidates.map((c) => c.side)));
      if (assetIds.length > 0 && sides.length > 0) {
        const openRows = await prisma.paperTrade.findMany({
          where: {
            status: "open",
            botType: profile.botType,
            assetId: { in: assetIds },
            side: { in: sides },
          },
          select: { assetId: true, side: true },
        });
        for (const r of openRows) openExposurePairs.add(`${r.assetId}|${r.side}`);
      }
    }

    for (const c of candidates) {
      if (!scoreFailed.has(c.recommendationId)) continue;
      rejectReasonDistribution.score_failed++;
      trace.push({
        botType: profile.botType,
        candidateId: c.shadowCandidateId ?? null,
        recommendationId: c.recommendationId,
        assetId: c.assetId,
        marketId: c.marketId,
        side: c.side,
        score: null,
        admitted: false,
        rejectReason: "score_failed",
      });
    }

    for (const scored of scoredByCandidate.values()) {
      const c = scored.candidate;
      const score = scored.score;
      let rejectReason: PaperTickV2RejectReason | null = null;
      if (suppressAlreadyOpenDuplicateExposures && openExposurePairs.has(`${c.assetId}|${c.side}`)) {
        suppressedAlreadyOpenExposureCount++;
        suppressedByBotType.set(profile.botType, (suppressedByBotType.get(profile.botType) ?? 0) + 1);
        const bandKey =
          scored.shadowBand ??
          scored.structuredPriceBand ??
          classifyShadowBand(c.entryPrice ?? c.shadowInput.intendedPrice);
        suppressedByBand.set(bandKey, (suppressedByBand.get(bandKey) ?? 0) + 1);
        rejectReasonDistribution.dedupe++;
        trace.push({
          botType: profile.botType,
          candidateId: c.shadowCandidateId ?? null,
          recommendationId: c.recommendationId,
          assetId: c.assetId,
          marketId: c.marketId,
          side: c.side,
          score,
          admitted: false,
          rejectReason: "dedupe",
        });
        continue;
      }

      if (score < threshold) {
        rejectReason = "below_threshold";
      } else {
        const spreadBps = parseNum(c.shadowInput.spreadBps);
        const slippageBps = estimateSlippageBps(c);
        const liq = evaluatePaperLiquidityGuards(
          spreadBps,
          slippageBps,
          cfg.paperMaxSpreadBps,
          cfg.paperMaxEstimatedSlippageBps
        );
        if (!liq.ok) {
          rejectReason = liq.reason === "spread" ? "liquidity_spread" : "liquidity_slippage";
        }
      }

      if (rejectReason != null) {
        rejectReasonDistribution[rejectReason]++;
        trace.push({
          botType: profile.botType,
          candidateId: c.shadowCandidateId ?? null,
          recommendationId: c.recommendationId,
          assetId: c.assetId,
          marketId: c.marketId,
          side: c.side,
          score,
          admitted: false,
          rejectReason,
        });
        continue;
      }

      passedFilter.push(scored);
    }
    baseResult.candidatesPassedFilter += passedFilter.length;

    passedFilter.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.candidate.recommendationId.localeCompare(b.candidate.recommendationId);
    });

    for (const scored of passedFilter) {
      const c = scored.candidate;
      const score = scored.score;
      const perBotOpen = openByBot.get(profile.botType) ?? 0;

      if (cfg.maxOpenTotal > 0 && openTotal >= cfg.maxOpenTotal) {
        rejectReasonDistribution.global_max_open_total++;
        trace.push({
          botType: profile.botType,
          candidateId: c.shadowCandidateId ?? null,
          recommendationId: c.recommendationId,
          assetId: c.assetId,
          marketId: c.marketId,
          side: c.side,
          score,
          admitted: false,
          rejectReason: "global_max_open_total",
        });
        continue;
      }

      if (profile.maxOpenTotal > 0 && perBotOpen >= profile.maxOpenTotal) {
        rejectReasonDistribution.bot_max_open++;
        trace.push({
          botType: profile.botType,
          candidateId: c.shadowCandidateId ?? null,
          recommendationId: c.recommendationId,
          assetId: c.assetId,
          marketId: c.marketId,
          side: c.side,
          score,
          admitted: false,
          rejectReason: "bot_max_open",
        });
        continue;
      }

      const baseDedupeKey = buildDedupeKeyV2(
        activeModel.run.id,
        profile.botType,
        c.assetId,
        c.side,
        profile.cooldownHours
      );
      let dedupeKeyForCreate = baseDedupeKey;
      const duplicateInTick = dedupeKeysSelectedThisTick.has(baseDedupeKey);
      const duplicateInDb = duplicateInTick
        ? null
        : await prisma.paperTrade.findUnique({
            where: { dedupeKey: baseDedupeKey },
            select: { id: true, status: true },
          });
      let duplicateInDbBlocking = false;
      if (duplicateInDb) {
        if (duplicateInDb.status === "open") {
          duplicateInDbBlocking = true;
          dedupeOpenRowCollisionCount++;
        } else {
          dedupeClosedRowCollisionCount++;
          if (ignoreClosedRowsInOpenDedupe) {
            dedupeClosedRowBypassedCount++;
            dedupeKeyForCreate = `${baseDedupeKey}|reopen|${Date.now()}`;
          } else {
            duplicateInDbBlocking = true;
          }
        }
      }
      if (duplicateInTick || duplicateInDbBlocking) {
        dedupeRejectedPreInsertCount++;
        if (duplicateInTick) dedupeRejectedSameTickCount++;
        else dedupeRejectedExistingDbCount++;
        rejectReasonDistribution.dedupe++;
        trace.push({
          botType: profile.botType,
          candidateId: c.shadowCandidateId ?? null,
          recommendationId: c.recommendationId,
          assetId: c.assetId,
          marketId: c.marketId,
          side: c.side,
          score,
          admitted: false,
          rejectReason: "dedupe",
        });
        continue;
      }
      if (options.dryRun) {
        dedupeKeysSelectedThisTick.add(baseDedupeKey);
        openTotal += 1;
        openByBot.set(profile.botType, perBotOpen + 1);
        baseResult.tradesOpened += 1;
        trace.push({
          botType: profile.botType,
          candidateId: c.shadowCandidateId ?? null,
          recommendationId: c.recommendationId,
          assetId: c.assetId,
          marketId: c.marketId,
          side: c.side,
          score,
          admitted: true,
          rejectReason: null,
        });
        continue;
      }
      try {
        await prisma.paperTrade.create({
          data: {
            dedupeKey: dedupeKeyForCreate,
            modelRunId: activeModel.run.id,
            marketId: c.marketId,
            assetId: c.assetId,
            theme: c.theme,
            category: c.category,
            funderAddress: baseResult.funderUsedForCandidateLoad ?? "paper",
            side: c.side,
            score,
            threshold: threshold,
            entryPrice: c.entryPrice,
            entryTime: now,
            intendedSize: c.intendedSize,
            status: "open",
            metadataJson: JSON.stringify({
              recommendationId: c.recommendationId,
              shadowCandidateId: c.shadowCandidateId ?? null,
              engineVersion: "v2_minimal",
              scoreProvenance: {
                scorerSource: useStructuredScorer ? "structured" : "shadow_ml_band_aware_overlay",
                rawShadowMlScore: scored.shadowMlScoreRaw ?? null,
                shadowMlScoreCalibrated: scored.shadowMlScoreCalibrated ?? null,
                shadowBand: scored.shadowBand ?? null,
                shadowBandRankScore: scored.shadowBandRankScore ?? null,
                shadowBandSignal: scored.shadowBandSignal ?? null,
                finalBandAwareScore: scored.shadowBandAwareScore ?? null,
                scoreUsedForAdmission: score,
              },
            }),
            sourceDecisionState: c.sourceDecisionState ?? null,
            paperPolicyMode: null,
            paperRelaxationReason: null,
            paperEligibilityVersion: "v2_minimal",
            botType: profile.botType,
            botVersion: profile.botVersion ?? "v2",
            targetLabel: activeModel.run.targetLabel,
            explorationAdmissionMode: "threshold",
          },
        });

        dedupeKeysSelectedThisTick.add(baseDedupeKey);
        openTotal += 1;
        openByBot.set(profile.botType, perBotOpen + 1);
        baseResult.tradesOpened += 1;
        trace.push({
          botType: profile.botType,
          candidateId: c.shadowCandidateId ?? null,
          recommendationId: c.recommendationId,
          assetId: c.assetId,
          marketId: c.marketId,
          side: c.side,
          score,
          admitted: true,
          rejectReason: null,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("Unique constraint") || msg.includes("dedupeKey")) {
          dedupeRejectedUniqueConstraintCount++;
          rejectReasonDistribution.dedupe++;
          trace.push({
            botType: profile.botType,
            candidateId: c.shadowCandidateId ?? null,
            recommendationId: c.recommendationId,
            assetId: c.assetId,
            marketId: c.marketId,
            side: c.side,
            score,
            admitted: false,
            rejectReason: "dedupe",
          });
          continue;
        }
        errors.push(`Create paper trade failed for ${c.recommendationId}: ${msg}`);
      }
    }
  }

  const thresholdByBot = new Map<string, number>(
    profiles.map((p) => [p.botType, p.threshold + p.minScoreBuffer] as const)
  );
  const outcomesByRecommendationId = new Map<
    string,
    Array<{ botType: string; admitted: boolean; rejectReason: PaperTickV2RejectReason | null }>
  >();
  for (const t of trace) {
    const arr = outcomesByRecommendationId.get(t.recommendationId) ?? [];
    arr.push({ botType: t.botType, admitted: t.admitted, rejectReason: t.rejectReason });
    outcomesByRecommendationId.set(t.recommendationId, arr);
  }
  const scoreBucketCountsFromTraceAdmitted: Record<string, number> = {
    "[0.0,0.2)": 0,
    "[0.2,0.4)": 0,
    "[0.4,0.6)": 0,
    "[0.6,0.8)": 0,
    "[0.8,1.0]": 0,
  };
  const scoreBucketCountsFromTraceRejected: Record<string, number> = {
    "[0.0,0.2)": 0,
    "[0.2,0.4)": 0,
    "[0.4,0.6)": 0,
    "[0.6,0.8)": 0,
    "[0.8,1.0]": 0,
  };
  for (const t of trace) {
    if (t.score == null) continue;
    const b = scoreBucketLabel(t.score);
    if (t.admitted) scoreBucketCountsFromTraceAdmitted[b] = (scoreBucketCountsFromTraceAdmitted[b] ?? 0) + 1;
    else scoreBucketCountsFromTraceRejected[b] = (scoreBucketCountsFromTraceRejected[b] ?? 0) + 1;
  }
  const scoreProvenanceSample = [...scoredByCandidate.values()]
    .sort((a, b) =>
      b.score === a.score
        ? a.candidate.recommendationId.localeCompare(b.candidate.recommendationId)
        : b.score - a.score
    )
    .slice(0, 10)
    .map((x) => {
      const outcomes = outcomesByRecommendationId.get(x.candidate.recommendationId) ?? [];
      const thresholdApplied =
        outcomes.length > 0 ? thresholdByBot.get(outcomes[0]!.botType) ?? null : null;
      return {
        recommendationId: x.candidate.recommendationId,
        assetId: x.candidate.assetId,
        scorerSource: useStructuredScorer ? ("structured" as const) : ("shadow_ml" as const),
        structuredBaseScore: x.structuredBaseScore ?? null,
        structuredBlendedScore: useStructuredScorer ? x.score : null,
        shadowMlScoreRaw: x.shadowMlScoreRaw ?? null,
        shadowMlScoreCalibrated: x.shadowMlScoreCalibrated ?? null,
        shadowBand: x.shadowBand ?? null,
        shadowBandRankScore: x.shadowBandRankScore ?? null,
        shadowBandSignal: x.shadowBandSignal ?? null,
        shadowBandPenaltyMultiplier: x.shadowBandPenaltyMultiplier ?? null,
        finalBandAwareScore: x.shadowBandAwareScore ?? null,
        actualScoreUsedForOrdering: x.score,
        actualScoreUsedForThreshold: x.score,
        thresholdApplied,
        outcomes,
      };
    });

  console.info("[paper-trading-v2] dedupe pre-insert summary", {
    dedupeRejectedPreInsertCount,
    preSuppressedAlreadyOpen: suppressedAlreadyOpenExposureCount,
    sameTickCollision: dedupeRejectedSameTickCount,
    existingDbCollision: dedupeRejectedExistingDbCount,
    uniqueConstraintCollision: dedupeRejectedUniqueConstraintCount,
    openRowCollision: dedupeOpenRowCollisionCount,
    closedRowCollision: dedupeClosedRowCollisionCount,
    closedRowBypassed: dedupeClosedRowBypassedCount,
    ignoreClosedRowsInOpenDedupe,
  });
  baseResult.duplicateExposureSuppression = {
    enabled: suppressAlreadyOpenDuplicateExposures,
    totalSuppressed: suppressedAlreadyOpenExposureCount,
    byBotType: Object.fromEntries(suppressedByBotType.entries()),
    byBand: Object.fromEntries(suppressedByBand.entries()),
  };
  baseResult.dedupeCollisionBreakdown = {
    preSuppressedAlreadyOpen: suppressedAlreadyOpenExposureCount,
    sameTickCollision: dedupeRejectedSameTickCount,
    existingDbCollision: dedupeRejectedExistingDbCount,
    uniqueConstraintCollision: dedupeRejectedUniqueConstraintCount,
    openRowCollision: dedupeOpenRowCollisionCount,
    closedRowCollision: dedupeClosedRowCollisionCount,
    closedRowBypassed: dedupeClosedRowBypassedCount,
  };

  return {
    ...baseResult,
    scorePopulationSnapshot: {
      scorerSource: useStructuredScorer ? "structured" : "shadow_ml",
      uniqueCandidatesScored: scoredByCandidate.size,
      scoreBucketCountsAllCandidates,
      scoreBucketCountsFromTraceAdmitted,
      scoreBucketCountsFromTraceRejected,
    },
    scoreProvenanceSample,
  };
}
