/**
 * Compact paper decision trace types for observability only.
 * Does not affect admission or runtime behavior.
 */

/** Stable compact reject reason taxonomy (first check that fails wins in engine order). */
export type PaperDecisionRejectReasonCode =
  | "below_threshold"
  | "outside_exploration_band"
  | "exploration_cap_tick"
  | "exploration_cap_day"
  | "budget_cap"
  | "cooldown_asset"
  | "cooldown_market"
  | "dedupe"
  | "max_open_total"
  | "max_open_per_market"
  | "max_open_per_theme"
  | "max_open_per_category"
  | "missing_shadow_score"
  | "candidate_filter"
  | "spread_guard"
  | "slippage_guard"
  | "unknown_rejection";

export type PaperDecisionFinalDisposition = "admitted" | "rejected";

/** One compact trace entry per candidate considered (bounded in storage). */
export interface PaperDecisionTraceEntry {
  botType: string;
  recommendationId: string;
  assetId: string;
  marketId: string | null;
  marketSlug?: string | null;
  marketTitle?: string | null;
  targetLabel: string | null;
  policyState: string | null;
  paperPolicyMode?: string | null;
  paperRelaxationReason?: string | null;

  championModelRunId: string | null;
  challengerModelRunId: string | null;
  championScore: number | null;
  challengerScore: number | null;
  scoreDelta: number | null;
  minScore: number | null;
  explorationMinScore?: number | null;

  /**
   * Score used for threshold/exploration gating (raw or calibrated per `admissionUsesCalibrated`).
   * `championScore` is the champion model probability passed to challenger compare (raw); may differ when paper uses calibrated admission.
   */
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

  finalDisposition: PaperDecisionFinalDisposition;
  rejectReasonCode?: PaperDecisionRejectReasonCode | null;
  rejectedBy?: PaperDecisionRejectReasonCode[];
  dedupeKey?: string | null;

  /** Scalar market context at trace time (from shadow input / execution-quality snapshot when available). */
  spreadBps: number | null;
  estimatedSlippageBps: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  midPrice: number | null;
  priceUsedForDecision: number | null;

  /** Paper-only daily-cap overflow routing (set only when overflow was attempted for this candidate). */
  originalBotKey?: string | null;
  finalBotKey?: string | null;
  overflowAttempted?: boolean;
  overflowTriedBotKeys?: string[];
  overflowSucceeded?: boolean;
  overflowTerminalReason?: string | null;
}

/** Per-bot aggregates for the last tick (exact counts, not from capped traces). */
export interface PaperDecisionTracePerBotAggregate {
  botType: string;
  totalCandidates: number;
  admitted: number;
  rejected: number;
  rejectedByThreshold: number;
  rejectedByExplorationCap: number;
  rejectedByBudget: number;
  rejectedByCooldown: number;
  rejectedByDedupe: number;
  rejectedByCaps: number;
  rejectedBySpreadGuard: number;
  rejectedBySlippageGuard: number;
  rejectedOther: number;
  explorationEligible: number;
  explorationUsed: number;
}

/** Bounded trace bundle stored in lastOpenTickResultJson.decisionTraceBundle. */
export interface PaperDecisionTraceBundle {
  generatedAt: string;
  maxTracesStored: number;
  totalCandidatesConsidered: number;
  perBotAggregates: PaperDecisionTracePerBotAggregate[];
  traces: PaperDecisionTraceEntry[];
}

export const MAX_DECISION_TRACES_STORED = 400;
