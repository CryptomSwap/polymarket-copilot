/**
 * Paper trading engine: open trades when shadow score >= threshold (no real orders); close after 12h with markout.
 * Hardened: dedupe key, risk limits, tick state persistence.
 */

import { prisma } from "@/lib/db";
import { getActiveOrApprovedShadowModel, scoreShadowCandidate } from "@/lib/ml/shadow-score";
import { markout } from "@/lib/shadow-evaluation/markout";
import { recordShadowCandidate } from "@/lib/shadow-telemetry";
import { getPaperTradingConfig } from "./config";
import {
  filterShadowCandidatesForProfile,
  filterShadowCandidatesForProfileWithDiagnostics,
  loadShadowCandidatesForPaperTick,
  mergeShadowDiagnosticsIntoLoadDiagnostics,
  normalizePreferredFunderForShadowLoad,
  paperLoadDiagnosticsFromShadowOnly,
  type PaperTradingCandidate,
  type ShadowTickLoadDiagnostics,
} from "./candidates";
import { getFunderForPaperTradingTick } from "@/lib/decision/recompute";
import type { ShadowScoreResult } from "@/lib/ml/shadow-score/types";
import { getActiveBotProfiles, type EffectiveBotProfile } from "./bot-profiles";
import { classifyEntryPriceBand, parseEntryPrice } from "./price-bands";
import { scorePaperChampionAndChallenger } from "./champion-challenger";
import { getExplorationPolicyMode } from "./exploration-policy";
import { computeBotBudgets, type BotBudgetDecision } from "./bot-budget-allocator";
import { enablePaperBotBudgetAllocatorV1 } from "@/lib/ml/config";
import type {
  PaperDecisionTraceBundle,
  PaperDecisionTraceEntry,
  PaperDecisionTracePerBotAggregate,
  PaperDecisionRejectReasonCode,
} from "./decision-trace-types";
import {
  MAX_DECISION_TRACES_STORED,
} from "./decision-trace-types";
import { paperAdmissionExplorationResolveForDailyCapOverflow } from "./paper-daily-cap-overflow";
import {
  buildExecutionContextFromShadowInput,
  buildPaperTradeOpenAttribution,
  mergeOpenAttributionIntoMetadata,
  type PaperRoiAdmissionMeta,
  type PaperShadowScoreCalibrationMeta,
} from "./paper-trade-open-attribution";
import {
  applyPaperIntendedSizeMultiplier,
  computeEffectivePaperMinScore,
  evaluatePaperLiquidityGuards,
  readPaperBotMinScoreOverrideEnv,
  resolvePaperSizeBucket,
} from "./paper-roi-admission";
import {
  mergePaperCloseMetadata,
  paperCloseDueBefore,
  PAPER_CLOSE_HORIZON_MS,
} from "./paper-close-helpers";
import {
  hasOpenOrRecentPaperTrade,
  hasOpenOrRecentPaperTradeForMarket,
} from "./paper-cooldown";
import { resolvePaperTradeCloseExitPrice } from "@/lib/polymarket/market-price-snapshot-lookup";
const FUNDER_PAPER = "paper";
const STATE_ID = "default";

function paperShadowAdmissionScore(sr: ShadowScoreResult, cfg: ReturnType<typeof getPaperTradingConfig>): number {
  return cfg.paperShadowUseCalibratedScoreForPaper ? sr.shadowMlScoreCalibrated : sr.shadowMlScore;
}

/** Same bar as `paperAdmissionExplorationResolveForDailyCapOverflow` (compares `admissionScore` to this min). */
function paperTraceThresholdEligible(admissionScore: number, minBar: number): boolean {
  return admissionScore >= minBar;
}

function paperAdmissionTraceScalars(
  result: ShadowScoreResult,
  admissionScore: number,
  cfg: ReturnType<typeof getPaperTradingConfig>
): {
  admissionScore: number;
  shadowMlScoreRaw: number;
  shadowMlScoreCalibrated: number;
  admissionUsesCalibrated: boolean;
} {
  return {
    admissionScore,
    shadowMlScoreRaw: result.shadowMlScore,
    shadowMlScoreCalibrated: result.shadowMlScoreCalibrated,
    admissionUsesCalibrated: cfg.paperShadowUseCalibratedScoreForPaper,
  };
}

function prismaJsonStringArray(value: string[] | null | undefined): object | undefined {
  if (value == null) return undefined;
  return value as unknown as object;
}

