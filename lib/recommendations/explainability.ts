/**
 * Recommendation explainability: deterministic explanation from persisted recommendation,
 * signal, evaluation, and review data. No new tables; no speculative AI.
 * Read path only.
 */

export interface ExplainabilitySignalInput {
  marketPrice: string | null;
  fairPrice: string | null;
  edge: string | null;
  confidence: string | null;
  momentumScore?: string | null;
  liquidityScore?: string | null;
  crowdingScore?: string | null;
  portfolioPenalty?: string | null;
  behaviorPenalty?: string | null;
}

export interface ExplainabilityRecommendationInput {
  id: string;
  action: string;
  primaryActionType: string | null;
  suggestedEntryMin: string | null;
  suggestedEntryMax: string | null;
  suggestedSize: string;
  blockedReason: string | null;
  priorityScore: string;
  rationale: string | null;
  portfolioImpact: string | null;
  riskNote: string | null;
  timingNote: string | null;
  qualityBlocker: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExplainabilityMarketRef {
  marketId: string;
  marketTitle?: string | null;
  outcome?: string | null;
  assetId?: string | null;
}

export interface ExplainabilityEvaluationRef {
  id: string;
  evaluatedAt: string;
  marketPriceAtEval: string;
  priceChange1h?: string | null;
  priceChange6h?: string | null;
  priceChange24h?: string | null;
  wasPositive?: boolean | null;
}

export interface ExplainabilityReviewRef {
  status: string;
  reviewerNote: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** Normalized explanation structure for UI/API. */
export interface RecommendationExplanation {
  recommendationId: string;
  marketRef: ExplainabilityMarketRef | null;
  assetId: string | null;
  action: string;
  primaryActionType: string | null;
  suggestedSize: string;
  suggestedEntryMin: string | null;
  suggestedEntryMax: string | null;
  signalInputs: ExplainabilitySignalInput;
  category: string | null;
  theme: string | null;
  rationale: string | null;
  thesis: string | null;
  timingNote: string | null;
  riskNote: string | null;
  blocker: string | null;
  portfolioImpact: string | null;
  evaluationRefs: ExplainabilityEvaluationRef[];
  reviewRef: ExplainabilityReviewRef | null;
  createdAt: string;
  updatedAt: string;
  /** Normalized sections for display. */
  summary: string | null;
  drivers: Record<string, string>;
  penalties: Record<string, string>;
  sizing: Record<string, string>;
  quality: Record<string, string>;
  review: Record<string, string>;
}

function safeStr(val: unknown): string | null {
  if (val == null) return null;
  const s = String(val).trim();
  return s === "" ? null : s;
}

function safeNum(val: unknown): number | null {
  if (val == null || val === "") return null;
  const n = parseFloat(String(val));
  return Number.isFinite(n) ? n : null;
}

/**
 * Build a normalized explanation from stored recommendation, signal, and optional evaluation/review.
 * Only uses provided fields; omits or nulls when unavailable.
 */
export function buildRecommendationExplanation(params: {
  recommendation: ExplainabilityRecommendationInput;
  signal: ExplainabilitySignalInput & {
    category?: string | null;
    theme?: string | null;
    thesis?: string | null;
  };
  marketRef?: ExplainabilityMarketRef | null;
  assetId?: string | null;
  evaluationRefs?: ExplainabilityEvaluationRef[];
  reviewRef?: ExplainabilityReviewRef | null;
}): RecommendationExplanation {
  const {
    recommendation,
    signal,
    marketRef = null,
    assetId = null,
    evaluationRefs = [],
    reviewRef = null,
  } = params;

  const drivers: Record<string, string> = {};
  const penalties: Record<string, string> = {};
  const sizing: Record<string, string> = {};
  const quality: Record<string, string> = {};
  const review: Record<string, string> = {};

  // Signal inputs (only include when present)
  const signalInputs: ExplainabilitySignalInput = {
    marketPrice: signal.marketPrice ?? null,
    fairPrice: signal.fairPrice ?? null,
    edge: signal.edge ?? null,
    confidence: signal.confidence ?? null,
    momentumScore: signal.momentumScore ?? null,
    liquidityScore: signal.liquidityScore ?? null,
    crowdingScore: signal.crowdingScore ?? null,
    portfolioPenalty: signal.portfolioPenalty ?? null,
    behaviorPenalty: signal.behaviorPenalty ?? null,
  };

  // Drivers: edge, confidence, momentum, liquidity, crowding (one-liners from values)
  const edge = safeNum(signal.edge);
  const confidence = safeNum(signal.confidence);
  const momentumScore = safeNum(signal.momentumScore);
  const liquidityScore = safeNum(signal.liquidityScore);
  const crowdingScore = safeNum(signal.crowdingScore);

  if (edge != null) drivers.edge = `Edge ${(edge * 100).toFixed(1)}% (market vs fair).`;
  if (confidence != null) drivers.confidence = `Confidence ${(confidence * 100).toFixed(0)}%.`;
  if (momentumScore != null) drivers.momentumScore = `Momentum score ${(momentumScore * 100).toFixed(0)}%.`;
  if (liquidityScore != null) drivers.liquidityScore = `Liquidity score ${(liquidityScore * 100).toFixed(0)}%.`;
  if (crowdingScore != null) drivers.crowdingScore = `Crowding score ${(crowdingScore * 100).toFixed(0)}%.`;

  // Penalties
  const portPen = safeNum(signal.portfolioPenalty);
  const behPen = safeNum(signal.behaviorPenalty);
  if (portPen != null && portPen > 0) penalties.portfolioPenalty = `Portfolio penalty ${(portPen * 100).toFixed(0)}%.`;
  if (behPen != null && behPen > 0) penalties.behaviorPenalty = `Behavior penalty ${(behPen * 100).toFixed(0)}%.`;

  // Sizing
  sizing.suggestedSize = recommendation.suggestedSize;
  if (recommendation.suggestedEntryMin != null) sizing.suggestedEntryMin = recommendation.suggestedEntryMin;
  if (recommendation.suggestedEntryMax != null) sizing.suggestedEntryMax = recommendation.suggestedEntryMax;
  sizing.priorityScore = recommendation.priorityScore;

  // Quality / blockers
  if (recommendation.qualityBlocker) quality.qualityBlocker = recommendation.qualityBlocker;
  if (recommendation.blockedReason) quality.blockedReason = recommendation.blockedReason;

  // Review
  if (reviewRef) {
    review.status = reviewRef.status;
    if (reviewRef.reviewerNote) review.reviewerNote = reviewRef.reviewerNote;
    if (reviewRef.createdAt) review.reviewedAt = reviewRef.createdAt;
  }

  // Summary: one-line from rationale > blockedReason > primaryActionType
  let summary: string | null = recommendation.rationale ?? recommendation.blockedReason ?? null;
  if (!summary && recommendation.primaryActionType) {
    const action = recommendation.primaryActionType;
    if (action === "add") summary = "Edge and confidence support adding; portfolio allows.";
    else if (action === "avoid") summary = "Overlap, timing, or quality block adding.";
    else if (action === "hedge" || action === "trim") summary = "You hold this market; signal suggests reducing exposure.";
    else if (action === "review_existing") summary = "You hold this market; edge insufficient to add. Review or hold.";
    else if (action === "monitor") summary = "Watch for better entry or confirmation.";
    else if (action === "sync_first") summary = "Resolve portfolio data before adding exposure.";
    else summary = "See rationale and portfolio context below.";
  }

  return {
    recommendationId: recommendation.id,
    marketRef,
    assetId,
    action: recommendation.action,
    primaryActionType: recommendation.primaryActionType,
    suggestedSize: recommendation.suggestedSize,
    suggestedEntryMin: recommendation.suggestedEntryMin,
    suggestedEntryMax: recommendation.suggestedEntryMax,
    signalInputs,
    category: safeStr(signal.category) ?? null,
    theme: safeStr(signal.theme) ?? null,
    rationale: recommendation.rationale,
    thesis: signal.thesis ?? null,
    timingNote: recommendation.timingNote,
    riskNote: recommendation.riskNote,
    blocker: recommendation.qualityBlocker ?? recommendation.blockedReason,
    portfolioImpact: recommendation.portfolioImpact,
    evaluationRefs,
    reviewRef,
    createdAt: recommendation.createdAt,
    updatedAt: recommendation.updatedAt,
    summary,
    drivers,
    penalties,
    sizing,
    quality,
    review,
  };
}
