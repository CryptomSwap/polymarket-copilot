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

export async function runPaperTradingTickV2(
  opts?: string | RunPaperTradingTickV2Options
): Promise<PaperTradingTickV2Result> {
  const options: RunPaperTradingTickV2Options =
    typeof opts === "string" ? { funderAddress: opts } : (opts ?? {});
  const useStructuredScorer = parseBoolEnv("PAPER_TRADING_USE_STRUCTURED_SCORER", false);
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
        structuredPriceBand: null,
        structuredSpreadQuartile: null,
      });
    }
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

      const dedupeKey = buildDedupeKeyV2(activeModel.run.id, profile.botType, c.assetId, c.side, profile.cooldownHours);
      const duplicateInTick = dedupeKeysSelectedThisTick.has(dedupeKey);
      const duplicateInDb = duplicateInTick
        ? null
        : await prisma.paperTrade.findUnique({
            where: { dedupeKey },
            select: { id: true },
          });
      if (duplicateInTick || duplicateInDb) {
        dedupeRejectedPreInsertCount++;
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
        dedupeKeysSelectedThisTick.add(dedupeKey);
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
            dedupeKey,
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

        dedupeKeysSelectedThisTick.add(dedupeKey);
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

  console.info("[paper-trading-v2] dedupe pre-insert summary", {
    dedupeRejectedPreInsertCount,
  });

  return baseResult;
}