function parseNum(s: string | null | undefined): number | null {
  if (s == null || s === "") return null;
  const n = parseFloat(String(s).trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * Deterministic dedupe key: same (modelRunId, botType, assetId, side, timeBucket) => same key => at most one paper trade per bucket per bot.
 * timeBucket = floor(nowMs / bucketMs) with bucket = cooldown window so one open per cooldown window per asset/side/model/bot.
 */
function buildDedupeKey(
  modelRunId: string,
  botType: string,
  assetId: string,
  side: string,
  cooldownHours: number
): string {
  const bucketMs = cooldownHours * 60 * 60 * 1000 || 60 * 60 * 1000;
  const nowMs = Date.now();
  const timeBucket = Math.floor(nowMs / bucketMs);
  return `${modelRunId}|${botType}|${assetId}|${side}|${timeBucket}`;
}

/** At most one open paper trade per (bot, market, side) — aligns with shadow tick dedupe on marketId+side. */
async function hasOpenPaperTradeForMarketAndSide(
  botType: string,
  marketId: string,
  side: string
): Promise<boolean> {
  const open = await prisma.paperTrade.findFirst({
    where: {
      marketId,
      botType,
      side: side.toUpperCase() === "SELL" ? "SELL" : "BUY",
      status: "open",
    },
  });
  return open != null;
}

const TOP_CANDIDATES_SAMPLE_SIZE = 10;

function paperDecisionTraceMarketScalars(c: PaperTradingCandidate): {
  spreadBps: number | null;
  estimatedSlippageBps: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  midPrice: number | null;
  priceUsedForDecision: number | null;
} {
  const ctx = buildExecutionContextFromShadowInput(c.shadowInput);
  const bid =
    c.shadowInput.quoteBestBid != null && Number.isFinite(c.shadowInput.quoteBestBid)
      ? c.shadowInput.quoteBestBid
      : null;
  const ask =
    c.shadowInput.quoteBestAsk != null && Number.isFinite(c.shadowInput.quoteBestAsk)
      ? c.shadowInput.quoteBestAsk
      : null;
  let mid =
    c.shadowInput.quoteMidPrice != null && Number.isFinite(c.shadowInput.quoteMidPrice)
      ? c.shadowInput.quoteMidPrice
      : null;
  if (mid == null && bid != null && ask != null && ask > bid) {
    mid = (bid + ask) / 2;
  }
  let priceUsed: number | null = null;
  const ip = c.shadowInput.intendedPrice;
  if (ip != null && String(ip).trim() !== "") {
    const n = parseFloat(String(ip));
    priceUsed = Number.isFinite(n) ? n : null;
  }
  return {
    spreadBps: ctx.spreadBps,
    estimatedSlippageBps: ctx.estimatedSlippageBps,
    bestBid: bid,
    bestAsk: ask,
    midPrice: mid,
    priceUsedForDecision: priceUsed,
  };
}

/** Build one compact trace entry (observability only; does not affect admission). */
function buildTraceEntry(params: {
  botType: string;
  c: PaperTradingCandidate;
  championModelRunId: string | null;
  challengerModelRunId: string | null;
  championScore: number | null;
  challengerScore: number | null;
  scoreDelta: number | null;
  minScore: number | null;
  explorationMinScore?: number | null;
  admissionScore?: number | null;
  shadowMlScoreRaw?: number | null;
  shadowMlScoreCalibrated?: number | null;
  admissionUsesCalibrated?: boolean;
  thresholdEligible: boolean;
  explorationEligible: boolean;
  explorationUsed: boolean;
  budgetLimited: boolean;
  cooldownLimited: boolean;
  dedupeLimited: boolean;
  capsLimited: boolean;
  finalDisposition: "admitted" | "rejected";
  rejectReasonCode?: PaperDecisionRejectReasonCode | null;
  dedupeKey?: string | null;
  originalBotKey?: string | null;
  finalBotKey?: string | null;
  overflowAttempted?: boolean;
  overflowTriedBotKeys?: string[];
  overflowSucceeded?: boolean;
  overflowTerminalReason?: string | null;
}): PaperDecisionTraceEntry {
  const {
    botType,
    c,
    championModelRunId,
    challengerModelRunId,
    championScore,
    challengerScore,
    scoreDelta,
    minScore,
    explorationMinScore,
    admissionScore: admissionScoreParam,
    shadowMlScoreRaw,
    shadowMlScoreCalibrated,
    admissionUsesCalibrated,
    thresholdEligible,
    explorationEligible,
    explorationUsed,
    budgetLimited,
    cooldownLimited,
    dedupeLimited,
    capsLimited,
    finalDisposition,
    rejectReasonCode,
    dedupeKey,
    originalBotKey,
    finalBotKey,
    overflowAttempted,
    overflowTriedBotKeys,
    overflowSucceeded,
    overflowTerminalReason,
  } = params;
  const mkt = paperDecisionTraceMarketScalars(c);
  return {
    botType,
    recommendationId: c.recommendationId,
    assetId: c.assetId,
    marketId: c.marketId,
    marketSlug: null,
    marketTitle: null,
    targetLabel: null,
    policyState: c.sourceDecisionState ?? null,
    paperPolicyMode: c.paperPolicyMode ?? null,
    paperRelaxationReason: c.paperRelaxationReason ?? null,
    championModelRunId,
    challengerModelRunId,
    championScore,
    challengerScore,
    scoreDelta,
    minScore,
    explorationMinScore: explorationMinScore ?? null,
    ...(admissionScoreParam != null &&
      Number.isFinite(admissionScoreParam) && {
        admissionScore: admissionScoreParam,
        shadowMlScoreRaw: shadowMlScoreRaw ?? null,
        shadowMlScoreCalibrated: shadowMlScoreCalibrated ?? null,
        admissionUsesCalibrated: admissionUsesCalibrated === true,
      }),
    thresholdEligible,
    explorationEligible,
    explorationUsed,
    budgetLimited,
    cooldownLimited,
    dedupeLimited,
    capsLimited,
    finalDisposition,
    spreadBps: mkt.spreadBps,
    estimatedSlippageBps: mkt.estimatedSlippageBps,
    bestBid: mkt.bestBid,
    bestAsk: mkt.bestAsk,
    midPrice: mkt.midPrice,
    priceUsedForDecision: mkt.priceUsedForDecision,
    ...(finalDisposition === "rejected" && rejectReasonCode != null && {
      rejectReasonCode,
      rejectedBy: [rejectReasonCode],
    }),
    ...(dedupeKey != null && { dedupeKey }),
    ...(overflowAttempted === true && {
      originalBotKey: originalBotKey ?? null,
      finalBotKey: finalBotKey ?? null,
      overflowAttempted: true,
      overflowTriedBotKeys: overflowTriedBotKeys ?? [],
      overflowSucceeded: overflowSucceeded === true,
      overflowTerminalReason: overflowTerminalReason ?? null,
    }),
  };
}

function initPerBotAggregate(botType: string): PaperDecisionTracePerBotAggregate {
  return {
    botType,
    totalCandidates: 0,
    admitted: 0,
    rejected: 0,
    rejectedByThreshold: 0,
    rejectedByExplorationCap: 0,
    rejectedByBudget: 0,
    rejectedByCooldown: 0,
    rejectedByDedupe: 0,
    rejectedByCaps: 0,
    rejectedBySpreadGuard: 0,
    rejectedBySlippageGuard: 0,
    rejectedOther: 0,
    explorationEligible: 0,
    explorationUsed: 0,
  };
}

function incReject(agg: PaperDecisionTracePerBotAggregate, code: PaperDecisionRejectReasonCode): void {
  agg.rejected++;
  if (code === "below_threshold" || code === "outside_exploration_band" || code === "exploration_cap_tick" || code === "exploration_cap_day") {
    agg.rejectedByThreshold++;
    if (code !== "below_threshold") agg.rejectedByExplorationCap++;
  } else if (code === "budget_cap") agg.rejectedByBudget++;
  else if (code === "cooldown_asset" || code === "cooldown_market") agg.rejectedByCooldown++;
  else if (code === "dedupe") agg.rejectedByDedupe++;
  else if (code === "max_open_total" || code === "max_open_per_market" || code === "max_open_per_theme" || code === "max_open_per_category") agg.rejectedByCaps++;
  else if (code === "spread_guard") agg.rejectedBySpreadGuard++;
  else if (code === "slippage_guard") agg.rejectedBySlippageGuard++;
  else agg.rejectedOther++;
}

export interface PaperTradingTickResult {
  opened: number;
  skipped: number;
  errors: string[];
  lastScoringTime: string | null;
  modelRunId: string | null;
  threshold: number;
  enabled: boolean;
  candidatesLoaded: number;
  candidatesScored: number;
  maxScore: number | null;
  avgScore: number | null;
  aboveThresholdCount: number;
  rejectedByCooldownCount: number;
  rejectedByRiskLimitCount: number;
  /** Paper-only: spread guard rejections this tick (sum across bots). */
  rejectedBySpreadGuardCount?: number;
  /** Paper-only: slippage guard rejections this tick (sum across bots). */
  rejectedBySlippageGuardCount?: number;
  topCandidateScores: { assetId: string; side: string; score: number }[];
  /** Count of candidates scored that came from paper relaxation (relaxed_block_candidate). */
  scoredAfterRelaxation?: number;
  /** Count of paper trades created from relaxed BLOCK candidates this tick. */
  paperTradesCreatedFromRelaxation?: number;
  /** Alias for scoredAfterRelaxation (diagnostics). */
  relaxedScoredSuccessfully?: number;
  /** Alias for paperTradesCreatedFromRelaxation (diagnostics). */
  relaxedOpenedTrades?: number;
  /** Count of concentration-relaxed candidates scored this tick. */
  relaxedDueToConcentrationScored?: number;
  /** Count of concentration-relaxed trades opened this tick. */
  relaxedDueToConcentrationOpened?: number;
  loadDiagnostics?: {
    recommendationsFound: number;
    noDecisionSnapshot: number;
    afterPolicyFilter: number;
    noAssetResolve: number;
    zeroSizeBuy: number;
    zeroCandidatesReason: string;
    sampleSnapshotCheck?: { recommendationId: string; funderUsed: string; snapshotExists: boolean; snapshotFunderAddresses?: string[] }[];
    policyStateCounts?: Record<string, number>;
    filteredByPolicyStateCount?: number;
    profileFilterRejectByReason?: Record<string, number>;
    profileFilterBeforeCount?: number;
    profileFilterAfterCount?: number;
    avoidedCount?: number;
    allowedCount?: number;
    zeroSizeAfterPolicyCount?: number;
    sampleFilteredByPolicy?: { recommendationId: string; policyState: string; finalSuggestedSize: string; reason: string }[];
    relaxedBlockedCount?: number;
    relaxedByReasonCounts?: Record<string, number>;
    candidatesPassedViaRelaxation?: number;
    blockedCandidatesSeen?: number;
    paperRelaxationEligible?: number;
    paperRelaxationRejected?: number;
    paperRelaxationAccepted_edgeTooSmall?: number;
    paperRelaxationAccepted_liquidityTooLow?: number;
    paperRelaxationAccepted_multiAllowed?: number;
    paperRelaxationAccepted_concentrationHigh?: number;
    relaxedCandidatesConsidered?: number;
    relaxedDropped_actionTypeAvoid?: number;
    relaxedDropped_actionTypeSyncFirst?: number;
    relaxedDropped_missingAssetResolution?: number;
    relaxedDropped_missingSide?: number;
    relaxedDropped_missingPriceContext?: number;
    relaxedDropped_other?: number;
    relaxedBuiltSuccessfully?: number;
    relaxedConcentrationRejectedByCap?: number;
    relaxedConcentrationStakeUsed?: string;
    shadowRowsQueried?: number;
    shadowCandidateIds?: string[];
    shadowDedupeDropped?: number;
    shadowRowsSkippedNoMarket?: number;
    shadowRowsSkippedZeroBuySize?: number;
    shadowLookbackMinutes?: number;
    shadowPreferredFunderTried?: string | null;
    shadowFunderUsedForLoad?: string;
    shadowUsedFunderFallback?: boolean;
    shadowExtendedLookbackTriedMinutes?: number;
    shadowTopSubmittersByCount?: { funderAddress: string; count: number }[];
  };
  /** Per-bot breakdown keyed by botType. */
  perBotResults?: Record<string, {
    botType: string;
    displayName: string;
    opened: number;
    skipped: number;
    candidatesLoaded: number;
    candidatesScored: number;
    maxScore: number | null;
    avgScore: number | null;
    aboveThresholdCount: number;
    rejectedByCooldownCount: number;
    rejectedByRiskLimitCount: number;
    rejectedBySpreadGuardCount?: number;
    rejectedBySlippageGuardCount?: number;
    scoredAfterRelaxation?: number;
    paperTradesCreatedFromRelaxation?: number;
    relaxedDueToConcentrationScored?: number;
    relaxedDueToConcentrationOpened?: number;
    /** Count of candidates rejected because of allocator-imposed daily budget cap (paper-only). */
    rejectedByBudgetCount?: number;
    /** Allocator decision snapshot for this bot when budget allocator is enabled. */
    budgetDecision?: BotBudgetDecision & {
      createdTodayBeforeTick: number;
      openedThisTick: number;
      constrainedByBudget: boolean;
    };
    loadDiagnostics?: PaperTradingTickResult["loadDiagnostics"];
  }>;
  /** When bot budget allocator is enabled: global map of per-bot decisions. */
  botBudgets?: Record<string, BotBudgetDecision & {
    createdTodayBeforeTick: number;
    openedThisTick: number;
    constrainedByBudget: boolean;
  }>;
  /** Bounded decision trace bundle for last tick (observability only). */
  decisionTraceBundle?: PaperDecisionTraceBundle;
  /** Funder used to load paper candidates (align with stream-runtime wallet for shadow rows). */
  funderUsedForCandidateLoad?: string | null;
  /** ShadowCandidate ids after tick dedupe (marketId+side), for debugging. */
  shadowCandidateIds?: string[];
  /** Echo of paper-only ROI env/config (threshold tighten, sizing, liquidity guards). */
  paperRoiAdmissionConfig?: {
    paperMinScoreOverrideGlobal: number | null;
    paperSizeByScoreEnabled: boolean;
    paperMaxSpreadBps: number;
    paperMaxEstimatedSlippageBps: number | null;
  };
  /** Compact proof bundle for ShadowCandidate → paper tick bridge (logging / reports). */
  tickProof?: {
    candidatesLoaded: number;
    candidateIdsSample: string[];
    candidatesScored: number;
    aboveThresholdCount: number;
    opened: number;
    preferredFunderTried: string | null;
    funderUsedForLoad: string;
    usedFunderFallback: boolean;
    extendedLookbackTriedMinutes: number | null;
    shadowRowsQueried: number;
  };
}

/**
 * Run one paper-trading tick: score candidates, open paper trades when score >= threshold (with risk limits and dedupe).
 * Persists last tick result to PaperTradingState.
 */
export async function runPaperTradingTick(funderAddress?: string): Promise<PaperTradingTickResult> {
  const config = getPaperTradingConfig();
  const errors: string[] = [];
  let totalOpened = 0;
  let totalSkipped = 0;

  const emptyResult = (overrides: Partial<PaperTradingTickResult> = {}): PaperTradingTickResult => ({
    opened: 0,
    skipped: 0,
    errors: [],
    lastScoringTime: null,
    modelRunId: null,
    threshold: config.threshold,
    enabled: config.enabled,
    candidatesLoaded: 0,
    candidatesScored: 0,
    maxScore: null,
    avgScore: null,
    aboveThresholdCount: 0,
    rejectedByCooldownCount: 0,
    rejectedByRiskLimitCount: 0,
    topCandidateScores: [],
    scoredAfterRelaxation: 0,
    paperTradesCreatedFromRelaxation: 0,
    funderUsedForCandidateLoad: overrides.funderUsedForCandidateLoad ?? null,
    shadowCandidateIds: overrides.shadowCandidateIds,
    ...overrides,
  });

  if (!config.enabled) {
    return emptyResult({ enabled: false, funderUsedForCandidateLoad: funderAddress ?? null });
  }

  const active = await getActiveOrApprovedShadowModel();
  if (!active) {
    const errMsg = "No ACTIVE or APPROVED shadow model. Train and activate a shadow model first.";
    const result = emptyResult({
      errors: [errMsg],
      enabled: true,
      funderUsedForCandidateLoad: funderAddress ?? null,
    });
    await persistOpenTickState(null, result, errMsg);
    return result;
  }

  const explicitHint =
    funderAddress != null && String(funderAddress).trim() !== "" ? String(funderAddress).trim() : null;
  const preferredFunder = normalizePreferredFunderForShadowLoad(
    explicitHint ?? (await getFunderForPaperTradingTick())
  );

  const profiles = await getActiveBotProfiles();

  const now = new Date();

  let tickShadowPool: PaperTradingCandidate[];
  let globalShadowDiagnostics: ShadowTickLoadDiagnostics;
  try {
    const loaded = await loadShadowCandidatesForPaperTick({ preferredFunder });
    tickShadowPool = loaded.candidates;
    globalShadowDiagnostics = loaded.shadowDiagnostics;
    console.info("[paper-trading] tick shadow pool load", {
      preferredFunder,
      funderUsedForLoad: globalShadowDiagnostics.funderUsedForLoad,
      usedFunderFallback: globalShadowDiagnostics.usedFunderFallback,
      extendedLookbackTriedMinutes: globalShadowDiagnostics.extendedLookbackTriedMinutes,
      shadowRowsQueried: globalShadowDiagnostics.shadowRowsQueried,
      candidatesLoaded: tickShadowPool.length,
      candidateIdsSample: globalShadowDiagnostics.candidateIds.slice(0, 12),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const errMsg = `Failed to get shadow candidates: ${msg}`;
    const result = emptyResult({
      errors: [errMsg],
      enabled: true,
      funderUsedForCandidateLoad: preferredFunder ?? FUNDER_PAPER,
      loadDiagnostics: {
        recommendationsFound: 0,
        noDecisionSnapshot: 0,
        afterPolicyFilter: 0,
        noAssetResolve: 0,
        zeroSizeBuy: 0,
        zeroCandidatesReason: "model_input_or_fetch_error",
      },
    });
    await persistOpenTickState(null, result, errMsg);
    return result;
  }

  const tickFunder =
    globalShadowDiagnostics.funderUsedForLoad?.trim() || preferredFunder || FUNDER_PAPER;

  const perBotResults: NonNullable<PaperTradingTickResult["perBotResults"]> = {};
  const botBudgetsApplied: NonNullable<PaperTradingTickResult["botBudgets"]> = {};
  const allScored: { assetId: string; side: string; score: number }[] = [];
  let totalCandidatesLoaded = 0;
  let totalCandidatesScored = 0;
  let totalAboveThresholdCount = 0;
  let totalRejectedByCooldownCount = 0;
  let totalRejectedByRiskLimitCount = 0;
  let totalScoredAfterRelaxationCount = 0;
  let totalPaperTradesCreatedFromRelaxationCount = 0;
  let totalRelaxedDueToConcentrationScored = 0;
  let totalRelaxedDueToConcentrationOpened = 0;

  if (profiles.length === 0) {
    // Fallback to legacy single-bot behavior with global config and aggregate diagnostics.
    const candidates = tickShadowPool;
    const loadDiagnostics = paperLoadDiagnosticsFromShadowOnly(globalShadowDiagnostics);

    const baseMinScoreLegacy = config.threshold + config.minScoreBuffer;
    const roiMinLegacy = computeEffectivePaperMinScore({
      baseMinScore: baseMinScoreLegacy,
      globalOverride: config.paperMinScoreOverrideGlobal,
      botOverride: null,
    });
    const effectiveMinScore = roiMinLegacy.effectiveMinScore;
    let legacyRejectedSpread = 0;
    let legacyRejectedSlip = 0;
    const openCountTotal = await prisma.paperTrade.count({ where: { status: "open" } });
    const todayStart = new Date(now);
    todayStart.setUTCHours(0, 0, 0, 0);
    const createdToday = await prisma.paperTrade.count({
      where: { createdAt: { gte: todayStart } },
    });
    const createdTodayRelaxedConcentration = await prisma.paperTrade.count({
      where: {
        createdAt: { gte: todayStart },
        paperRelaxationReason: "concentration_high",
      },
    });

    const scored: { assetId: string; side: string; score: number }[] = [];
    let rejectedByCooldownCount = 0;
    let rejectedByRiskLimitCount = 0;
    let aboveThresholdCount = 0;
    let scoredAfterRelaxationCount = 0;
    let paperTradesCreatedFromRelaxationCount = 0;
    let relaxedDueToConcentrationScoredCount = 0;
    let relaxedDueToConcentrationOpenedCount = 0;
    let relaxedConcentrationRejectedByCap = 0;

    const legacyTraces: PaperDecisionTraceEntry[] = [];
    const legacyAgg = initPerBotAggregate("default");

    for (const c of candidates) {
      legacyAgg.totalCandidates++;
      const result = await scoreShadowCandidate(c.shadowInput);
      if (!result.success || !result.result) {
        errors.push(`Score failed for ${c.assetId}: ${result.error ?? "unknown"}`);
        legacyTraces.push(buildTraceEntry({
          botType: "default",
          c,
          championModelRunId: null,
          challengerModelRunId: null,
          championScore: null,
          challengerScore: null,
          scoreDelta: null,
          minScore: effectiveMinScore,
          thresholdEligible: false,
          explorationEligible: false,
          explorationUsed: false,
          budgetLimited: false,
          cooldownLimited: false,
          dedupeLimited: false,
          capsLimited: false,
          finalDisposition: "rejected",
          rejectReasonCode: "missing_shadow_score",
        }));
        incReject(legacyAgg, "missing_shadow_score");
        continue;
      }
      const rawScore = result.result.shadowMlScore;
      const admissionScore = paperShadowAdmissionScore(result.result, config);
      const championModelRunId = result.result.modelId;
      const championTargetLabel = result.result.modelTargetLabel;
      const championChallenger = await scorePaperChampionAndChallenger(
        c.shadowInput,
        rawScore,
        championModelRunId,
        championTargetLabel
      );
      const legacyTraceAdmissionFields = paperAdmissionTraceScalars(result.result, admissionScore, config);
      scored.push({ assetId: c.assetId, side: c.side, score: admissionScore });
      if (c.paperPolicyMode === "relaxed_block_candidate") scoredAfterRelaxationCount++;
      if (c.paperRelaxationReason === "concentration_high") {
        relaxedDueToConcentrationScoredCount++;
      }
      if (admissionScore >= effectiveMinScore) aboveThresholdCount++;

      console.log("[ADMISSION_DEBUG]", {
        botType: "default",
        assetId: c.assetId,
        championScore: championChallenger.championScore,
        admissionScore: legacyTraceAdmissionFields.admissionScore,
        shadowMlScoreRaw: legacyTraceAdmissionFields.shadowMlScoreRaw,
        shadowMlScoreCalibrated: legacyTraceAdmissionFields.shadowMlScoreCalibrated,
        admissionUsesCalibrated: legacyTraceAdmissionFields.admissionUsesCalibrated,
        minScore: effectiveMinScore,
        explorationAdmissionMode: "threshold",
        thresholdEligible: paperTraceThresholdEligible(admissionScore, effectiveMinScore),
      });

      if (admissionScore < effectiveMinScore) {
        legacyTraces.push(buildTraceEntry({
          botType: "default",
          c,
          championModelRunId,
          challengerModelRunId: championChallenger.challengerModelRunId,
          championScore: championChallenger.championScore,
          challengerScore: championChallenger.challengerScore,
          scoreDelta: championChallenger.scoreDelta,
          ...legacyTraceAdmissionFields,
          minScore: effectiveMinScore,
          thresholdEligible: paperTraceThresholdEligible(admissionScore, effectiveMinScore),
          explorationEligible: false,
          explorationUsed: false,
          budgetLimited: false,
          cooldownLimited: false,
          dedupeLimited: false,
          capsLimited: false,
          finalDisposition: "rejected",
          rejectReasonCode: "below_threshold",
        }));
        incReject(legacyAgg, "below_threshold");
        totalSkipped++;
        continue;
      }
      const execCtxLegacy = buildExecutionContextFromShadowInput(c.shadowInput);
      const liqLegacy = evaluatePaperLiquidityGuards(
        execCtxLegacy.spreadBps,
        execCtxLegacy.estimatedSlippageBps,
        config.paperMaxSpreadBps,
        config.paperMaxEstimatedSlippageBps
      );
      if (!liqLegacy.ok) {
        const code: PaperDecisionRejectReasonCode =
          liqLegacy.reason === "spread" ? "spread_guard" : "slippage_guard";
        legacyTraces.push(buildTraceEntry({
          botType: "default",
          c,
          championModelRunId,
          challengerModelRunId: championChallenger.challengerModelRunId,
          championScore: championChallenger.championScore,
          challengerScore: championChallenger.challengerScore,
          scoreDelta: championChallenger.scoreDelta,
          ...legacyTraceAdmissionFields,
          minScore: effectiveMinScore,
          thresholdEligible: paperTraceThresholdEligible(admissionScore, effectiveMinScore),
          explorationEligible: false,
          explorationUsed: false,
          budgetLimited: false,
          cooldownLimited: false,
          dedupeLimited: false,
          capsLimited: false,
          finalDisposition: "rejected",
          rejectReasonCode: code,
        }));
        incReject(legacyAgg, code);
        totalSkipped++;
        if (liqLegacy.reason === "spread") legacyRejectedSpread++;
        else legacyRejectedSlip++;
        continue;
      }
      if (config.maxOpenTotal > 0 && openCountTotal + totalOpened >= config.maxOpenTotal) {
        legacyTraces.push(buildTraceEntry({
          botType: "default",
          c,
          championModelRunId,
          challengerModelRunId: championChallenger.challengerModelRunId,
          championScore: championChallenger.championScore,
          challengerScore: championChallenger.challengerScore,
          scoreDelta: championChallenger.scoreDelta,
          ...legacyTraceAdmissionFields,
          minScore: effectiveMinScore,
          thresholdEligible: paperTraceThresholdEligible(admissionScore, effectiveMinScore),
          explorationEligible: false,
          explorationUsed: false,
          budgetLimited: false,
          cooldownLimited: false,
          dedupeLimited: false,
          capsLimited: true,
          finalDisposition: "rejected",
          rejectReasonCode: "max_open_total",
        }));
        incReject(legacyAgg, "max_open_total");
        rejectedByRiskLimitCount++;
        totalSkipped++;
        continue;
      }
      if (config.maxDailyNewTrades > 0 && createdToday + totalOpened >= config.maxDailyNewTrades) {
        legacyTraces.push(buildTraceEntry({
          botType: "default",
          c,
          championModelRunId,
          challengerModelRunId: championChallenger.challengerModelRunId,
          championScore: championChallenger.championScore,
          challengerScore: championChallenger.challengerScore,
          scoreDelta: championChallenger.scoreDelta,
          ...legacyTraceAdmissionFields,
          minScore: effectiveMinScore,
          thresholdEligible: paperTraceThresholdEligible(admissionScore, effectiveMinScore),
          explorationEligible: false,
          explorationUsed: false,
          budgetLimited: true,
          cooldownLimited: false,
          dedupeLimited: false,
          capsLimited: false,
          finalDisposition: "rejected",
          rejectReasonCode: "budget_cap",
        }));
        incReject(legacyAgg, "budget_cap");
        rejectedByRiskLimitCount++;
        totalSkipped++;
        continue;
      }
      if (await hasOpenOrRecentPaperTrade("default", c.assetId, config.cooldownHours)) {
        legacyTraces.push(buildTraceEntry({
          botType: "default",
          c,
          championModelRunId,
          challengerModelRunId: championChallenger.challengerModelRunId,
          championScore: championChallenger.championScore,
          challengerScore: championChallenger.challengerScore,
          scoreDelta: championChallenger.scoreDelta,
          ...legacyTraceAdmissionFields,
          minScore: effectiveMinScore,
          thresholdEligible: paperTraceThresholdEligible(admissionScore, effectiveMinScore),
          explorationEligible: false,
          explorationUsed: false,
          budgetLimited: false,
          cooldownLimited: true,
          dedupeLimited: false,
          capsLimited: false,
          finalDisposition: "rejected",
          rejectReasonCode: "cooldown_asset",
        }));
        incReject(legacyAgg, "cooldown_asset");
        rejectedByCooldownCount++;
        totalSkipped++;
        continue;
      }
      if (await hasOpenOrRecentPaperTradeForMarket("default", c.marketId, config.cooldownMarketHours)) {
        legacyTraces.push(buildTraceEntry({
          botType: "default",
          c,
          championModelRunId,
          challengerModelRunId: championChallenger.challengerModelRunId,
          championScore: championChallenger.championScore,
          challengerScore: championChallenger.challengerScore,
          scoreDelta: championChallenger.scoreDelta,
          ...legacyTraceAdmissionFields,
          minScore: effectiveMinScore,
          thresholdEligible: paperTraceThresholdEligible(admissionScore, effectiveMinScore),
          explorationEligible: false,
          explorationUsed: false,
          budgetLimited: false,
          cooldownLimited: true,
          dedupeLimited: false,
          capsLimited: false,
          finalDisposition: "rejected",
          rejectReasonCode: "cooldown_market",
        }));
        incReject(legacyAgg, "cooldown_market");
        rejectedByCooldownCount++;
        totalSkipped++;
        continue;
      }
      if (config.maxOpenPerMarket > 0) {
        const openInMarket = await prisma.paperTrade.count({
          where: { marketId: c.marketId, status: "open" },
        });
        if (openInMarket >= config.maxOpenPerMarket) {
          legacyTraces.push(buildTraceEntry({
            botType: "default",
            c,
            championModelRunId,
            challengerModelRunId: championChallenger.challengerModelRunId,
            championScore: championChallenger.championScore,
            challengerScore: championChallenger.challengerScore,
            scoreDelta: championChallenger.scoreDelta,
            ...legacyTraceAdmissionFields,
            minScore: effectiveMinScore,
            thresholdEligible: paperTraceThresholdEligible(admissionScore, effectiveMinScore),
            explorationEligible: false,
            explorationUsed: false,
            budgetLimited: false,
            cooldownLimited: false,
            dedupeLimited: false,
            capsLimited: true,
            finalDisposition: "rejected",
            rejectReasonCode: "max_open_per_market",
          }));
          incReject(legacyAgg, "max_open_per_market");
          rejectedByRiskLimitCount++;
          totalSkipped++;
          continue;
        }
      }
      const themeKey = c.theme ?? "__none__";
      if (config.maxOpenPerTheme > 0 && themeKey !== "__none__") {
        const openInTheme = await prisma.paperTrade.count({
          where: { theme: themeKey, status: "open" },
        });
        if (openInTheme >= config.maxOpenPerTheme) {
          legacyTraces.push(buildTraceEntry({
            botType: "default",
            c,
            championModelRunId,
            challengerModelRunId: championChallenger.challengerModelRunId,
            championScore: championChallenger.championScore,
            challengerScore: championChallenger.challengerScore,
            scoreDelta: championChallenger.scoreDelta,
            ...legacyTraceAdmissionFields,
            minScore: effectiveMinScore,
            thresholdEligible: paperTraceThresholdEligible(admissionScore, effectiveMinScore),
            explorationEligible: false,
            explorationUsed: false,
            budgetLimited: false,
            cooldownLimited: false,
            dedupeLimited: false,
            capsLimited: true,
            finalDisposition: "rejected",
            rejectReasonCode: "max_open_per_theme",
          }));
          incReject(legacyAgg, "max_open_per_theme");
          rejectedByRiskLimitCount++;
          totalSkipped++;
          continue;
        }
      }
      const categoryKey = c.category ?? "__none__";
      if (config.maxOpenPerCategory > 0 && categoryKey !== "__none__") {
        const openInCategory = await prisma.paperTrade.count({
          where: { category: categoryKey, status: "open" },
        });
        if (openInCategory >= config.maxOpenPerCategory) {
          legacyTraces.push(buildTraceEntry({
            botType: "default",
            c,
            championModelRunId,
            challengerModelRunId: championChallenger.challengerModelRunId,
            championScore: championChallenger.championScore,
            challengerScore: championChallenger.challengerScore,
            scoreDelta: championChallenger.scoreDelta,
            ...legacyTraceAdmissionFields,
            minScore: effectiveMinScore,
            thresholdEligible: paperTraceThresholdEligible(admissionScore, effectiveMinScore),
            explorationEligible: false,
            explorationUsed: false,
            budgetLimited: false,
            cooldownLimited: false,
            dedupeLimited: false,
            capsLimited: true,
            finalDisposition: "rejected",
            rejectReasonCode: "max_open_per_category",
          }));
          incReject(legacyAgg, "max_open_per_category");
          rejectedByRiskLimitCount++;
          totalSkipped++;
          continue;
        }
      }

      const dedupeKey = buildDedupeKey(active.run.id, "default", c.assetId, c.side, config.cooldownHours);
      const existing = await prisma.paperTrade.findUnique({ where: { dedupeKey } });
      if (existing) {
        legacyTraces.push(buildTraceEntry({
          botType: "default",
          c,
          championModelRunId,
          challengerModelRunId: championChallenger.challengerModelRunId,
          championScore: championChallenger.championScore,
          challengerScore: championChallenger.challengerScore,
          scoreDelta: championChallenger.scoreDelta,
          ...legacyTraceAdmissionFields,
          minScore: effectiveMinScore,
          thresholdEligible: paperTraceThresholdEligible(admissionScore, effectiveMinScore),
          explorationEligible: false,
          explorationUsed: false,
          budgetLimited: false,
          cooldownLimited: false,
          dedupeLimited: true,
          capsLimited: false,
          finalDisposition: "rejected",
          rejectReasonCode: "dedupe",
          dedupeKey,
        }));
        incReject(legacyAgg, "dedupe");
        rejectedByCooldownCount++;
        totalSkipped++;
        continue;
      }

      if (await hasOpenPaperTradeForMarketAndSide("default", c.marketId, c.side)) {
        legacyTraces.push(buildTraceEntry({
          botType: "default",
          c,
          championModelRunId,
          challengerModelRunId: championChallenger.challengerModelRunId,
          championScore: championChallenger.championScore,
          challengerScore: championChallenger.challengerScore,
          scoreDelta: championChallenger.scoreDelta,
          ...legacyTraceAdmissionFields,
          minScore: effectiveMinScore,
          thresholdEligible: paperTraceThresholdEligible(admissionScore, effectiveMinScore),
          explorationEligible: false,
          explorationUsed: false,
          budgetLimited: false,
          cooldownLimited: false,
          dedupeLimited: true,
          capsLimited: false,
          finalDisposition: "rejected",
          rejectReasonCode: "dedupe",
        }));
        incReject(legacyAgg, "dedupe");
        rejectedByCooldownCount++;
        totalSkipped++;
        continue;
      }

      const fromRelaxation = c.paperPolicyMode === "relaxed_block_candidate";
      if (fromRelaxation) paperTradesCreatedFromRelaxationCount++;
      if (c.paperRelaxationReason === "concentration_high") {
        const perTickCap = config.relaxedConcentrationMaxPerTick;
        const perDayCap = config.relaxedConcentrationMaxPerDay;
        const perMarketCap = config.relaxedConcentrationMaxOpenPerMarket;
        const perThemeCap = config.relaxedConcentrationMaxOpenPerTheme;
        const themeKey = c.theme ?? "__none__";
        const exceedsTick = perTickCap > 0 && relaxedDueToConcentrationOpenedCount >= perTickCap;
        const exceedsDay =
          perDayCap > 0 &&
          createdTodayRelaxedConcentration + relaxedDueToConcentrationOpenedCount >= perDayCap;
        let exceedsMarket = false;
        if (perMarketCap > 0) {
          const openConcentrationInMarket = await prisma.paperTrade.count({
            where: {
              marketId: c.marketId,
              status: "open",
              paperRelaxationReason: "concentration_high",
            },
          });
          exceedsMarket = openConcentrationInMarket >= perMarketCap;
        }
        let exceedsTheme = false;
        if (perThemeCap > 0 && themeKey !== "__none__") {
          const openConcentrationInTheme = await prisma.paperTrade.count({
            where: {
              theme: themeKey,
              status: "open",
              paperRelaxationReason: "concentration_high",
            },
          });
          exceedsTheme = openConcentrationInTheme >= perThemeCap;
        }
        if (exceedsTick || exceedsDay || exceedsMarket || exceedsTheme) {
          relaxedConcentrationRejectedByCap++;
          legacyTraces.push(buildTraceEntry({
            botType: "default",
            c,
            championModelRunId,
            challengerModelRunId: championChallenger.challengerModelRunId,
            championScore: championChallenger.championScore,
            challengerScore: championChallenger.challengerScore,
            scoreDelta: championChallenger.scoreDelta,
            ...legacyTraceAdmissionFields,
            minScore: effectiveMinScore,
            thresholdEligible: paperTraceThresholdEligible(admissionScore, effectiveMinScore),
            explorationEligible: false,
            explorationUsed: false,
            budgetLimited: false,
            cooldownLimited: false,
            dedupeLimited: false,
            capsLimited: true,
            finalDisposition: "rejected",
            rejectReasonCode: "max_open_total",
          }));
          incReject(legacyAgg, "max_open_total");
          totalSkipped++;
          continue;
        }
      }

      const entryPriceNum = parseEntryPrice(c.entryPrice);
      const entryPriceBand = classifyEntryPriceBand(entryPriceNum);

      // Provenance: actual admission path. Legacy path only admits via threshold (score >= minScore).
      const explorationAdmissionMode: "threshold" | "exploration" = "threshold";

      try {
        const profileSnapshot = JSON.stringify({
          botType: "default",
          displayName: "Default (legacy)",
          targetLabel: active.run.targetLabel,
          botVersion: null,
          threshold: config.threshold,
          minScoreBuffer: config.minScoreBuffer,
        });
        const sizeBucketLegacy = config.paperSizeByScoreEnabled
          ? resolvePaperSizeBucket(admissionScore, effectiveMinScore, config.paperSizeScoreTiers)
          : null;
        const paperMultLegacy = sizeBucketLegacy?.multiplier ?? 1;
        const sizeLabelLegacy = sizeBucketLegacy?.label ?? "baseline";
        const intendedSizeLegacy = config.paperSizeByScoreEnabled
          ? applyPaperIntendedSizeMultiplier(c.intendedSize, paperMultLegacy)
          : c.intendedSize;
        // Paper-only telemetry: record a ShadowCandidate row so labels can be joined to PaperTrade via (recommendationId, assetId, side).
        void recordShadowCandidate({
          funderAddress: tickFunder,
          recommendationId: c.recommendationId,
          orderIntentId: null,
          assetId: c.assetId,
          marketId: c.marketId,
          side: c.side,
          intendedPrice: parseFloat(c.entryPrice),
          intendedSize: parseFloat(intendedSizeLegacy),
          candidateSource: "paper_trading",
          wasBlocked: false,
          wasSubmitted: false,
        }).catch(() => {});
        const legacyBaseMetadata: Record<string, unknown> = {
          recommendationId: c.recommendationId,
          targetLabel: active.run.targetLabel,
          ...(c.shadowCandidateId && { shadowCandidateId: c.shadowCandidateId }),
          ...(c.passedViaRelaxation &&
            c.relaxedBlockReason && {
              paperOnlyRelaxation: true,
              overriddenBlockReason: c.relaxedBlockReason,
            }),
          ...(c.derivationSource && { derivationSource: c.derivationSource }),
        };
        const paperRoiLegacy: PaperRoiAdmissionMeta = {
          effectiveMinScoreUsed: effectiveMinScore,
          baseMinScoreBeforePaperOverride: roiMinLegacy.baseMinScore,
          globalPaperMinScoreOverride: roiMinLegacy.globalPaperMinScoreOverride,
          botPaperMinScoreOverride: null,
          admittedUnderTightenedPaperThreshold:
            explorationAdmissionMode === "threshold" && roiMinLegacy.admittedUnderTightenedPaperThreshold,
          sizeByScoreEnabled: config.paperSizeByScoreEnabled,
          sizeScoreBucketLabel: sizeLabelLegacy,
          paperSizeMultiplier: paperMultLegacy,
          spreadBpsAtAdmission: execCtxLegacy.spreadBps,
          estimatedSlippageBpsAtAdmission: execCtxLegacy.estimatedSlippageBps,
          blockedBySpreadGuard: false,
          blockedBySlippageGuard: false,
        };
        const paperShadowCalLegacy: PaperShadowScoreCalibrationMeta = {
          shadowMlScoreRaw: rawScore,
          shadowMlLogit: result.result.shadowMlLogit,
          shadowMlScoreCalibrated: result.result.shadowMlScoreCalibrated,
          logitTemperature: config.paperShadowLogitTemperature,
          usedCalibratedForAdmission: config.paperShadowUseCalibratedScoreForPaper,
          admissionScore,
        };
        const legacyOpenAttribution = buildPaperTradeOpenAttribution({
          shadowResult: result.result,
          thresholdUsed: config.threshold,
          minScoreUsed: effectiveMinScore,
          shadowCandidateId: c.shadowCandidateId,
          shadowInput: c.shadowInput,
          paperRoiAdmission: paperRoiLegacy,
          paperShadowScoreCalibration: paperShadowCalLegacy,
        });
        await prisma.paperTrade.create({
          data: {
            dedupeKey,
            modelRunId: active.run.id,
            championModelRunId: championChallenger.championModelRunId,
            challengerModelRunId: championChallenger.challengerModelRunId,
            marketId: c.marketId,
            assetId: c.assetId,
            theme: c.theme,
            category: c.category,
            funderAddress: tickFunder,
            side: c.side,
            score: rawScore,
            championScore: championChallenger.championScore,
            challengerScore: championChallenger.challengerScore,
            challengerScoreDelta: championChallenger.scoreDelta,
            challengerAvailable: championChallenger.challengerAvailable,
            threshold: config.threshold,
            entryPrice: c.entryPrice,
            entryTime: now,
            intendedSize: intendedSizeLegacy,
            status: "open",
            explorationAdmissionMode,
            metadataJson: JSON.stringify(
              mergeOpenAttributionIntoMetadata(legacyBaseMetadata, legacyOpenAttribution)
            ),
            sourceDecisionState: c.sourceDecisionState ?? null,
            paperPolicyMode: c.paperPolicyMode ?? null,
            paperRelaxationReason: c.paperRelaxationReason ?? null,
            originalBlockingReasons: prismaJsonStringArray(c.originalBlockingReasons),
            paperEligibilityVersion: c.paperEligibilityVersion ?? null,
            botType: "default",
            botVersion: null,
            targetLabel: active.run.targetLabel,
            entryPriceBand,
            profileSnapshotJson: profileSnapshot,
          },
        });
        totalOpened++;
        legacyAgg.admitted++;
        if (c.paperRelaxationReason === "concentration_high") {
          relaxedDueToConcentrationOpenedCount++;
        }
        legacyTraces.push(buildTraceEntry({
          botType: "default",
          c,
          championModelRunId: championChallenger.championModelRunId,
          challengerModelRunId: championChallenger.challengerModelRunId,
          championScore: championChallenger.championScore,
          challengerScore: championChallenger.challengerScore,
          scoreDelta: championChallenger.scoreDelta,
          ...legacyTraceAdmissionFields,
          minScore: effectiveMinScore,
          thresholdEligible: paperTraceThresholdEligible(admissionScore, effectiveMinScore),
          explorationEligible: false,
          explorationUsed: false,
          budgetLimited: false,
          cooldownLimited: false,
          dedupeLimited: false,
          capsLimited: false,
          finalDisposition: "admitted",
          dedupeKey,
        }));
        console.log(
          `[paper-trading] Opened paper trade assetId=${c.assetId} raw=${rawScore.toFixed(
            4
          )} admission=${admissionScore.toFixed(4)} threshold=${config.threshold}`
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("Unique constraint") || msg.includes("dedupeKey")) {
          legacyTraces.push(buildTraceEntry({
            botType: "default",
            c,
            championModelRunId: championChallenger.championModelRunId,
            challengerModelRunId: championChallenger.challengerModelRunId,
            championScore: championChallenger.championScore,
            challengerScore: championChallenger.challengerScore,
            scoreDelta: championChallenger.scoreDelta,
            ...legacyTraceAdmissionFields,
            minScore: effectiveMinScore,
            thresholdEligible: paperTraceThresholdEligible(admissionScore, effectiveMinScore),
            explorationEligible: false,
            explorationUsed: false,
            budgetLimited: false,
            cooldownLimited: false,
            dedupeLimited: true,
            capsLimited: false,
            finalDisposition: "rejected",
            rejectReasonCode: "dedupe",
            dedupeKey,
          }));
          incReject(legacyAgg, "dedupe");
          totalSkipped++;
          continue;
        }
        errors.push(`Create paper trade failed ${c.assetId}: ${msg}`);
      }
    }

    const scores = scored.map((s) => s.score);
    const maxScore = scores.length > 0 ? Math.max(...scores) : null;
    const avgScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
    const topCandidateScores = [...scored]
      .sort((a, b) => b.score - a.score)
      .slice(0, TOP_CANDIDATES_SAMPLE_SIZE)
      .map((s) => ({
        assetId: s.assetId.slice(0, 12) + (s.assetId.length > 12 ? "…" : ""),
        side: s.side,
        score: s.score,
      }));

    const tickResult: PaperTradingTickResult = {
      opened: totalOpened,
      skipped: totalSkipped,
      errors,
      lastScoringTime: now.toISOString(),
      modelRunId: active.run.id,
      threshold: config.threshold,
      enabled: true,
      candidatesLoaded: candidates.length,
      candidatesScored: scored.length,
      maxScore,
      avgScore,
      aboveThresholdCount,
      rejectedByCooldownCount,
      rejectedByRiskLimitCount,
      rejectedBySpreadGuardCount: legacyRejectedSpread,
      rejectedBySlippageGuardCount: legacyRejectedSlip,
      topCandidateScores,
      scoredAfterRelaxation: scoredAfterRelaxationCount,
      paperTradesCreatedFromRelaxation: paperTradesCreatedFromRelaxationCount,
      relaxedScoredSuccessfully: scoredAfterRelaxationCount,
      relaxedOpenedTrades: paperTradesCreatedFromRelaxationCount,
      relaxedDueToConcentrationScored: relaxedDueToConcentrationScoredCount,
      relaxedDueToConcentrationOpened: relaxedDueToConcentrationOpenedCount,
      funderUsedForCandidateLoad: tickFunder,
      shadowCandidateIds: loadDiagnostics.shadowCandidateIds,
      paperRoiAdmissionConfig: {
        paperMinScoreOverrideGlobal: config.paperMinScoreOverrideGlobal,
        paperSizeByScoreEnabled: config.paperSizeByScoreEnabled,
        paperMaxSpreadBps: config.paperMaxSpreadBps,
        paperMaxEstimatedSlippageBps: config.paperMaxEstimatedSlippageBps,
      },
      tickProof: {
        candidatesLoaded: candidates.length,
        candidateIdsSample: (globalShadowDiagnostics.candidateIds ?? []).slice(0, 12),
        candidatesScored: scored.length,
        aboveThresholdCount,
        opened: totalOpened,
        preferredFunderTried: globalShadowDiagnostics.preferredFunderTried ?? preferredFunder,
        funderUsedForLoad: tickFunder,
        usedFunderFallback: globalShadowDiagnostics.usedFunderFallback ?? false,
        extendedLookbackTriedMinutes: globalShadowDiagnostics.extendedLookbackTriedMinutes ?? null,
        shadowRowsQueried: globalShadowDiagnostics.shadowRowsQueried,
      },
      loadDiagnostics: {
        ...loadDiagnostics,
        relaxedConcentrationRejectedByCap,
        relaxedConcentrationStakeUsed: String(config.relaxedConcentrationStakeNotional),
      },
      decisionTraceBundle: {
        generatedAt: now.toISOString(),
        maxTracesStored: MAX_DECISION_TRACES_STORED,
        totalCandidatesConsidered: candidates.length,
        perBotAggregates: [legacyAgg],
        traces: legacyTraces.slice(-MAX_DECISION_TRACES_STORED),
      },
    };
    console.info("[paper-trading] tick shadow bridge proof", tickResult.tickProof);
    await persistOpenTickState(
      now,
      tickResult,
      errors.length > 0 ? errors[errors.length - 1] : null
    );
    return tickResult;
  }

  // Optional paper-only bot budget allocator (v1): conservative daily caps per bot.
  let budgetDecisionsByBot: Record<string, BotBudgetDecision> = {};
  const budgetAllocatorEnabled = enablePaperBotBudgetAllocatorV1();
  if (budgetAllocatorEnabled) {
    try {
      const decisions = await computeBotBudgets({ lookbackDays: 30 });
      for (const d of decisions) {
        budgetDecisionsByBot[d.botType] = d;
      }
    } catch (e) {
      errors.push(
        `Bot budget allocator failed (paper-only, ignored this tick): ${
          e instanceof Error ? e.message : String(e)
        }`
      );
      budgetDecisionsByBot = {};
    }
  }

  // Paper-only exploration allocator (v1): gated by exploration policy mode.
  const explorationPolicyMode = getExplorationPolicyMode();
  const explorationAllocatorEnabled = explorationPolicyMode === "blended_allocator_v1";

  const allTraces: PaperDecisionTraceEntry[] = [];
  const tracePerBotAggregates: Record<string, PaperDecisionTracePerBotAggregate> = {};
  const shadowTickIdsAggregate = new Set<string>();
  for (const id of globalShadowDiagnostics.candidateIds ?? []) {
    shadowTickIdsAggregate.add(id);
  }

  let totalRejectedBySpreadGuard = 0;
  let totalRejectedBySlippageGuard = 0;

  const paperInTickOpensByBot: Record<string, number> = {};
  const paperExplorationOpensByBot: Record<string, number> = {};
  const paperRelaxedConcOpenedByBot: Record<string, number> = {};
  for (const p of profiles) {
    tracePerBotAggregates[p.botType] = initPerBotAggregate(p.botType);
  }

  for (let profileIndex = 0; profileIndex < profiles.length; profileIndex++) {
    const profile = profiles[profileIndex];
    const profileThreshold = profile.threshold;
    const profileMinScoreBuffer = profile.minScoreBuffer;
    const baseMinScore = profileThreshold + profileMinScoreBuffer;
    const roiMinProfile = computeEffectivePaperMinScore({
      baseMinScore,
      globalOverride: config.paperMinScoreOverrideGlobal,
      botOverride: readPaperBotMinScoreOverrideEnv(profile.botType),
    });
    const effectiveMinScore = roiMinProfile.effectiveMinScore;
    let botRejectedSpread = 0;
    let botRejectedSlip = 0;

    const profileFilterDiag = filterShadowCandidatesForProfileWithDiagnostics(
      tickShadowPool,
      profile as EffectiveBotProfile,
      { logRemovedAll: true }
    );
    const candidates = profileFilterDiag.kept;
    const profileFilteredOut = profileFilterDiag.beforeCount - profileFilterDiag.afterCount;
    const loadDiagnostics = mergeShadowDiagnosticsIntoLoadDiagnostics(
      globalShadowDiagnostics,
      candidates.length,
      tickShadowPool.length,
      profileFilteredOut,
      { rejectByReason: profileFilterDiag.rejectByReason }
    );
    if (candidates.length === 0 && tickShadowPool.length > 0) {
      loadDiagnostics.zeroCandidatesReason = "profile_filter_removed_all";
    } else if (candidates.length === 0 && tickShadowPool.length === 0) {
      loadDiagnostics.zeroCandidatesReason = globalShadowDiagnostics.zeroCandidatesReason;
    }
    console.info("[paper-trading] tick candidate load", {
      funderUsedForLoad: tickFunder,
      preferredFunder,
      botType: profile.botType,
      poolSize: tickShadowPool.length,
      profileFilterBeforeCount: profileFilterDiag.beforeCount,
      profileFilterAfterCount: profileFilterDiag.afterCount,
      profileFilterRejectByReason: profileFilterDiag.rejectByReason,
      candidatesLoaded: candidates.length,
      candidateIds: loadDiagnostics.shadowCandidateIds ?? [],
      lookbackMinutes: loadDiagnostics.shadowLookbackMinutes,
    });

    const openCountTotal = await prisma.paperTrade.count({
      where: { status: "open", botType: profile.botType },
    });
    const todayStart = new Date(now);
    todayStart.setUTCHours(0, 0, 0, 0);
    const createdToday = await prisma.paperTrade.count({
      where: { createdAt: { gte: todayStart }, botType: profile.botType },
    });

    // Per-bot exploration caps (paper-only, below-threshold widening only).
    const explorationEnabledForBot =
      explorationAllocatorEnabled && profile.explorationEnabled === true;
    const explorationBandBelowMinScore =
      profile.explorationBandBelowMinScore > 0
        ? profile.explorationBandBelowMinScore
        : 0;
    const explorationMinScore =
      explorationBandBelowMinScore > 0
        ? Math.max(effectiveMinScore - explorationBandBelowMinScore, 0)
        : 0;
    const explorationMaxPerTick =
      profile.explorationMaxPerTick && profile.explorationMaxPerTick > 0
        ? profile.explorationMaxPerTick
        : 0;
    const explorationMaxPerDay =
      profile.explorationMaxPerDay && profile.explorationMaxPerDay > 0
        ? profile.explorationMaxPerDay
        : 0;
    let explorationCreatedToday = 0;
    if (explorationEnabledForBot && explorationMaxPerDay > 0) {
      explorationCreatedToday = await prisma.paperTrade.count({
        where: {
          createdAt: { gte: todayStart },
          botType: profile.botType,
          explorationAdmissionMode: "exploration",
        },
      });
    }

    const agg = tracePerBotAggregates[profile.botType]!;

    const scored: { assetId: string; side: string; score: number }[] = [];
    let rejectedByCooldownCount = 0;
    let rejectedByRiskLimitCount = 0;
    let aboveThresholdCount = 0;
    let scoredAfterRelaxationCount = 0;
    let paperTradesCreatedFromRelaxationCount = 0;
    let relaxedDueToConcentrationScoredCount = 0;
    let relaxedDueToConcentrationOpenedCount =
      paperRelaxedConcOpenedByBot[profile.botType] ?? 0;
    let relaxedConcentrationRejectedByCap = 0;
    let openedForBot = paperInTickOpensByBot[profile.botType] ?? 0;
    let skippedForBot = 0;
    let rejectedByBudgetCount = 0;
    let explorationOpenedForBot = paperExplorationOpensByBot[profile.botType] ?? 0;

    const decision = budgetDecisionsByBot[profile.botType];
    const createdTodayBeforeTick = createdToday;
    const createdTodayRelaxedConcentration = await prisma.paperTrade.count({
      where: {
        createdAt: { gte: todayStart },
        botType: profile.botType,
        paperRelaxationReason: "concentration_high",
      },
    });

    for (const c of candidates) {
      agg.totalCandidates++;
      const result = await scoreShadowCandidate(c.shadowInput);
      if (!result.success || !result.result) {
        errors.push(
          `Score failed for ${c.assetId} (botType=${profile.botType}): ${result.error ?? "unknown"}`
        );
        allTraces.push(buildTraceEntry({
          botType: profile.botType,
          c,
          championModelRunId: null,
          challengerModelRunId: null,
          championScore: null,
          challengerScore: null,
          scoreDelta: null,
          minScore: effectiveMinScore,
          explorationMinScore: explorationEnabledForBot ? explorationMinScore : null,
          thresholdEligible: false,
          explorationEligible: false,
          explorationUsed: false,
          budgetLimited: false,
          cooldownLimited: false,
          dedupeLimited: false,
          capsLimited: false,
          finalDisposition: "rejected",
          rejectReasonCode: "missing_shadow_score",
        }));
        incReject(agg, "missing_shadow_score");
        continue;
      }
      const rawScore = result.result.shadowMlScore;
      const admissionScore = paperShadowAdmissionScore(result.result, config);
      const championModelRunId = result.result.modelId;
      const championTargetLabel = result.result.modelTargetLabel;
      const championChallenger = await scorePaperChampionAndChallenger(
        c.shadowInput,
        rawScore,
        championModelRunId,
        championTargetLabel
      );
      const traceAdmissionFields = paperAdmissionTraceScalars(result.result, admissionScore, config);
      scored.push({ assetId: c.assetId, side: c.side, score: admissionScore });
      allScored.push({ assetId: c.assetId, side: c.side, score: admissionScore });
      if (c.paperPolicyMode === "relaxed_block_candidate") scoredAfterRelaxationCount++;
      if (c.paperRelaxationReason === "concentration_high") {
        relaxedDueToConcentrationScoredCount++;
      }
      if (admissionScore >= effectiveMinScore) aboveThresholdCount++;

      // Admission decision: threshold path (admissionScore >= effectiveMinScore) or paper-only exploration path
      // for a narrow band below effectiveMinScore when exploration is enabled for this bot.
      let explorationAdmissionMode: "threshold" | "exploration" | null = null;
      if (admissionScore >= effectiveMinScore) {
        explorationAdmissionMode = "threshold";
      } else {
        const resolved = paperAdmissionExplorationResolveForDailyCapOverflow({
          admissionScore,
          effectiveMinScore,
          explorationEnabledForBot,
          explorationBandBelowMinScore,
          explorationMinScore,
          explorationMaxPerTick,
          explorationMaxPerDay,
          explorationOpenedForBot,
          explorationCreatedToday,
        });
        if (!resolved.ok) {
          allTraces.push(buildTraceEntry({
            botType: profile.botType,
            c,
            championModelRunId,
            challengerModelRunId: championChallenger.challengerModelRunId,
            championScore: championChallenger.championScore,
            challengerScore: championChallenger.challengerScore,
            scoreDelta: championChallenger.scoreDelta,
            ...traceAdmissionFields,
            minScore: effectiveMinScore,
            explorationMinScore: explorationEnabledForBot ? explorationMinScore : null,
            thresholdEligible: paperTraceThresholdEligible(admissionScore, effectiveMinScore),
            explorationEligible: resolved.withinExplorationBandOnReject,
            explorationUsed: false,
            budgetLimited: false,
            cooldownLimited: false,
            dedupeLimited: false,
            capsLimited: false,
            finalDisposition: "rejected",
            rejectReasonCode: resolved.reject,
          }));
          incReject(agg, resolved.reject);
          skippedForBot++;
          continue;
        }
        explorationAdmissionMode = resolved.mode;
        if (resolved.mode === "exploration") agg.explorationEligible++;
      }
      if (explorationAdmissionMode === "exploration") agg.explorationUsed++;

      console.log("[ADMISSION_DEBUG]", {
        botType: profile.botType,
        assetId: c.assetId,
        championScore: championChallenger.championScore,
        admissionScore: traceAdmissionFields.admissionScore,
        shadowMlScoreRaw: traceAdmissionFields.shadowMlScoreRaw,
        shadowMlScoreCalibrated: traceAdmissionFields.shadowMlScoreCalibrated,
        admissionUsesCalibrated: traceAdmissionFields.admissionUsesCalibrated,
        minScore: effectiveMinScore,
        explorationAdmissionMode,
        thresholdEligible: paperTraceThresholdEligible(admissionScore, effectiveMinScore),
      });

      const execCtxBot = buildExecutionContextFromShadowInput(c.shadowInput);
      const liqBot = evaluatePaperLiquidityGuards(
        execCtxBot.spreadBps,
        execCtxBot.estimatedSlippageBps,
        config.paperMaxSpreadBps,
        config.paperMaxEstimatedSlippageBps
      );
      if (!liqBot.ok) {
        const code: PaperDecisionRejectReasonCode =
          liqBot.reason === "spread" ? "spread_guard" : "slippage_guard";
        allTraces.push(buildTraceEntry({
          botType: profile.botType,
          c,
          championModelRunId,
          challengerModelRunId: championChallenger.challengerModelRunId,
          championScore: championChallenger.championScore,
          challengerScore: championChallenger.challengerScore,
          scoreDelta: championChallenger.scoreDelta,
          ...traceAdmissionFields,
          minScore: effectiveMinScore,
          explorationMinScore: explorationEnabledForBot ? explorationMinScore : null,
          thresholdEligible: paperTraceThresholdEligible(admissionScore, effectiveMinScore),
          explorationEligible: explorationEnabledForBot && explorationBandBelowMinScore > 0,
          explorationUsed: explorationAdmissionMode === "exploration",
          budgetLimited: false,
          cooldownLimited: false,
          dedupeLimited: false,
          capsLimited: false,
          finalDisposition: "rejected",
          rejectReasonCode: code,
        }));
        incReject(agg, code);
        skippedForBot++;
        if (liqBot.reason === "spread") {
          botRejectedSpread++;
          totalRejectedBySpreadGuard++;
        } else {
          botRejectedSlip++;
          totalRejectedBySlippageGuard++;
        }
        continue;
      }

      const maxOpenTotal = profile.maxOpenTotal ?? config.maxOpenTotal;
      if (maxOpenTotal > 0 && openCountTotal + openedForBot >= maxOpenTotal) {
        allTraces.push(buildTraceEntry({
          botType: profile.botType,
          c,
          championModelRunId,
          challengerModelRunId: championChallenger.challengerModelRunId,
          championScore: championChallenger.championScore,
          challengerScore: championChallenger.challengerScore,
          scoreDelta: championChallenger.scoreDelta,
          ...traceAdmissionFields,
          minScore: effectiveMinScore,
          explorationMinScore: explorationEnabledForBot ? explorationMinScore : null,
          thresholdEligible: paperTraceThresholdEligible(admissionScore, effectiveMinScore),
          explorationEligible: explorationEnabledForBot && explorationBandBelowMinScore > 0,
          explorationUsed: explorationAdmissionMode === "exploration",
          budgetLimited: false,
          cooldownLimited: false,
          dedupeLimited: false,
          capsLimited: true,
          finalDisposition: "rejected",
          rejectReasonCode: "max_open_total",
        }));
        incReject(agg, "max_open_total");
        rejectedByRiskLimitCount++;
        skippedForBot++;
        continue;
      }
      const maxDailyFromConfig =
        profile.maxDailyNewTrades ?? config.maxDailyNewTrades;
      const budgetCap = decision?.maxNewTradesToday ?? maxDailyFromConfig;
      const maxDailyNewTrades =
        budgetAllocatorEnabled && budgetCap > 0
          ? Math.min(maxDailyFromConfig || budgetCap, budgetCap)
          : maxDailyFromConfig;
      if (maxDailyNewTrades > 0 && createdToday + openedForBot >= maxDailyNewTrades) {
        let rejectedByBudgetThisCandidate = false;
        if (
          budgetAllocatorEnabled &&
          decision &&
          budgetCap > 0 &&
          maxDailyFromConfig > 0 &&
          budgetCap < maxDailyFromConfig
        ) {
          rejectedByBudgetThisCandidate = true;
        }

        const originalBotKey = profile.botType;
        const overflowTriedBotKeys: string[] = [];
        let overflowOpenedThisCandidate = false;
        let lastOverflowTerminal: PaperDecisionRejectReasonCode = "budget_cap";

        for (let j = profileIndex + 1; j < profiles.length; j++) {
          const altProfile = profiles[j];
          if (
            filterShadowCandidatesForProfile([c], altProfile as EffectiveBotProfile).length === 0
          ) {
            continue;
          }
          overflowTriedBotKeys.push(altProfile.botType);
          const targetAggAlt = tracePerBotAggregates[altProfile.botType]!;

          const altProfileThreshold = altProfile.threshold;
          const altBaseMinScore = altProfileThreshold + altProfile.minScoreBuffer;
          const altRoiMinProfile = computeEffectivePaperMinScore({
            baseMinScore: altBaseMinScore,
            globalOverride: config.paperMinScoreOverrideGlobal,
            botOverride: readPaperBotMinScoreOverrideEnv(altProfile.botType),
          });
          const altEffectiveMinScore = altRoiMinProfile.effectiveMinScore;

          const altExplorationEnabledForBot =
            explorationAllocatorEnabled && altProfile.explorationEnabled === true;
          const altExplorationBandBelowMinScore =
            altProfile.explorationBandBelowMinScore > 0
              ? altProfile.explorationBandBelowMinScore
              : 0;
          const altExplorationMinScore =
            altExplorationBandBelowMinScore > 0
              ? Math.max(altEffectiveMinScore - altExplorationBandBelowMinScore, 0)
              : 0;
          const altExplorationMaxPerTick =
            altProfile.explorationMaxPerTick && altProfile.explorationMaxPerTick > 0
              ? altProfile.explorationMaxPerTick
              : 0;
          const altExplorationMaxPerDay =
            altProfile.explorationMaxPerDay && altProfile.explorationMaxPerDay > 0
              ? altProfile.explorationMaxPerDay
              : 0;

          let altExplorationCreatedToday = 0;
          if (altExplorationEnabledForBot && altExplorationMaxPerDay > 0) {
            altExplorationCreatedToday = await prisma.paperTrade.count({
              where: {
                createdAt: { gte: todayStart },
                botType: altProfile.botType,
                explorationAdmissionMode: "exploration",
              },
            });
          }

          const altExplorationOpenedEffective =
            paperExplorationOpensByBot[altProfile.botType] ?? 0;

          const altScoreRes = paperAdmissionExplorationResolveForDailyCapOverflow({
            admissionScore,
            effectiveMinScore: altEffectiveMinScore,
            explorationEnabledForBot: altExplorationEnabledForBot,
            explorationBandBelowMinScore: altExplorationBandBelowMinScore,
            explorationMinScore: altExplorationMinScore,
            explorationMaxPerTick: altExplorationMaxPerTick,
            explorationMaxPerDay: altExplorationMaxPerDay,
            explorationOpenedForBot: altExplorationOpenedEffective,
            explorationCreatedToday: altExplorationCreatedToday,
          });
          if (!altScoreRes.ok) {
            lastOverflowTerminal = altScoreRes.reject;
            continue;
          }
          const altExplorationAdmissionMode = altScoreRes.mode;

          const execCtxAlt = buildExecutionContextFromShadowInput(c.shadowInput);
          const liqAlt = evaluatePaperLiquidityGuards(
            execCtxAlt.spreadBps,
            execCtxAlt.estimatedSlippageBps,
            config.paperMaxSpreadBps,
            config.paperMaxEstimatedSlippageBps
          );
          if (!liqAlt.ok) {
            const liqCode: PaperDecisionRejectReasonCode =
              liqAlt.reason === "spread" ? "spread_guard" : "slippage_guard";
            lastOverflowTerminal = liqCode;
            if (liqAlt.reason === "spread") totalRejectedBySpreadGuard++;
            else totalRejectedBySlippageGuard++;
            continue;
          }

          const altOpenCountTotal = await prisma.paperTrade.count({
            where: { status: "open", botType: altProfile.botType },
          });
          const altOpenedThisTick = paperInTickOpensByBot[altProfile.botType] ?? 0;
          const altMaxOpenTotal = altProfile.maxOpenTotal ?? config.maxOpenTotal;
          if (altMaxOpenTotal > 0 && altOpenCountTotal + altOpenedThisTick >= altMaxOpenTotal) {
            lastOverflowTerminal = "max_open_total";
            continue;
          }

          const altCreatedTodayCount = await prisma.paperTrade.count({
            where: { createdAt: { gte: todayStart }, botType: altProfile.botType },
          });
          const altMaxDailyFromConfig =
            altProfile.maxDailyNewTrades ?? config.maxDailyNewTrades;
          const altDecision = budgetDecisionsByBot[altProfile.botType];
          const altBudgetCap = altDecision?.maxNewTradesToday ?? altMaxDailyFromConfig;
          const altMaxDailyNewTrades =
            budgetAllocatorEnabled && altBudgetCap > 0
              ? Math.min(altMaxDailyFromConfig || altBudgetCap, altBudgetCap)
              : altMaxDailyFromConfig;
          if (
            altMaxDailyNewTrades > 0 &&
            altCreatedTodayCount + altOpenedThisTick >= altMaxDailyNewTrades
          ) {
            lastOverflowTerminal = "budget_cap";
            continue;
          }

          const altCooldownHours = altProfile.cooldownHours ?? config.cooldownHours;
          if (await hasOpenOrRecentPaperTrade(altProfile.botType, c.assetId, altCooldownHours)) {
            lastOverflowTerminal = "cooldown_asset";
            continue;
          }

          const altCooldownMarketHours =
            altProfile.cooldownMarketHours ?? config.cooldownMarketHours;
          if (
            await hasOpenOrRecentPaperTradeForMarket(
              altProfile.botType,
              c.marketId,
              altCooldownMarketHours
            )
          ) {
            lastOverflowTerminal = "cooldown_market";
            continue;
          }

          const altMaxOpenPerMarket =
            altProfile.maxOpenPerMarket ?? config.maxOpenPerMarket;
          if (altMaxOpenPerMarket > 0) {
            const openInMarket = await prisma.paperTrade.count({
              where: { marketId: c.marketId, botType: altProfile.botType, status: "open" },
            });
            if (openInMarket >= altMaxOpenPerMarket) {
              lastOverflowTerminal = "max_open_per_market";
              continue;
            }
          }

          const themeKeyAlt = c.theme ?? "__none__";
          const altMaxOpenPerTheme =
            altProfile.maxOpenPerTheme ?? config.maxOpenPerTheme;
          if (altMaxOpenPerTheme > 0 && themeKeyAlt !== "__none__") {
            const openInTheme = await prisma.paperTrade.count({
              where: { theme: themeKeyAlt, botType: altProfile.botType, status: "open" },
            });
            if (openInTheme >= altMaxOpenPerTheme) {
              lastOverflowTerminal = "max_open_per_theme";
              continue;
            }
          }

          const categoryKeyAlt = c.category ?? "__none__";
          const altMaxOpenPerCategory =
            altProfile.maxOpenPerCategory ?? config.maxOpenPerCategory;
          if (altMaxOpenPerCategory > 0 && categoryKeyAlt !== "__none__") {
            const openInCategory = await prisma.paperTrade.count({
              where: {
                category: categoryKeyAlt,
                botType: altProfile.botType,
                status: "open",
              },
            });
            if (openInCategory >= altMaxOpenPerCategory) {
              lastOverflowTerminal = "max_open_per_category";
              continue;
            }
          }

          const altDedupeKey = buildDedupeKey(
            active.run.id,
            altProfile.botType,
            c.assetId,
            c.side,
            altCooldownHours
          );
          const altExisting = await prisma.paperTrade.findUnique({
            where: { dedupeKey: altDedupeKey },
          });
          if (altExisting) {
            lastOverflowTerminal = "dedupe";
            continue;
          }

          if (await hasOpenPaperTradeForMarketAndSide(altProfile.botType, c.marketId, c.side)) {
            lastOverflowTerminal = "dedupe";
            continue;
          }

          const fromRelaxationOverflow = c.paperPolicyMode === "relaxed_block_candidate";
          if (fromRelaxationOverflow) paperTradesCreatedFromRelaxationCount++;

          const altCreatedTodayRelaxedConcentration = await prisma.paperTrade.count({
            where: {
              createdAt: { gte: todayStart },
              botType: altProfile.botType,
              paperRelaxationReason: "concentration_high",
            },
          });
          const altRelaxedOpenedThisTick =
            paperRelaxedConcOpenedByBot[altProfile.botType] ?? 0;

          if (c.paperRelaxationReason === "concentration_high") {
            const perTickCap = config.relaxedConcentrationMaxPerTick;
            const perDayCap = config.relaxedConcentrationMaxPerDay;
            const perMarketCap = config.relaxedConcentrationMaxOpenPerMarket;
            const perThemeCap = config.relaxedConcentrationMaxOpenPerTheme;
            const exceedsTick =
              perTickCap > 0 && altRelaxedOpenedThisTick >= perTickCap;
            const exceedsDay =
              perDayCap > 0 &&
              altCreatedTodayRelaxedConcentration + altRelaxedOpenedThisTick >= perDayCap;
            let exceedsMarket = false;
            if (perMarketCap > 0) {
              const openConcentrationInMarket = await prisma.paperTrade.count({
                where: {
                  marketId: c.marketId,
                  botType: altProfile.botType,
                  status: "open",
                  paperRelaxationReason: "concentration_high",
                },
              });
              exceedsMarket = openConcentrationInMarket >= perMarketCap;
            }
            let exceedsTheme = false;
            if (perThemeCap > 0 && themeKeyAlt !== "__none__") {
              const openConcentrationInTheme = await prisma.paperTrade.count({
                where: {
                  theme: themeKeyAlt,
                  botType: altProfile.botType,
                  status: "open",
                  paperRelaxationReason: "concentration_high",
                },
              });
              exceedsTheme = openConcentrationInTheme >= perThemeCap;
            }
            if (exceedsTick || exceedsDay || exceedsMarket || exceedsTheme) {
              lastOverflowTerminal = "max_open_total";
              continue;
            }
          }

          const finalExplorationAdmissionModeAlt: "threshold" | "exploration" =
            altExplorationAdmissionMode ?? "threshold";

          if (altExplorationAdmissionMode === "exploration") {
            targetAggAlt.explorationEligible++;
            targetAggAlt.explorationUsed++;
          }

          try {
            const altEntryPriceBand = classifyEntryPriceBand(parseEntryPrice(c.entryPrice));
            const altProfileSnapshot = JSON.stringify({
              botType: altProfile.botType,
              displayName: altProfile.displayName,
              targetLabel: altProfile.targetLabel ?? active.run.targetLabel,
              botVersion: altProfile.botVersion ?? null,
              threshold: altProfile.threshold,
              minScoreBuffer: altProfile.minScoreBuffer,
              cooldownHours: altProfile.cooldownHours,
              cooldownMarketHours: altProfile.cooldownMarketHours,
              maxOpenTotal: altProfile.maxOpenTotal,
              maxOpenPerMarket: altProfile.maxOpenPerMarket,
              maxOpenPerTheme: altProfile.maxOpenPerTheme,
              maxOpenPerCategory: altProfile.maxOpenPerCategory,
              maxDailyNewTrades: altProfile.maxDailyNewTrades,
              allowReviewRequired: altProfile.allowReviewRequired,
              allowPaperRelaxation: altProfile.allowPaperRelaxation,
              allowRelaxationReasons: altProfile.allowRelaxationReasons,
              allowedPolicyStates: altProfile.allowedPolicyStates,
              allowedPriceBands: altProfile.allowedPriceBands,
            });
            const altMinScoreUsedForAttribution =
              altExplorationAdmissionMode === "exploration"
                ? altExplorationMinScore
                : altEffectiveMinScore;
            const altSizingFloor =
              altExplorationAdmissionMode === "exploration"
                ? altExplorationMinScore
                : altEffectiveMinScore;
            const altSizeBucketMulti = config.paperSizeByScoreEnabled
              ? resolvePaperSizeBucket(admissionScore, altSizingFloor, config.paperSizeScoreTiers)
              : null;
            const altPaperMultMulti = altSizeBucketMulti?.multiplier ?? 1;
            const altSizeLabelMulti = altSizeBucketMulti?.label ?? "baseline";
            const altIntendedSizeMulti = config.paperSizeByScoreEnabled
              ? applyPaperIntendedSizeMultiplier(c.intendedSize, altPaperMultMulti)
              : c.intendedSize;
            void recordShadowCandidate({
              funderAddress: tickFunder,
              recommendationId: c.recommendationId,
              orderIntentId: null,
              assetId: c.assetId,
              marketId: c.marketId,
              side: c.side,
              intendedPrice: parseFloat(c.entryPrice),
              intendedSize: parseFloat(altIntendedSizeMulti),
              candidateSource: "paper_trading",
              wasBlocked: false,
              wasSubmitted: false,
            }).catch(() => {});
            const altPaperRoi: PaperRoiAdmissionMeta = {
              effectiveMinScoreUsed: altEffectiveMinScore,
              baseMinScoreBeforePaperOverride: altRoiMinProfile.baseMinScore,
              globalPaperMinScoreOverride: altRoiMinProfile.globalPaperMinScoreOverride,
              botPaperMinScoreOverride: altRoiMinProfile.botPaperMinScoreOverride,
              admittedUnderTightenedPaperThreshold:
                altExplorationAdmissionMode === "threshold" &&
                altRoiMinProfile.admittedUnderTightenedPaperThreshold,
              sizeByScoreEnabled: config.paperSizeByScoreEnabled,
              sizeScoreBucketLabel: altSizeLabelMulti,
              paperSizeMultiplier: altPaperMultMulti,
              spreadBpsAtAdmission: execCtxAlt.spreadBps,
              estimatedSlippageBpsAtAdmission: execCtxAlt.estimatedSlippageBps,
              blockedBySpreadGuard: false,
              blockedBySlippageGuard: false,
            };
            const altMultiBaseMetadata: Record<string, unknown> = {
              recommendationId: c.recommendationId,
              targetLabel: altProfile.targetLabel ?? active.run.targetLabel,
              botType: altProfile.botType,
              botDisplayName: altProfile.displayName,
              botVersion: altProfile.botVersion ?? null,
              ...(c.shadowCandidateId && { shadowCandidateId: c.shadowCandidateId }),
              exploration:
                finalExplorationAdmissionModeAlt === "exploration"
                  ? {
                      mode: explorationPolicyMode,
                      bandBelowMinScore: altExplorationBandBelowMinScore,
                      minScore: altEffectiveMinScore,
                    }
                  : undefined,
              ...(c.passedViaRelaxation &&
                c.relaxedBlockReason && {
                  paperOnlyRelaxation: true,
                  overriddenBlockReason: c.relaxedBlockReason,
                }),
              ...(c.derivationSource && { derivationSource: c.derivationSource }),
            };
            const altPaperShadowCal: PaperShadowScoreCalibrationMeta = {
              shadowMlScoreRaw: rawScore,
              shadowMlLogit: result.result.shadowMlLogit,
              shadowMlScoreCalibrated: result.result.shadowMlScoreCalibrated,
              logitTemperature: config.paperShadowLogitTemperature,
              usedCalibratedForAdmission: config.paperShadowUseCalibratedScoreForPaper,
              admissionScore,
            };
            const altOpenAttribution = buildPaperTradeOpenAttribution({
              shadowResult: result.result,
              thresholdUsed: altProfileThreshold,
              minScoreUsed: altMinScoreUsedForAttribution,
              shadowCandidateId: c.shadowCandidateId,
              shadowInput: c.shadowInput,
              paperRoiAdmission: altPaperRoi,
              paperShadowScoreCalibration: altPaperShadowCal,
            });
            await prisma.paperTrade.create({
              data: {
                dedupeKey: altDedupeKey,
                modelRunId: active.run.id,
                championModelRunId: championChallenger.championModelRunId,
                challengerModelRunId: championChallenger.challengerModelRunId,
                marketId: c.marketId,
                assetId: c.assetId,
                theme: c.theme,
                category: c.category,
                funderAddress: tickFunder,
                side: c.side,
                score: rawScore,
                championScore: championChallenger.championScore,
                challengerScore: championChallenger.challengerScore,
                challengerScoreDelta: championChallenger.scoreDelta,
                challengerAvailable: championChallenger.challengerAvailable,
                threshold: altProfileThreshold,
                entryPrice: c.entryPrice,
                entryTime: now,
                intendedSize: altIntendedSizeMulti,
                status: "open",
                explorationAdmissionMode: altExplorationAdmissionMode,
                metadataJson: JSON.stringify(
                  mergeOpenAttributionIntoMetadata(altMultiBaseMetadata, altOpenAttribution)
                ),
                sourceDecisionState: c.sourceDecisionState ?? null,
                paperPolicyMode: c.paperPolicyMode ?? null,
                paperRelaxationReason: c.paperRelaxationReason ?? null,
                originalBlockingReasons: prismaJsonStringArray(c.originalBlockingReasons),
                paperEligibilityVersion: c.paperEligibilityVersion ?? null,
                botType: altProfile.botType,
                botVersion: altProfile.botVersion ?? null,
                targetLabel: altProfile.targetLabel ?? active.run.targetLabel,
                entryPriceBand: altEntryPriceBand,
                profileSnapshotJson: altProfileSnapshot,
              },
            });

            const nextAltOpens = altOpenedThisTick + 1;
            paperInTickOpensByBot[altProfile.botType] = nextAltOpens;
            if (finalExplorationAdmissionModeAlt === "exploration") {
              paperExplorationOpensByBot[altProfile.botType] =
                (paperExplorationOpensByBot[altProfile.botType] ?? 0) + 1;
            }
            if (c.paperRelaxationReason === "concentration_high") {
              paperRelaxedConcOpenedByBot[altProfile.botType] =
                (paperRelaxedConcOpenedByBot[altProfile.botType] ?? 0) + 1;
            }

            targetAggAlt.admitted++;

            allTraces.push(
              buildTraceEntry({
                botType: altProfile.botType,
                c,
                championModelRunId,
                challengerModelRunId: championChallenger.challengerModelRunId,
                championScore: championChallenger.championScore,
                challengerScore: championChallenger.challengerScore,
                scoreDelta: championChallenger.scoreDelta,
                ...traceAdmissionFields,
                minScore: altEffectiveMinScore,
                explorationMinScore: altExplorationEnabledForBot ? altExplorationMinScore : null,
                thresholdEligible: paperTraceThresholdEligible(
                  admissionScore,
                  altEffectiveMinScore
                ),
                explorationEligible:
                  altExplorationEnabledForBot && altExplorationBandBelowMinScore > 0,
                explorationUsed: finalExplorationAdmissionModeAlt === "exploration",
                budgetLimited: false,
                cooldownLimited: false,
                dedupeLimited: false,
                capsLimited: false,
                finalDisposition: "admitted",
                dedupeKey: altDedupeKey,
                originalBotKey,
                finalBotKey: altProfile.botType,
                overflowAttempted: true,
                overflowTriedBotKeys: [...overflowTriedBotKeys],
                overflowSucceeded: true,
                overflowTerminalReason: null,
              })
            );
            console.log(
              `[paper-trading] Opened paper trade (daily-cap overflow) botType=${altProfile.botType} assetId=${c.assetId} raw=${rawScore.toFixed(
                4
              )} admission=${admissionScore.toFixed(4)} threshold=${altProfileThreshold} fromBot=${originalBotKey}`
            );
            overflowOpenedThisCandidate = true;
            break;
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (msg.includes("Unique constraint") || msg.includes("dedupeKey")) {
              lastOverflowTerminal = "dedupe";
              continue;
            }
            errors.push(
              `Create paper trade failed botType=${altProfile.botType} assetId=${c.assetId}: ${msg}`
            );
            lastOverflowTerminal = "unknown_rejection";
          }
        }

        if (overflowOpenedThisCandidate) {
          continue;
        }

        if (rejectedByBudgetThisCandidate) rejectedByBudgetCount++;
        allTraces.push(
          buildTraceEntry({
            botType: profile.botType,
            c,
            championModelRunId,
            challengerModelRunId: championChallenger.challengerModelRunId,
            championScore: championChallenger.championScore,
            challengerScore: championChallenger.challengerScore,
            scoreDelta: championChallenger.scoreDelta,
            ...traceAdmissionFields,
            minScore: effectiveMinScore,
            explorationMinScore: explorationEnabledForBot ? explorationMinScore : null,
            thresholdEligible: paperTraceThresholdEligible(admissionScore, effectiveMinScore),
            explorationEligible: explorationEnabledForBot && explorationBandBelowMinScore > 0,
            explorationUsed: explorationAdmissionMode === "exploration",
            budgetLimited: true,
            cooldownLimited: false,
            dedupeLimited: false,
            capsLimited: false,
            finalDisposition: "rejected",
            rejectReasonCode: "budget_cap",
            originalBotKey,
            finalBotKey: profile.botType,
            overflowAttempted: true,
            overflowTriedBotKeys: [...overflowTriedBotKeys],
            overflowSucceeded: false,
            overflowTerminalReason: lastOverflowTerminal,
          })
        );
        incReject(agg, "budget_cap");
        rejectedByRiskLimitCount++;
        skippedForBot++;
        continue;
      }

      const cooldownHours = profile.cooldownHours ?? config.cooldownHours;
      if (await hasOpenOrRecentPaperTrade(profile.botType, c.assetId, cooldownHours)) {
        allTraces.push(buildTraceEntry({
          botType: profile.botType,
          c,
          championModelRunId,
          challengerModelRunId: championChallenger.challengerModelRunId,
          championScore: championChallenger.championScore,
          challengerScore: championChallenger.challengerScore,
          scoreDelta: championChallenger.scoreDelta,
          ...traceAdmissionFields,
          minScore: effectiveMinScore,
          explorationMinScore: explorationEnabledForBot ? explorationMinScore : null,
          thresholdEligible: paperTraceThresholdEligible(admissionScore, effectiveMinScore),
          explorationEligible: explorationEnabledForBot && explorationBandBelowMinScore > 0,
          explorationUsed: explorationAdmissionMode === "exploration",
          budgetLimited: false,
          cooldownLimited: true,
          dedupeLimited: false,
          capsLimited: false,
          finalDisposition: "rejected",
          rejectReasonCode: "cooldown_asset",
        }));
        incReject(agg, "cooldown_asset");
        rejectedByCooldownCount++;
        skippedForBot++;
        continue;
      }

      const cooldownMarketHours =
        profile.cooldownMarketHours ?? config.cooldownMarketHours;
      if (
        await hasOpenOrRecentPaperTradeForMarket(
          profile.botType,
          c.marketId,
          cooldownMarketHours
        )
      ) {
        allTraces.push(buildTraceEntry({
          botType: profile.botType,
          c,
          championModelRunId,
          challengerModelRunId: championChallenger.challengerModelRunId,
          championScore: championChallenger.championScore,
          challengerScore: championChallenger.challengerScore,
          scoreDelta: championChallenger.scoreDelta,
          ...traceAdmissionFields,
          minScore: effectiveMinScore,
          explorationMinScore: explorationEnabledForBot ? explorationMinScore : null,
          thresholdEligible: paperTraceThresholdEligible(admissionScore, effectiveMinScore),
          explorationEligible: explorationEnabledForBot && explorationBandBelowMinScore > 0,
          explorationUsed: explorationAdmissionMode === "exploration",
          budgetLimited: false,
          cooldownLimited: true,
          dedupeLimited: false,
          capsLimited: false,
          finalDisposition: "rejected",
          rejectReasonCode: "cooldown_market",
        }));
        incReject(agg, "cooldown_market");
        rejectedByCooldownCount++;
        skippedForBot++;
        continue;
      }

      const maxOpenPerMarket =
        profile.maxOpenPerMarket ?? config.maxOpenPerMarket;
      if (maxOpenPerMarket > 0) {
        const openInMarket = await prisma.paperTrade.count({
          where: { marketId: c.marketId, botType: profile.botType, status: "open" },
        });
        if (openInMarket >= maxOpenPerMarket) {
          allTraces.push(buildTraceEntry({
            botType: profile.botType,
            c,
            championModelRunId,
            challengerModelRunId: championChallenger.challengerModelRunId,
            championScore: championChallenger.championScore,
            challengerScore: championChallenger.challengerScore,
            scoreDelta: championChallenger.scoreDelta,
            ...traceAdmissionFields,
            minScore: effectiveMinScore,
            explorationMinScore: explorationEnabledForBot ? explorationMinScore : null,
            thresholdEligible: paperTraceThresholdEligible(admissionScore, effectiveMinScore),
            explorationEligible: explorationEnabledForBot && explorationBandBelowMinScore > 0,
            explorationUsed: explorationAdmissionMode === "exploration",
            budgetLimited: false,
            cooldownLimited: false,
            dedupeLimited: false,
            capsLimited: true,
            finalDisposition: "rejected",
            rejectReasonCode: "max_open_per_market",
          }));
          incReject(agg, "max_open_per_market");
          rejectedByRiskLimitCount++;
          skippedForBot++;
          continue;
        }
      }

      const themeKey = c.theme ?? "__none__";
      const maxOpenPerTheme =
        profile.maxOpenPerTheme ?? config.maxOpenPerTheme;
      if (maxOpenPerTheme > 0 && themeKey !== "__none__") {
        const openInTheme = await prisma.paperTrade.count({
          where: { theme: themeKey, botType: profile.botType, status: "open" },
        });
        if (openInTheme >= maxOpenPerTheme) {
          allTraces.push(buildTraceEntry({
            botType: profile.botType,
            c,
            championModelRunId,
            challengerModelRunId: championChallenger.challengerModelRunId,
            championScore: championChallenger.championScore,
            challengerScore: championChallenger.challengerScore,
            scoreDelta: championChallenger.scoreDelta,
            ...traceAdmissionFields,
            minScore: effectiveMinScore,
            explorationMinScore: explorationEnabledForBot ? explorationMinScore : null,
            thresholdEligible: paperTraceThresholdEligible(admissionScore, effectiveMinScore),
            explorationEligible: explorationEnabledForBot && explorationBandBelowMinScore > 0,
            explorationUsed: explorationAdmissionMode === "exploration",
            budgetLimited: false,
            cooldownLimited: false,
            dedupeLimited: false,
            capsLimited: true,
            finalDisposition: "rejected",
            rejectReasonCode: "max_open_per_theme",
          }));
          incReject(agg, "max_open_per_theme");
          rejectedByRiskLimitCount++;
          skippedForBot++;
          continue;
        }
      }

      const categoryKey = c.category ?? "__none__";
      const maxOpenPerCategory =
        profile.maxOpenPerCategory ?? config.maxOpenPerCategory;
      if (maxOpenPerCategory > 0 && categoryKey !== "__none__") {
        const openInCategory = await prisma.paperTrade.count({
          where: { category: categoryKey, botType: profile.botType, status: "open" },
        });
        if (openInCategory >= maxOpenPerCategory) {
          allTraces.push(buildTraceEntry({
            botType: profile.botType,
            c,
            championModelRunId,
            challengerModelRunId: championChallenger.challengerModelRunId,
            championScore: championChallenger.championScore,
            challengerScore: championChallenger.challengerScore,
            scoreDelta: championChallenger.scoreDelta,
            ...traceAdmissionFields,
            minScore: effectiveMinScore,
            explorationMinScore: explorationEnabledForBot ? explorationMinScore : null,
            thresholdEligible: paperTraceThresholdEligible(admissionScore, effectiveMinScore),
            explorationEligible: explorationEnabledForBot && explorationBandBelowMinScore > 0,
            explorationUsed: explorationAdmissionMode === "exploration",
            budgetLimited: false,
            cooldownLimited: false,
            dedupeLimited: false,
            capsLimited: true,
            finalDisposition: "rejected",
            rejectReasonCode: "max_open_per_category",
          }));
          incReject(agg, "max_open_per_category");
          rejectedByRiskLimitCount++;
          skippedForBot++;
          continue;
        }
      }

      const dedupeKey = buildDedupeKey(
        active.run.id,
        profile.botType,
        c.assetId,
        c.side,
        cooldownHours
      );
      const existing = await prisma.paperTrade.findUnique({ where: { dedupeKey } });
      if (existing) {
        allTraces.push(buildTraceEntry({
          botType: profile.botType,
          c,
          championModelRunId,
          challengerModelRunId: championChallenger.challengerModelRunId,
          championScore: championChallenger.championScore,
          challengerScore: championChallenger.challengerScore,
          scoreDelta: championChallenger.scoreDelta,
          ...traceAdmissionFields,
          minScore: effectiveMinScore,
          explorationMinScore: explorationEnabledForBot ? explorationMinScore : null,
          thresholdEligible: paperTraceThresholdEligible(admissionScore, effectiveMinScore),
          explorationEligible: explorationEnabledForBot && explorationBandBelowMinScore > 0,
          explorationUsed: explorationAdmissionMode === "exploration",
          budgetLimited: false,
          cooldownLimited: false,
          dedupeLimited: true,
          capsLimited: false,
          finalDisposition: "rejected",
          rejectReasonCode: "dedupe",
          dedupeKey,
        }));
        incReject(agg, "dedupe");
        rejectedByCooldownCount++;
        skippedForBot++;
        continue;
      }

      if (await hasOpenPaperTradeForMarketAndSide(profile.botType, c.marketId, c.side)) {
        allTraces.push(buildTraceEntry({
          botType: profile.botType,
          c,
          championModelRunId,
          challengerModelRunId: championChallenger.challengerModelRunId,
          championScore: championChallenger.championScore,
          challengerScore: championChallenger.challengerScore,
          scoreDelta: championChallenger.scoreDelta,
          ...traceAdmissionFields,
          minScore: effectiveMinScore,
          explorationMinScore: explorationEnabledForBot ? explorationMinScore : null,
          thresholdEligible: paperTraceThresholdEligible(admissionScore, effectiveMinScore),
          explorationEligible: explorationEnabledForBot && explorationBandBelowMinScore > 0,
          explorationUsed: explorationAdmissionMode === "exploration",
          budgetLimited: false,
          cooldownLimited: false,
          dedupeLimited: true,
          capsLimited: false,
          finalDisposition: "rejected",
          rejectReasonCode: "dedupe",
        }));
        incReject(agg, "dedupe");
        rejectedByCooldownCount++;
        skippedForBot++;
        continue;
      }

      const fromRelaxation = c.paperPolicyMode === "relaxed_block_candidate";
      if (fromRelaxation) paperTradesCreatedFromRelaxationCount++;
      if (c.paperRelaxationReason === "concentration_high") {
        const perTickCap = config.relaxedConcentrationMaxPerTick;
        const perDayCap = config.relaxedConcentrationMaxPerDay;
        const perMarketCap = config.relaxedConcentrationMaxOpenPerMarket;
        const perThemeCap = config.relaxedConcentrationMaxOpenPerTheme;
        const themeKey = c.theme ?? "__none__";
        const exceedsTick = perTickCap > 0 && relaxedDueToConcentrationOpenedCount >= perTickCap;
        const exceedsDay =
          perDayCap > 0 &&
          createdTodayRelaxedConcentration + relaxedDueToConcentrationOpenedCount >= perDayCap;
        let exceedsMarket = false;
        if (perMarketCap > 0) {
          const openConcentrationInMarket = await prisma.paperTrade.count({
            where: {
              marketId: c.marketId,
              botType: profile.botType,
              status: "open",
              paperRelaxationReason: "concentration_high",
            },
          });
          exceedsMarket = openConcentrationInMarket >= perMarketCap;
        }
        let exceedsTheme = false;
        if (perThemeCap > 0 && themeKey !== "__none__") {
          const openConcentrationInTheme = await prisma.paperTrade.count({
            where: {
              theme: themeKey,
              botType: profile.botType,
              status: "open",
              paperRelaxationReason: "concentration_high",
            },
          });
          exceedsTheme = openConcentrationInTheme >= perThemeCap;
        }
        if (exceedsTick || exceedsDay || exceedsMarket || exceedsTheme) {
          relaxedConcentrationRejectedByCap++;
          allTraces.push(buildTraceEntry({
            botType: profile.botType,
            c,
            championModelRunId,
            challengerModelRunId: championChallenger.challengerModelRunId,
            championScore: championChallenger.championScore,
            challengerScore: championChallenger.challengerScore,
            scoreDelta: championChallenger.scoreDelta,
            ...traceAdmissionFields,
            minScore: effectiveMinScore,
            explorationMinScore: explorationEnabledForBot ? explorationMinScore : null,
            thresholdEligible: paperTraceThresholdEligible(admissionScore, effectiveMinScore),
            explorationEligible: explorationEnabledForBot && explorationBandBelowMinScore > 0,
            explorationUsed: explorationAdmissionMode === "exploration",
            budgetLimited: false,
            cooldownLimited: false,
            dedupeLimited: false,
            capsLimited: true,
            finalDisposition: "rejected",
            rejectReasonCode: "max_open_total",
          }));
          incReject(agg, "max_open_total");
          skippedForBot++;
          continue;
        }
      }

      const entryPriceNum = parseEntryPrice(c.entryPrice);
      const entryPriceBand = classifyEntryPriceBand(entryPriceNum);

      // Provenance: actual admission path. Multi-bot path can admit via threshold or exploration (paper-only).
      const finalExplorationAdmissionMode: "threshold" | "exploration" =
        explorationAdmissionMode ?? "threshold";

      try {
        const profileSnapshot = JSON.stringify({
          botType: profile.botType,
          displayName: profile.displayName,
          targetLabel: profile.targetLabel ?? active.run.targetLabel,
          botVersion: profile.botVersion ?? null,
          threshold: profile.threshold,
          minScoreBuffer: profile.minScoreBuffer,
          cooldownHours: profile.cooldownHours,
          cooldownMarketHours: profile.cooldownMarketHours,
          maxOpenTotal: profile.maxOpenTotal,
          maxOpenPerMarket: profile.maxOpenPerMarket,
          maxOpenPerTheme: profile.maxOpenPerTheme,
          maxOpenPerCategory: profile.maxOpenPerCategory,
          maxDailyNewTrades: profile.maxDailyNewTrades,
          allowReviewRequired: profile.allowReviewRequired,
          allowPaperRelaxation: profile.allowPaperRelaxation,
          allowRelaxationReasons: profile.allowRelaxationReasons,
          allowedPolicyStates: profile.allowedPolicyStates,
          allowedPriceBands: profile.allowedPriceBands,
        });
        const minScoreUsedForAttribution =
          explorationAdmissionMode === "exploration" ? explorationMinScore : effectiveMinScore;
        const sizingFloorMulti =
          explorationAdmissionMode === "exploration" ? explorationMinScore : effectiveMinScore;
        const sizeBucketMulti = config.paperSizeByScoreEnabled
          ? resolvePaperSizeBucket(admissionScore, sizingFloorMulti, config.paperSizeScoreTiers)
          : null;
        const paperMultMulti = sizeBucketMulti?.multiplier ?? 1;
        const sizeLabelMulti = sizeBucketMulti?.label ?? "baseline";
        const intendedSizeMulti = config.paperSizeByScoreEnabled
          ? applyPaperIntendedSizeMultiplier(c.intendedSize, paperMultMulti)
          : c.intendedSize;
        // Paper-only telemetry: record a ShadowCandidate row so labels can be joined to PaperTrade via (recommendationId, assetId, side).
        void recordShadowCandidate({
          funderAddress: tickFunder,
          recommendationId: c.recommendationId,
          orderIntentId: null,
          assetId: c.assetId,
          marketId: c.marketId,
          side: c.side,
          intendedPrice: parseFloat(c.entryPrice),
          intendedSize: parseFloat(intendedSizeMulti),
          candidateSource: "paper_trading",
          wasBlocked: false,
          wasSubmitted: false,
        }).catch(() => {});
        const paperRoiMulti: PaperRoiAdmissionMeta = {
          effectiveMinScoreUsed: effectiveMinScore,
          baseMinScoreBeforePaperOverride: roiMinProfile.baseMinScore,
          globalPaperMinScoreOverride: roiMinProfile.globalPaperMinScoreOverride,
          botPaperMinScoreOverride: roiMinProfile.botPaperMinScoreOverride,
          admittedUnderTightenedPaperThreshold:
            explorationAdmissionMode === "threshold" &&
            roiMinProfile.admittedUnderTightenedPaperThreshold,
          sizeByScoreEnabled: config.paperSizeByScoreEnabled,
          sizeScoreBucketLabel: sizeLabelMulti,
          paperSizeMultiplier: paperMultMulti,
          spreadBpsAtAdmission: execCtxBot.spreadBps,
          estimatedSlippageBpsAtAdmission: execCtxBot.estimatedSlippageBps,
          blockedBySpreadGuard: false,
          blockedBySlippageGuard: false,
        };
        const multiBaseMetadata: Record<string, unknown> = {
          recommendationId: c.recommendationId,
          targetLabel: profile.targetLabel ?? active.run.targetLabel,
          botType: profile.botType,
          botDisplayName: profile.displayName,
          botVersion: profile.botVersion ?? null,
          ...(c.shadowCandidateId && { shadowCandidateId: c.shadowCandidateId }),
          exploration:
            finalExplorationAdmissionMode === "exploration"
              ? {
                  mode: explorationPolicyMode,
                  bandBelowMinScore: explorationBandBelowMinScore,
                  minScore: effectiveMinScore,
                }
              : undefined,
          ...(c.passedViaRelaxation &&
            c.relaxedBlockReason && {
              paperOnlyRelaxation: true,
              overriddenBlockReason: c.relaxedBlockReason,
            }),
          ...(c.derivationSource && { derivationSource: c.derivationSource }),
        };
        const paperShadowCalMulti: PaperShadowScoreCalibrationMeta = {
          shadowMlScoreRaw: rawScore,
          shadowMlLogit: result.result.shadowMlLogit,
          shadowMlScoreCalibrated: result.result.shadowMlScoreCalibrated,
          logitTemperature: config.paperShadowLogitTemperature,
          usedCalibratedForAdmission: config.paperShadowUseCalibratedScoreForPaper,
          admissionScore,
        };
        const multiOpenAttribution = buildPaperTradeOpenAttribution({
          shadowResult: result.result,
          thresholdUsed: profileThreshold,
          minScoreUsed: minScoreUsedForAttribution,
          shadowCandidateId: c.shadowCandidateId,
          shadowInput: c.shadowInput,
          paperRoiAdmission: paperRoiMulti,
          paperShadowScoreCalibration: paperShadowCalMulti,
        });
        await prisma.paperTrade.create({
          data: {
            dedupeKey,
            modelRunId: active.run.id,
            championModelRunId: championChallenger.championModelRunId,
            challengerModelRunId: championChallenger.challengerModelRunId,
            marketId: c.marketId,
            assetId: c.assetId,
            theme: c.theme,
            category: c.category,
            funderAddress: tickFunder,
            side: c.side,
            score: rawScore,
            championScore: championChallenger.championScore,
            challengerScore: championChallenger.challengerScore,
            challengerScoreDelta: championChallenger.scoreDelta,
            challengerAvailable: championChallenger.challengerAvailable,
            threshold: profileThreshold,
            entryPrice: c.entryPrice,
            entryTime: now,
            intendedSize: intendedSizeMulti,
            status: "open",
            explorationAdmissionMode,
            metadataJson: JSON.stringify(
              mergeOpenAttributionIntoMetadata(multiBaseMetadata, multiOpenAttribution)
            ),
            sourceDecisionState: c.sourceDecisionState ?? null,
            paperPolicyMode: c.paperPolicyMode ?? null,
            paperRelaxationReason: c.paperRelaxationReason ?? null,
            originalBlockingReasons: prismaJsonStringArray(c.originalBlockingReasons),
            paperEligibilityVersion: c.paperEligibilityVersion ?? null,
            botType: profile.botType,
            botVersion: profile.botVersion ?? null,
            targetLabel: profile.targetLabel ?? active.run.targetLabel,
            entryPriceBand,
            profileSnapshotJson: profileSnapshot,
          },
        });
        openedForBot++;
        paperInTickOpensByBot[profile.botType] = openedForBot;
        agg.admitted++;
        if (c.paperRelaxationReason === "concentration_high") {
          relaxedDueToConcentrationOpenedCount++;
          paperRelaxedConcOpenedByBot[profile.botType] = relaxedDueToConcentrationOpenedCount;
        }
        if (finalExplorationAdmissionMode === "exploration") {
          explorationOpenedForBot++;
          paperExplorationOpensByBot[profile.botType] = explorationOpenedForBot;
        }
        allTraces.push(buildTraceEntry({
          botType: profile.botType,
          c,
          championModelRunId: championChallenger.championModelRunId,
          challengerModelRunId: championChallenger.challengerModelRunId,
          championScore: championChallenger.championScore,
          challengerScore: championChallenger.challengerScore,
          scoreDelta: championChallenger.scoreDelta,
          ...traceAdmissionFields,
          minScore: effectiveMinScore,
          explorationMinScore: explorationEnabledForBot ? explorationMinScore : null,
          thresholdEligible: paperTraceThresholdEligible(admissionScore, effectiveMinScore),
          explorationEligible: explorationEnabledForBot && explorationBandBelowMinScore > 0,
          explorationUsed: finalExplorationAdmissionMode === "exploration",
          budgetLimited: false,
          cooldownLimited: false,
          dedupeLimited: false,
          capsLimited: false,
          finalDisposition: "admitted",
          dedupeKey,
        }));
        console.log(
          `[paper-trading] Opened paper trade botType=${profile.botType} assetId=${c.assetId} raw=${rawScore.toFixed(
            4
          )} admission=${admissionScore.toFixed(4)} threshold=${profileThreshold}`
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("Unique constraint") || msg.includes("dedupeKey")) {
          allTraces.push(buildTraceEntry({
            botType: profile.botType,
            c,
            championModelRunId: championChallenger.championModelRunId,
            challengerModelRunId: championChallenger.challengerModelRunId,
            championScore: championChallenger.championScore,
            challengerScore: championChallenger.challengerScore,
            scoreDelta: championChallenger.scoreDelta,
            ...traceAdmissionFields,
            minScore: effectiveMinScore,
            explorationMinScore: explorationEnabledForBot ? explorationMinScore : null,
            thresholdEligible: paperTraceThresholdEligible(admissionScore, effectiveMinScore),
            explorationEligible: explorationEnabledForBot && explorationBandBelowMinScore > 0,
            explorationUsed: explorationAdmissionMode === "exploration",
            budgetLimited: false,
            cooldownLimited: false,
            dedupeLimited: true,
            capsLimited: false,
            finalDisposition: "rejected",
            rejectReasonCode: "dedupe",
            dedupeKey,
          }));
          incReject(agg, "dedupe");
          skippedForBot++;
          continue;
        }
        errors.push(
          `Create paper trade failed botType=${profile.botType} assetId=${c.assetId}: ${msg}`
        );
      }
    }

    const scores = scored.map((s) => s.score);
    const maxScore = scores.length > 0 ? Math.max(...scores) : null;
    const avgScore =
      scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null;

    const constrainedByBudget =
      budgetAllocatorEnabled && decision
        ? rejectedByBudgetCount > 0 ||
          (decision.maxNewTradesToday > 0 &&
            createdTodayBeforeTick >= decision.maxNewTradesToday)
        : false;

    perBotResults[profile.botType] = {
      botType: profile.botType,
      displayName: profile.displayName,
      opened: openedForBot,
      skipped: skippedForBot,
      candidatesLoaded: candidates.length,
      candidatesScored: scored.length,
      maxScore,
      avgScore,
      aboveThresholdCount,
      rejectedByCooldownCount,
      rejectedByRiskLimitCount,
      rejectedBySpreadGuardCount: botRejectedSpread || undefined,
      rejectedBySlippageGuardCount: botRejectedSlip || undefined,
      scoredAfterRelaxation: scoredAfterRelaxationCount,
      paperTradesCreatedFromRelaxation: paperTradesCreatedFromRelaxationCount,
      relaxedDueToConcentrationScored: relaxedDueToConcentrationScoredCount,
      relaxedDueToConcentrationOpened: relaxedDueToConcentrationOpenedCount,
      rejectedByBudgetCount: rejectedByBudgetCount || undefined,
      budgetDecision:
        budgetAllocatorEnabled && decision
          ? {
              ...decision,
              createdTodayBeforeTick,
              openedThisTick: openedForBot,
              constrainedByBudget,
            }
          : undefined,
      loadDiagnostics: {
        ...loadDiagnostics,
        relaxedConcentrationRejectedByCap,
        relaxedConcentrationStakeUsed: String(config.relaxedConcentrationStakeNotional),
      },
    };

    if (budgetAllocatorEnabled && decision) {
      botBudgetsApplied[profile.botType] = {
        ...decision,
        createdTodayBeforeTick,
        openedThisTick: openedForBot,
        constrainedByBudget,
      };
    }

    totalOpened += openedForBot;
    totalSkipped += skippedForBot;
    totalCandidatesLoaded += candidates.length;
    totalCandidatesScored += scored.length;
    totalAboveThresholdCount += aboveThresholdCount;
    totalRejectedByCooldownCount += rejectedByCooldownCount;
    totalRejectedByRiskLimitCount += rejectedByRiskLimitCount;
    totalScoredAfterRelaxationCount += scoredAfterRelaxationCount;
    totalPaperTradesCreatedFromRelaxationCount += paperTradesCreatedFromRelaxationCount;
    totalRelaxedDueToConcentrationScored += relaxedDueToConcentrationScoredCount;
    totalRelaxedDueToConcentrationOpened += relaxedDueToConcentrationOpenedCount;
  }

  const scores = allScored.map((s) => s.score);
  const maxScore = scores.length > 0 ? Math.max(...scores) : null;
  const avgScore =
    scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
  const topCandidateScores = [...allScored]
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_CANDIDATES_SAMPLE_SIZE)
    .map((s) => ({
      assetId: s.assetId.slice(0, 12) + (s.assetId.length > 12 ? "…" : ""),
      side: s.side,
      score: s.score,
    }));

  const tickResult: PaperTradingTickResult = {
    opened: totalOpened,
    skipped: totalSkipped,
    errors,
    lastScoringTime: now.toISOString(),
    modelRunId: active.run.id,
    threshold: config.threshold,
    enabled: true,
    candidatesLoaded: totalCandidatesLoaded,
    candidatesScored: totalCandidatesScored,
    maxScore,
    avgScore,
    aboveThresholdCount: totalAboveThresholdCount,
    rejectedByCooldownCount: totalRejectedByCooldownCount,
    rejectedByRiskLimitCount: totalRejectedByRiskLimitCount,
    rejectedBySpreadGuardCount: totalRejectedBySpreadGuard,
    rejectedBySlippageGuardCount: totalRejectedBySlippageGuard,
    topCandidateScores,
    scoredAfterRelaxation: totalScoredAfterRelaxationCount,
    paperTradesCreatedFromRelaxation: totalPaperTradesCreatedFromRelaxationCount,
    relaxedScoredSuccessfully: totalScoredAfterRelaxationCount,
    relaxedOpenedTrades: totalPaperTradesCreatedFromRelaxationCount,
    relaxedDueToConcentrationScored: totalRelaxedDueToConcentrationScored,
    relaxedDueToConcentrationOpened: totalRelaxedDueToConcentrationOpened,
    funderUsedForCandidateLoad: tickFunder,
    shadowCandidateIds: Array.from(shadowTickIdsAggregate),
    paperRoiAdmissionConfig: {
      paperMinScoreOverrideGlobal: config.paperMinScoreOverrideGlobal,
      paperSizeByScoreEnabled: config.paperSizeByScoreEnabled,
      paperMaxSpreadBps: config.paperMaxSpreadBps,
      paperMaxEstimatedSlippageBps: config.paperMaxEstimatedSlippageBps,
    },
    tickProof: {
      candidatesLoaded: totalCandidatesLoaded,
      candidateIdsSample: (globalShadowDiagnostics.candidateIds ?? []).slice(0, 12),
      candidatesScored: totalCandidatesScored,
      aboveThresholdCount: totalAboveThresholdCount,
      opened: totalOpened,
      preferredFunderTried: globalShadowDiagnostics.preferredFunderTried ?? preferredFunder,
      funderUsedForLoad: tickFunder,
      usedFunderFallback: globalShadowDiagnostics.usedFunderFallback ?? false,
      extendedLookbackTriedMinutes: globalShadowDiagnostics.extendedLookbackTriedMinutes ?? null,
      shadowRowsQueried: globalShadowDiagnostics.shadowRowsQueried,
    },
    perBotResults,
    botBudgets: budgetAllocatorEnabled ? botBudgetsApplied : undefined,
    decisionTraceBundle: {
      generatedAt: now.toISOString(),
      maxTracesStored: MAX_DECISION_TRACES_STORED,
      totalCandidatesConsidered: totalCandidatesLoaded,
      perBotAggregates: Object.values(tracePerBotAggregates),
      traces: allTraces.slice(-MAX_DECISION_TRACES_STORED),
    },
  };
  console.info("[paper-trading] tick shadow bridge proof", tickResult.tickProof);
  await persistOpenTickState(now, tickResult, errors.length > 0 ? errors[errors.length - 1] : null);
  return tickResult;
}

async function persistOpenTickState(
  at: Date | null,
  result: { opened: number; skipped: number; errors: string[] },
  error: string | null
): Promise<void> {
  try {
    await prisma.paperTradingState.upsert({
      where: { id: STATE_ID },
      create: {
        id: STATE_ID,
        lastOpenTickAt: at,
        lastOpenTickResultJson: JSON.stringify(result),
        lastOpenTickError: error,
        updatedAt: new Date(),
      },
      update: {
        lastOpenTickAt: at,
        lastOpenTickResultJson: JSON.stringify(result),
        lastOpenTickError: error,
        updatedAt: new Date(),
      },
    });
  } catch (e) {
    console.error("[paper-trading] Failed to persist open tick state", e);
  }
}

export interface ClosePaperTradesAt12hResult {
  runAt: string;
  horizonMs: number;
  openTotalCount: number;
  dueCount: number;
  closed: number;
  closedWithMarkout: number;
  closedWithoutMarkout: number;
  errors: string[];
  /** First few errors for quick UI / logs */
  errorSample: string[];
  closeReasonCounts: Record<string, number>;
  /** Full error count when `errors` stored in DB is truncated */
  errorsTotal?: number;
  errorsTruncated?: boolean;
}

/**
 * Close paper trades that have passed the 12h horizon. Compute markout and PnL from MarketPriceSnapshot.
 * Resolves snapshot `marketId` the same way as shadow evaluation (id vs conditionId). Always transitions
 * open → closed when due; missing snapshots yield closed rows without markout (see metadata paperClose).
 * Persists last close result to PaperTradingState.
 */
export async function closePaperTradesAt12h(): Promise<ClosePaperTradesAt12hResult> {
  const now = new Date();
  const horizonMs = PAPER_CLOSE_HORIZON_MS;
  const horizonEnd = paperCloseDueBefore(now, horizonMs);
  const errors: string[] = [];
  const closeReasonCounts: Record<string, number> = {};

  let openTotalCount = 0;
  try {
    openTotalCount = await prisma.paperTrade.count({ where: { status: "open" } });
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }

  const openTrades = await prisma.paperTrade.findMany({
    where: { status: "open", entryTime: { lte: horizonEnd } },
    orderBy: { entryTime: "asc" },
  });
  const dueCount = openTrades.length;

  let closed = 0;
  let closedWithMarkout = 0;
  let closedWithoutMarkout = 0;

  for (const t of openTrades) {
    try {
      const at12h = new Date(t.entryTime.getTime() + horizonMs);
      const price0 = parseNum(t.entryPrice);

      if (price0 == null || price0 <= 0) {
        await prisma.paperTrade.update({
          where: { id: t.id },
          data: {
            status: "closed",
            exitTime: new Date(),
            metadataJson: mergePaperCloseMetadata(t.metadataJson, {
              closeReason: "no_entry_price",
              exitTimeIso: now.toISOString(),
            }),
          },
        });
        closed++;
        closedWithoutMarkout++;
        closeReasonCounts.no_entry_price = (closeReasonCounts.no_entry_price ?? 0) + 1;
        continue;
      }

      const exit = await resolvePaperTradeCloseExitPrice(t.marketId, t.assetId, at12h);
      if (!exit) {
        await prisma.paperTrade.update({
          where: { id: t.id },
          data: {
            status: "closed",
            exitTime: new Date(),
            metadataJson: mergePaperCloseMetadata(t.metadataJson, {
              closeReason: "no_exit_price_snapshot",
              horizonAtIso: at12h.toISOString(),
              exitTimeIso: now.toISOString(),
            }),
          },
        });
        closed++;
        closedWithoutMarkout++;
        closeReasonCounts.no_exit_price_snapshot = (closeReasonCounts.no_exit_price_snapshot ?? 0) + 1;
        console.warn(
          `[paper-trading] Closed paper trade id=${t.id} without markout (no MarketPriceSnapshot for market/asset)`
        );
        continue;
      }

      const m12 = markout(t.side, price0, exit.price);
      const pnlPct = m12 != null ? String(m12) : null;
      const exitTime = new Date();
      const markoutKey =
        exit.source === "lte"
          ? "markout_snapshot_lte"
          : exit.source === "gte_after_horizon"
            ? "markout_snapshot_gte_after_horizon"
            : "markout_snapshot_latest_any";
      closeReasonCounts[markoutKey] = (closeReasonCounts[markoutKey] ?? 0) + 1;

      await prisma.paperTrade.update({
        where: { id: t.id },
        data: {
          status: "closed",
          exitPrice: String(exit.price),
          exitTime,
          markout12h: pnlPct,
          pnlPct,
          pnlDollars: null,
          metadataJson: mergePaperCloseMetadata(t.metadataJson, {
            exitPriceSource: exit.source,
            snapshotCapturedAt: exit.snapshotCapturedAt,
            horizonAtIso: at12h.toISOString(),
          }),
        },
      });
      closed++;
      if (pnlPct != null) closedWithMarkout++;
      else closedWithoutMarkout++;
      console.log(
        `[paper-trading] Closed paper trade id=${t.id} markout12h=${pnlPct} exitSource=${exit.source}`
      );
    } catch (e) {
      errors.push(`Trade ${t.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const result: ClosePaperTradesAt12hResult = {
    runAt: now.toISOString(),
    horizonMs,
    openTotalCount,
    dueCount,
    closed,
    closedWithMarkout,
    closedWithoutMarkout,
    errors,
    errorSample: errors.slice(0, 5),
    closeReasonCounts,
  };

  console.info("[paper-trading] paper_trading_close_due summary", {
    openTotalCount,
    dueCount,
    closed,
    closedWithMarkout,
    closedWithoutMarkout,
    closeReasonCounts,
    errorCount: errors.length,
  });

  const MAX_ERRORS_IN_STATE = 40;
  const errorsTotal = errors.length;
  const persistPayload: ClosePaperTradesAt12hResult = {
    ...result,
    errors:
      errors.length > MAX_ERRORS_IN_STATE
        ? [
            ...errors.slice(0, MAX_ERRORS_IN_STATE),
            `…truncated: ${errors.length - MAX_ERRORS_IN_STATE} more (see logs / errorsTotal)`,
          ]
        : errors,
    errorsTotal,
    errorsTruncated: errors.length > MAX_ERRORS_IN_STATE,
    errorSample: errors.slice(0, 5),
  };

  try {
    await prisma.paperTradingState.upsert({
      where: { id: STATE_ID },
      create: {
        id: STATE_ID,
        lastCloseTickAt: new Date(),
        lastCloseTickResultJson: JSON.stringify(persistPayload),
        lastCloseTickError: errors.length > 0 ? errors[errors.length - 1]! : null,
        updatedAt: new Date(),
      },
      update: {
        lastCloseTickAt: new Date(),
        lastCloseTickResultJson: JSON.stringify(persistPayload),
        lastCloseTickError: errors.length > 0 ? errors[errors.length - 1]! : null,
        updatedAt: new Date(),
      },
    });
  } catch (e) {
    console.error("[paper-trading] Failed to persist close tick state", e);
  }

  return result;
}
