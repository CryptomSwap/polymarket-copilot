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
  getPaperTradingCandidatesWithDiagnostics,
  getPaperTradingCandidatesForProfile,
  type PaperTradingCandidate,
} from "./candidates";
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

const HORIZON_12H_MS = 12 * 60 * 60 * 1000;
const FUNDER_PAPER = "paper";
const STATE_ID = "default";

function parseNum(s: string | null | undefined): number | null {
  if (s == null || s === "") return null;
  const n = parseFloat(String(s).trim());
  return Number.isFinite(n) ? n : null;
}

async function getPriceAt(marketId: string, assetId: string, at: Date): Promise<number | null> {
  const row = await prisma.marketPriceSnapshot.findFirst({
    where: { marketId, assetId, capturedAt: { lte: at } },
    orderBy: { capturedAt: "desc" },
  });
  if (!row) return null;
  return parseNum(row.price);
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

/**
 * Check if we already have an open paper trade or a recently closed one for this asset (cooldown) for a given bot.
 */
async function hasOpenOrRecentPaperTrade(
  botType: string,
  assetId: string,
  cooldownHours: number
): Promise<boolean> {
  const open = await prisma.paperTrade.findFirst({
    where: { assetId, botType, status: "open" },
  });
  if (open) return true;
  const cooldownSince = new Date(Date.now() - cooldownHours * 60 * 60 * 1000);
  const recentClosed = await prisma.paperTrade.findFirst({
    where: { assetId, botType, status: "closed", exitTime: { gte: cooldownSince } },
  });
  return recentClosed != null;
}

/**
 * Check if we have an open or recently closed paper trade for this market (market cooldown) for a given bot.
 */
async function hasOpenOrRecentPaperTradeForMarket(
  botType: string,
  marketId: string,
  cooldownMarketHours: number
): Promise<boolean> {
  if (cooldownMarketHours <= 0) return false;
  const open = await prisma.paperTrade.findFirst({
    where: { marketId, botType, status: "open" },
  });
  if (open) return true;
  const cooldownSince = new Date(Date.now() - cooldownMarketHours * 60 * 60 * 1000);
  const recentClosed = await prisma.paperTrade.findFirst({
    where: { marketId, botType, status: "closed", exitTime: { gte: cooldownSince } },
  });
  return recentClosed != null;
}

const TOP_CANDIDATES_SAMPLE_SIZE = 10;

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
  } = params;
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
    thresholdEligible,
    explorationEligible,
    explorationUsed,
    budgetLimited,
    cooldownLimited,
    dedupeLimited,
    capsLimited,
    finalDisposition,
    ...(finalDisposition === "rejected" && rejectReasonCode != null && {
      rejectReasonCode,
      rejectedBy: [rejectReasonCode],
    }),
    ...(dedupeKey != null && { dedupeKey }),
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
  /** Funder used to load recommendation-based paper candidates (audit: align with stream-runtime wallet). */
  funderUsedForCandidateLoad?: string | null;
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

  const funder = funderAddress ?? FUNDER_PAPER;
  const profiles = await getActiveBotProfiles();

  const now = new Date();

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
    let candidates: PaperTradingCandidate[];
    let loadDiagnostics: PaperTradingTickResult["loadDiagnostics"];
    try {
      const loaded = await getPaperTradingCandidatesWithDiagnostics(funder);
      candidates = loaded.candidates;
      loadDiagnostics = loaded.loadDiagnostics;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const errMsg = `Failed to get candidates: ${msg}`;
      const result = emptyResult({
        errors: [errMsg],
        enabled: true,
        funderUsedForCandidateLoad: funder,
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

    const minScore = config.threshold + config.minScoreBuffer;
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
          minScore,
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
      const score = result.result.shadowMlScore;
      const championModelRunId = result.result.modelId;
      const championTargetLabel = result.result.modelTargetLabel;
      const championChallenger = await scorePaperChampionAndChallenger(
        c.shadowInput,
        score,
        championModelRunId,
        championTargetLabel
      );
      scored.push({ assetId: c.assetId, side: c.side, score });
      if (c.paperPolicyMode === "relaxed_block_candidate") scoredAfterRelaxationCount++;
      if (c.paperRelaxationReason === "concentration_high") {
        relaxedDueToConcentrationScoredCount++;
      }
      if (score >= minScore) aboveThresholdCount++;

      if (score < minScore) {
        legacyTraces.push(buildTraceEntry({
          botType: "default",
          c,
          championModelRunId,
          challengerModelRunId: championChallenger.challengerModelRunId,
          championScore: championChallenger.championScore,
          challengerScore: championChallenger.challengerScore,
          scoreDelta: championChallenger.scoreDelta,
          minScore,
          thresholdEligible: false,
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
      if (config.maxOpenTotal > 0 && openCountTotal + totalOpened >= config.maxOpenTotal) {
        legacyTraces.push(buildTraceEntry({
          botType: "default",
          c,
          championModelRunId,
          challengerModelRunId: championChallenger.challengerModelRunId,
          championScore: championChallenger.championScore,
          challengerScore: championChallenger.challengerScore,
          scoreDelta: championChallenger.scoreDelta,
          minScore,
          thresholdEligible: true,
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
          minScore,
          thresholdEligible: true,
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
          minScore,
          thresholdEligible: true,
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
          minScore,
          thresholdEligible: true,
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
            minScore,
            thresholdEligible: true,
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
            minScore,
            thresholdEligible: true,
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
            minScore,
            thresholdEligible: true,
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
          minScore,
          thresholdEligible: true,
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
            minScore,
            thresholdEligible: true,
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
        // Paper-only telemetry: record a ShadowCandidate row so labels can be joined to PaperTrade via (recommendationId, assetId, side).
        void recordShadowCandidate({
          funderAddress: funder,
          recommendationId: c.recommendationId,
          orderIntentId: null,
          assetId: c.assetId,
          marketId: c.marketId,
          side: c.side,
          intendedPrice: parseFloat(c.entryPrice),
          intendedSize: parseFloat(c.intendedSize),
          candidateSource: "paper_trading",
          wasBlocked: false,
          wasSubmitted: false,
        }).catch(() => {});
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
            funderAddress: funder,
            side: c.side,
            score,
            championScore: championChallenger.championScore,
            challengerScore: championChallenger.challengerScore,
            challengerScoreDelta: championChallenger.scoreDelta,
            challengerAvailable: championChallenger.challengerAvailable,
            threshold: config.threshold,
            entryPrice: c.entryPrice,
            entryTime: now,
            intendedSize: c.intendedSize,
            status: "open",
            explorationAdmissionMode,
            metadataJson: JSON.stringify({
              recommendationId: c.recommendationId,
              targetLabel: active.run.targetLabel,
              ...(c.passedViaRelaxation &&
                c.relaxedBlockReason && {
                  paperOnlyRelaxation: true,
                  overriddenBlockReason: c.relaxedBlockReason,
                }),
              ...(c.derivationSource && { derivationSource: c.derivationSource }),
            }),
            sourceDecisionState: c.sourceDecisionState ?? null,
            paperPolicyMode: c.paperPolicyMode ?? null,
            paperRelaxationReason: c.paperRelaxationReason ?? null,
            originalBlockingReasons: c.originalBlockingReasons ?? null,
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
          minScore,
          thresholdEligible: true,
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
          `[paper-trading] Opened paper trade assetId=${c.assetId} score=${score.toFixed(
            3
          )} threshold=${config.threshold}`
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
            minScore,
            thresholdEligible: true,
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
      topCandidateScores,
      scoredAfterRelaxation: scoredAfterRelaxationCount,
      paperTradesCreatedFromRelaxation: paperTradesCreatedFromRelaxationCount,
      relaxedScoredSuccessfully: scoredAfterRelaxationCount,
      relaxedOpenedTrades: paperTradesCreatedFromRelaxationCount,
      relaxedDueToConcentrationScored: relaxedDueToConcentrationScoredCount,
      relaxedDueToConcentrationOpened: relaxedDueToConcentrationOpenedCount,
      funderUsedForCandidateLoad: funder,
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

  for (const profile of profiles) {
    const profileThreshold = profile.threshold;
    const profileMinScoreBuffer = profile.minScoreBuffer;
    const minScore = profileThreshold + profileMinScoreBuffer;

    let candidates: PaperTradingCandidate[] = [];
    let loadDiagnostics: PaperTradingTickResult["loadDiagnostics"];

    try {
      const loaded = await getPaperTradingCandidatesForProfile(profile, funder);
      candidates = loaded.candidates;
      loadDiagnostics = loaded.loadDiagnostics;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const errMsg = `Failed to get candidates for botType=${profile.botType}: ${msg}`;
      errors.push(errMsg);
      continue;
    }

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
      explorationBandBelowMinScore > 0 ? Math.max(minScore - explorationBandBelowMinScore, 0) : 0;
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

    tracePerBotAggregates[profile.botType] = initPerBotAggregate(profile.botType);
    const agg = tracePerBotAggregates[profile.botType];

    const scored: { assetId: string; side: string; score: number }[] = [];
    let rejectedByCooldownCount = 0;
    let rejectedByRiskLimitCount = 0;
    let aboveThresholdCount = 0;
    let scoredAfterRelaxationCount = 0;
    let paperTradesCreatedFromRelaxationCount = 0;
    let relaxedDueToConcentrationScoredCount = 0;
    let relaxedDueToConcentrationOpenedCount = 0;
    let relaxedConcentrationRejectedByCap = 0;
    let openedForBot = 0;
    let skippedForBot = 0;
    let rejectedByBudgetCount = 0;
    let explorationOpenedForBot = 0;

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
          minScore,
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
      const score = result.result.shadowMlScore;
      const championModelRunId = result.result.modelId;
      const championTargetLabel = result.result.modelTargetLabel;
      const championChallenger = await scorePaperChampionAndChallenger(
        c.shadowInput,
        score,
        championModelRunId,
        championTargetLabel
      );
      scored.push({ assetId: c.assetId, side: c.side, score });
      allScored.push({ assetId: c.assetId, side: c.side, score });
      if (c.paperPolicyMode === "relaxed_block_candidate") scoredAfterRelaxationCount++;
      if (c.paperRelaxationReason === "concentration_high") {
        relaxedDueToConcentrationScoredCount++;
      }
      if (score >= minScore) aboveThresholdCount++;

      // Admission decision: threshold path (score >= minScore) or paper-only exploration path
      // for a narrow band below minScore when exploration is enabled for this bot.
      let explorationAdmissionMode: "threshold" | "exploration" | null = null;
      if (score >= minScore) {
        explorationAdmissionMode = "threshold";
      } else {
        const withinExplorationBand =
          explorationEnabledForBot &&
          explorationBandBelowMinScore > 0 &&
          score >= explorationMinScore &&
          score < minScore;
        const underPerTickCap =
          explorationMaxPerTick > 0 ? explorationOpenedForBot < explorationMaxPerTick : false;
        const underPerDayCap =
          explorationMaxPerDay > 0
            ? explorationCreatedToday + explorationOpenedForBot < explorationMaxPerDay
            : true;

        if (withinExplorationBand && underPerTickCap && underPerDayCap) {
          explorationAdmissionMode = "exploration";
          agg.explorationEligible++;
        } else {
          const rejectCode: PaperDecisionRejectReasonCode = !withinExplorationBand
            ? "outside_exploration_band"
            : !underPerTickCap
              ? "exploration_cap_tick"
              : "exploration_cap_day";
          allTraces.push(buildTraceEntry({
            botType: profile.botType,
            c,
            championModelRunId,
            challengerModelRunId: championChallenger.challengerModelRunId,
            championScore: championChallenger.championScore,
            challengerScore: championChallenger.challengerScore,
            scoreDelta: championChallenger.scoreDelta,
            minScore,
            explorationMinScore: explorationEnabledForBot ? explorationMinScore : null,
            thresholdEligible: false,
            explorationEligible: withinExplorationBand,
            explorationUsed: false,
            budgetLimited: false,
            cooldownLimited: false,
            dedupeLimited: false,
            capsLimited: false,
            finalDisposition: "rejected",
            rejectReasonCode: rejectCode,
          }));
          incReject(agg, rejectCode);
          skippedForBot++;
          continue;
        }
      }
      if (explorationAdmissionMode === "exploration") agg.explorationUsed++;

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
          minScore,
          explorationMinScore: explorationEnabledForBot ? explorationMinScore : null,
          thresholdEligible: explorationAdmissionMode === "threshold",
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
        if (
          budgetAllocatorEnabled &&
          decision &&
          budgetCap > 0 &&
          maxDailyFromConfig > 0 &&
          budgetCap < maxDailyFromConfig
        ) {
          rejectedByBudgetCount++;
        }
        allTraces.push(buildTraceEntry({
          botType: profile.botType,
          c,
          championModelRunId,
          challengerModelRunId: championChallenger.challengerModelRunId,
          championScore: championChallenger.championScore,
          challengerScore: championChallenger.challengerScore,
          scoreDelta: championChallenger.scoreDelta,
          minScore,
          explorationMinScore: explorationEnabledForBot ? explorationMinScore : null,
          thresholdEligible: explorationAdmissionMode === "threshold",
          explorationEligible: explorationEnabledForBot && explorationBandBelowMinScore > 0,
          explorationUsed: explorationAdmissionMode === "exploration",
          budgetLimited: true,
          cooldownLimited: false,
          dedupeLimited: false,
          capsLimited: false,
          finalDisposition: "rejected",
          rejectReasonCode: "budget_cap",
        }));
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
          minScore,
          explorationMinScore: explorationEnabledForBot ? explorationMinScore : null,
          thresholdEligible: explorationAdmissionMode === "threshold",
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
          minScore,
          explorationMinScore: explorationEnabledForBot ? explorationMinScore : null,
          thresholdEligible: explorationAdmissionMode === "threshold",
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
            minScore,
            explorationMinScore: explorationEnabledForBot ? explorationMinScore : null,
            thresholdEligible: explorationAdmissionMode === "threshold",
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
            minScore,
            explorationMinScore: explorationEnabledForBot ? explorationMinScore : null,
            thresholdEligible: explorationAdmissionMode === "threshold",
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
            minScore,
            explorationMinScore: explorationEnabledForBot ? explorationMinScore : null,
            thresholdEligible: explorationAdmissionMode === "threshold",
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
          minScore,
          explorationMinScore: explorationEnabledForBot ? explorationMinScore : null,
          thresholdEligible: explorationAdmissionMode === "threshold",
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
            minScore,
            explorationMinScore: explorationEnabledForBot ? explorationMinScore : null,
            thresholdEligible: explorationAdmissionMode === "threshold",
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
        // Paper-only telemetry: record a ShadowCandidate row so labels can be joined to PaperTrade via (recommendationId, assetId, side).
        void recordShadowCandidate({
          funderAddress: funder,
          recommendationId: c.recommendationId,
          orderIntentId: null,
          assetId: c.assetId,
          marketId: c.marketId,
          side: c.side,
          intendedPrice: parseFloat(c.entryPrice),
          intendedSize: parseFloat(c.intendedSize),
          candidateSource: "paper_trading",
          wasBlocked: false,
          wasSubmitted: false,
        }).catch(() => {});
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
            funderAddress: funder,
            side: c.side,
            score,
            championScore: championChallenger.championScore,
            challengerScore: championChallenger.challengerScore,
            challengerScoreDelta: championChallenger.scoreDelta,
            challengerAvailable: championChallenger.challengerAvailable,
            threshold: profileThreshold,
            entryPrice: c.entryPrice,
            entryTime: now,
            intendedSize: c.intendedSize,
            status: "open",
            explorationAdmissionMode,
            metadataJson: JSON.stringify({
              recommendationId: c.recommendationId,
              targetLabel: profile.targetLabel ?? active.run.targetLabel,
              botType: profile.botType,
              botDisplayName: profile.displayName,
              botVersion: profile.botVersion ?? null,
              exploration:
                finalExplorationAdmissionMode === "exploration"
                  ? {
                      mode: explorationPolicyMode,
                      bandBelowMinScore: explorationBandBelowMinScore,
                      minScore,
                    }
                  : undefined,
              ...(c.passedViaRelaxation &&
                c.relaxedBlockReason && {
                  paperOnlyRelaxation: true,
                  overriddenBlockReason: c.relaxedBlockReason,
                }),
              ...(c.derivationSource && { derivationSource: c.derivationSource }),
            }),
            sourceDecisionState: c.sourceDecisionState ?? null,
            paperPolicyMode: c.paperPolicyMode ?? null,
            paperRelaxationReason: c.paperRelaxationReason ?? null,
            originalBlockingReasons: c.originalBlockingReasons ?? null,
            paperEligibilityVersion: c.paperEligibilityVersion ?? null,
            botType: profile.botType,
            botVersion: profile.botVersion ?? null,
            targetLabel: profile.targetLabel ?? active.run.targetLabel,
            entryPriceBand,
            profileSnapshotJson: profileSnapshot,
          },
        });
        openedForBot++;
        agg.admitted++;
        if (c.paperRelaxationReason === "concentration_high") {
          relaxedDueToConcentrationOpenedCount++;
        }
        if (finalExplorationAdmissionMode === "exploration") {
          explorationOpenedForBot++;
        }
        allTraces.push(buildTraceEntry({
          botType: profile.botType,
          c,
          championModelRunId: championChallenger.championModelRunId,
          challengerModelRunId: championChallenger.challengerModelRunId,
          championScore: championChallenger.championScore,
          challengerScore: championChallenger.challengerScore,
          scoreDelta: championChallenger.scoreDelta,
          minScore,
          explorationMinScore: explorationEnabledForBot ? explorationMinScore : null,
          thresholdEligible: explorationAdmissionMode === "threshold",
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
          `[paper-trading] Opened paper trade botType=${profile.botType} assetId=${c.assetId} score=${score.toFixed(
            3
          )} threshold=${profileThreshold}`
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
            minScore,
            explorationMinScore: explorationEnabledForBot ? explorationMinScore : null,
            thresholdEligible: explorationAdmissionMode === "threshold",
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
    topCandidateScores,
    scoredAfterRelaxation: totalScoredAfterRelaxationCount,
    paperTradesCreatedFromRelaxation: totalPaperTradesCreatedFromRelaxationCount,
    relaxedScoredSuccessfully: totalScoredAfterRelaxationCount,
    relaxedOpenedTrades: totalPaperTradesCreatedFromRelaxationCount,
    relaxedDueToConcentrationScored: totalRelaxedDueToConcentrationScored,
    relaxedDueToConcentrationOpened: totalRelaxedDueToConcentrationOpened,
    funderUsedForCandidateLoad: funder,
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

/**
 * Close paper trades that have passed the 12h horizon. Compute markout and PnL from MarketPriceSnapshot.
 * Persists last close result to PaperTradingState.
 */
export async function closePaperTradesAt12h(): Promise<{
  closed: number;
  errors: string[];
}> {
  const horizonEnd = new Date(Date.now() - HORIZON_12H_MS);
  const openTrades = await prisma.paperTrade.findMany({
    where: { status: "open", entryTime: { lte: horizonEnd } },
    orderBy: { entryTime: "asc" },
  });
  const errors: string[] = [];
  let closed = 0;

  for (const t of openTrades) {
    const at12h = new Date(t.entryTime.getTime() + HORIZON_12H_MS);
    const price0 = parseNum(t.entryPrice);
    const price12h = await getPriceAt(t.marketId, t.assetId, at12h);

    if (price0 == null || price0 <= 0) {
      await prisma.paperTrade.update({
        where: { id: t.id },
        data: {
          status: "closed",
          exitTime: new Date(),
          metadataJson: (t.metadataJson ?? "{}").replace(/}$/, ',"closeReason":"no_entry_price"}'),
        },
      });
      closed++;
      continue;
    }
    if (price12h == null) {
      errors.push(`No 12h price for paper trade ${t.id} (${t.assetId})`);
      continue;
    }

    const m12 = markout(t.side, price0, price12h);
    const pnlPct = m12 != null ? String(m12) : null;
    const exitTime = new Date();

    await prisma.paperTrade.update({
      where: { id: t.id },
      data: {
        status: "closed",
        exitPrice: String(price12h),
        exitTime,
        markout12h: pnlPct,
        pnlPct,
        pnlDollars: null,
      },
    });
    closed++;
    console.log(`[paper-trading] Closed paper trade id=${t.id} markout12h=${pnlPct}`);
  }

  const result = { closed, errors };
  try {
    await prisma.paperTradingState.upsert({
      where: { id: STATE_ID },
      create: {
        id: STATE_ID,
        lastCloseTickAt: new Date(),
        lastCloseTickResultJson: JSON.stringify(result),
        lastCloseTickError: errors.length > 0 ? errors[errors.length - 1] : null,
        updatedAt: new Date(),
      },
      update: {
        lastCloseTickAt: new Date(),
        lastCloseTickResultJson: JSON.stringify(result),
        lastCloseTickError: errors.length > 0 ? errors[errors.length - 1] : null,
        updatedAt: new Date(),
      },
    });
  } catch (e) {
    console.error("[paper-trading] Failed to persist close tick state", e);
  }

  return result;
}
