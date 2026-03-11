/**
 * Recommendation engine: turn signals into suggested actions. Stricter sizing and blocks.
 * v2: portfolio-aware, action-oriented, with primaryActionType and explainable fields.
 * Read-only; no order placement.
 */

import type { MarketSignalRow } from "./signals";

export type RecommendationAction =
  | "STRONG_BUY"
  | "BUY_SMALL"
  | "WATCH"
  | "NO_TRADE"
  | "TRIM"
  | "EXIT";

/** v2: primary action for UI and filtering (portfolio-aware). */
export type PrimaryActionType =
  | "add"
  | "review_existing"
  | "trim"
  | "hedge"
  | "avoid"
  | "monitor"
  | "sync_first";

export interface RecommendationContext {
  hasPositionInAsset: boolean;
  positionMarketValue: number;
  themeExposurePct: number;
  topConcentrationPct: number;
  /** Optional: news catalyst boost (0–0.1) to add to confidence. */
  newsCatalystBoost?: number;
  /** Optional: news saturation penalty (0–0.2) to subtract from confidence or add to block. */
  newsSaturationPenalty?: number;
}

/** v2: extends context with portfolio intelligence snapshot for overlap/concentration/timing. */
export interface RecommendationContextV2 extends RecommendationContext {
  /** Held market ids (SyncedMarket.id) for duplicate detection. */
  heldMarketIds: Set<string>;
  /** Category -> exposure pct of portfolio (0–100). */
  categoryExposurePct: Record<string, number>;
  /** Theme -> exposure pct of portfolio (0–100). Base themeExposurePct remains the number for this signal's theme. */
  themeExposurePctByTheme: Record<string, number>;
  nearResolutionCount: number;
  staleCount: number;
  unresolvedCount: number;
  /** Days until this market resolves (null if unknown). Used for timingNote. */
  timeToResolutionDays?: number | null;
}

export interface RecommendationRow {
  marketSignalId: string;
  action: RecommendationAction;
  suggestedEntryMin: string | null;
  suggestedEntryMax: string | null;
  suggestedSize: string;
  blockedReason: string | null;
  priorityScore: string;
}

/** v2: adds primaryActionType and structured explanation fields. */
export interface RecommendationRowV2 extends RecommendationRow {
  primaryActionType: PrimaryActionType;
  rationale: string | null;
  portfolioImpact: string | null;
  riskNote: string | null;
  timingNote: string | null;
  qualityBlocker: string | null;
}

const MATERIAL_EXPOSURE_THRESHOLD = 10; // USD
const TOP_CONCENTRATION_CAP = 50; // % - block buy if would push theme over this
const LATE_CHASE_MIN_CONFIDENCE = 0.75;

function parseNum(s: string): number {
  const n = parseFloat(String(s).trim());
  return Number.isFinite(n) ? n : 0;
}

function toStr(n: number): string {
  return String(Number.isFinite(n) ? n : 0);
}

/**
 * Decide action and sizing. No fresh buy if material exposure in same asset; shrink for theme; block concentration/chase.
 */
export function signalToRecommendation(
  signal: MarketSignalRow,
  context: RecommendationContext
): RecommendationRow {
  const edge = parseNum(signal.edge);
  let confidence = parseNum(signal.confidence);
  const marketPrice = parseNum(signal.marketPrice);
  const portPen = parseNum(signal.portfolioPenalty);
  const behPen = parseNum(signal.behaviorPenalty);
  const liquidityScore = parseNum(signal.liquidityScore);
  const {
    hasPositionInAsset,
    positionMarketValue,
    themeExposurePct,
    topConcentrationPct,
    newsCatalystBoost = 0,
    newsSaturationPenalty = 0,
  } = context;
  confidence = Math.max(0, Math.min(1, confidence + newsCatalystBoost - newsSaturationPenalty));

  const materialExistingExposure = hasPositionInAsset && positionMarketValue >= MATERIAL_EXPOSURE_THRESHOLD;
  const wouldWorsenConcentration =
    themeExposurePct > 0 && topConcentrationPct + themeExposurePct * 0.5 > TOP_CONCENTRATION_CAP;
  const isLateChase = signal.signalType === "LATE_CHASE";
  const lateChaseBlock = isLateChase && confidence < LATE_CHASE_MIN_CONFIDENCE;

  let action: RecommendationAction = "WATCH";
  let suggestedSize = 0;
  let blockedReason: string | null = null;
  const entryMin = Math.max(0.01, marketPrice * 0.95);
  const entryMax = Math.min(0.99, marketPrice * 1.05);

  if (hasPositionInAsset) {
    if (edge < -0.05) {
      action = "TRIM";
      suggestedSize = 0.5;
    } else if (edge < -0.1) {
      action = "EXIT";
      suggestedSize = 1;
    } else {
      action = "NO_TRADE";
      blockedReason = "Already have position; edge insufficient to add.";
    }
  } else if (materialExistingExposure) {
    action = "NO_TRADE";
    blockedReason = "Material existing exposure in same asset; avoid adding.";
  } else if (portPen >= 0.3 || behPen >= 0.25) {
    action = "NO_TRADE";
    blockedReason =
      portPen >= 0.3
        ? "Theme overconcentrated; reduce exposure before adding."
        : "Behavior flags suggest pausing new trades.";
  } else if (wouldWorsenConcentration) {
    action = "NO_TRADE";
    blockedReason = `Adding would push top concentration past ${TOP_CONCENTRATION_CAP}%.`;
  } else if (lateChaseBlock) {
    action = "NO_TRADE";
    blockedReason = "Late chase setup; confidence below threshold. Wait for pullback.";
  } else if (liquidityScore < 0.15) {
    action = "NO_TRADE";
    blockedReason = "Liquidity too low for suggested size.";
  } else if (signal.signalType === "OVERCROWDED_THEME") {
    action = "NO_TRADE";
    blockedReason = "Market crowded or low liquidity.";
  } else if (edge >= 0.12 && confidence >= 0.6) {
    action = "STRONG_BUY";
    suggestedSize = 0.8;
  } else if (edge >= 0.06 && confidence >= 0.45) {
    action = "BUY_SMALL";
    suggestedSize = 0.4;
  } else if (edge >= 0.03) {
    action = "WATCH";
    suggestedSize = 0;
  } else {
    action = "NO_TRADE";
    if (edge <= -0.05) blockedReason = "Negative edge; avoid or trim.";
    else blockedReason = "Edge too small for action.";
  }

  if (signal.signalType === "CHEAP_LONGSHOT" && (action === "BUY_SMALL" || action === "STRONG_BUY")) {
    suggestedSize = Math.min(suggestedSize, 0.2);
  }
  if (portPen > 0 && action !== "NO_TRADE" && action !== "TRIM" && action !== "EXIT") {
    suggestedSize = suggestedSize * (1 - portPen);
  }
  if (themeExposurePct > 0 && action !== "NO_TRADE" && action !== "TRIM" && action !== "EXIT") {
    suggestedSize = suggestedSize * Math.max(0.3, 1 - themeExposurePct / 100);
  }
  if (isLateChase && action !== "NO_TRADE") {
    suggestedSize = suggestedSize * 0.5;
  }

  const priorityScore =
    (Math.abs(edge) * 0.5 + confidence * 0.3 + (action === "STRONG_BUY" ? 0.2 : 0)) *
    (action === "NO_TRADE" ? 0.1 : 1);

  return {
    marketSignalId: "",
    action,
    suggestedEntryMin: action === "STRONG_BUY" || action === "BUY_SMALL" ? toStr(entryMin) : null,
    suggestedEntryMax: action === "STRONG_BUY" || action === "BUY_SMALL" ? toStr(entryMax) : null,
    suggestedSize: toStr(suggestedSize),
    blockedReason,
    priorityScore: toStr(Math.max(0, priorityScore)),
  };
}

// --- v2 constants (deterministic, explainable) ---

const OVERLAP_AVOID_PCT = 35;
const NEAR_RESOLUTION_DAYS = 7;
const DUPLICATE_THEME_CAP_PCT = 40;

/**
 * v2: Portfolio-aware recommendation with primaryActionType and explanation fields.
 * Reuses same action/sizing logic; adds derivation of add | review_existing | trim | hedge | avoid | monitor | sync_first
 * and rationale, portfolioImpact, riskNote, timingNote, qualityBlocker. Down-ranks on overlap, duplicate thesis,
 * near resolution (for buys), and incomplete/stale data.
 */
export function signalToRecommendationV2(
  signal: MarketSignalRow,
  context: RecommendationContextV2
): RecommendationRowV2 {
  const base = signalToRecommendation(signal, context);

  const edge = parseNum(signal.edge);
  const confidence = parseNum(signal.confidence);
  const marketPrice = parseNum(signal.marketPrice);
  const themePct = context.themeExposurePctByTheme[signal.theme] ?? context.themeExposurePct ?? 0;
  const categoryPct = context.categoryExposurePct[signal.category] ?? 0;
  const isHeld = context.heldMarketIds.has(signal.marketId);
  const timeToRes = context.timeToResolutionDays ?? null;
  const nearResolution = timeToRes != null && timeToRes <= NEAR_RESOLUTION_DAYS;

  let primaryActionType: PrimaryActionType = "monitor";
  let rationale: string | null = null;
  let portfolioImpact: string | null = null;
  let riskNote: string | null = null;
  let timingNote: string | null = null;
  let qualityBlocker: string | null = null;

  if (context.unresolvedCount > 0 && !context.hasPositionInAsset) {
    qualityBlocker = "Sync portfolio to resolve positions before adding new exposure.";
  }
  if (context.staleCount > 0) {
    if (!qualityBlocker) qualityBlocker = "Some positions have stale sync; consider re-syncing.";
  }

  if (nearResolution && timeToRes != null) {
    timingNote = `Market resolves in ${Math.round(timeToRes)} days.`;
  }

  if (signal.signalType === "LATE_CHASE") {
    riskNote = "Late chase setup; momentum may reverse.";
  } else if (signal.signalType === "CHEAP_LONGSHOT") {
    riskNote = "Low price, high variance; size accordingly.";
  } else if (parseNum(signal.liquidityScore) < 0.2) {
    riskNote = "Low liquidity; execution risk.";
  }

  if (context.hasPositionInAsset) {
    if (base.action === "EXIT") {
      primaryActionType = "hedge";
      rationale = `Negative edge ${(edge * 100).toFixed(1)}%; exit reduces exposure.`;
      portfolioImpact = "Reduces concentration and removes position.";
    } else if (base.action === "TRIM") {
      primaryActionType = "trim";
      rationale = `Moderate negative edge ${(edge * 100).toFixed(1)}%; trim size.`;
      portfolioImpact = "Reduces position size; keeps some exposure.";
    } else {
      primaryActionType = "review_existing";
      rationale = "You hold this market; edge insufficient to add. Review or hold.";
      portfolioImpact = "No change; existing position.";
    }
  } else if (base.action === "NO_TRADE" && base.blockedReason) {
    if (context.unresolvedCount > 0 && !qualityBlocker) {
      primaryActionType = "sync_first";
    } else if (themePct >= OVERLAP_AVOID_PCT || categoryPct >= OVERLAP_AVOID_PCT) {
      primaryActionType = "avoid";
      rationale = `High overlap: ${themePct.toFixed(0)}% in theme, ${categoryPct.toFixed(0)}% in category. ${base.blockedReason}`;
      portfolioImpact = "Adding would increase concentration.";
    } else if (isHeld) {
      primaryActionType = "review_existing";
      rationale = base.blockedReason;
    } else if (nearResolution && (base.action === "NO_TRADE" || base.action === "WATCH")) {
      primaryActionType = "avoid";
      rationale = "Near resolution; limited time for thesis to play out.";
      if (!timingNote) timingNote = `Resolves in ${Math.round(timeToRes!)} days.`;
    } else {
      primaryActionType = "avoid";
      rationale = base.blockedReason;
      portfolioImpact = "No change; blocked.";
    }
  } else if (base.action === "STRONG_BUY" || base.action === "BUY_SMALL") {
    if (themePct >= DUPLICATE_THEME_CAP_PCT) {
      primaryActionType = "avoid";
      rationale = `You already have ${themePct.toFixed(0)}% in this theme; adding duplicates exposure.`;
      portfolioImpact = "Would increase theme concentration.";
    } else if (nearResolution) {
      primaryActionType = "monitor";
      rationale = `Edge ${(edge * 100).toFixed(1)}% but resolves soon; consider smaller size.`;
      portfolioImpact = "Adds exposure with short time to resolution.";
      if (!timingNote) timingNote = `Resolves in ${Math.round(timeToRes!)} days.`;
    } else {
      primaryActionType = "add";
      rationale = `Edge ${(edge * 100).toFixed(1)}%, confidence ${(confidence * 100).toFixed(0)}%. Diversifies from top concentration.`;
      portfolioImpact =
        themePct > 0
          ? `Adds to theme (${themePct.toFixed(0)}% current).`
          : "Adds new theme exposure.";
    }
  } else {
    primaryActionType = "monitor";
    rationale =
      base.action === "WATCH"
        ? `Edge ${(edge * 100).toFixed(1)}%; watch for better entry.`
        : base.blockedReason ?? "Insufficient edge for action.";
    portfolioImpact = "No change.";
  }

  let priorityScore = parseNum(base.priorityScore);
  if (primaryActionType === "avoid" && (themePct >= OVERLAP_AVOID_PCT || categoryPct >= OVERLAP_AVOID_PCT)) {
    priorityScore *= 0.3;
  }
  if (primaryActionType === "sync_first") {
    priorityScore *= 0.2;
  }
  if (nearResolution && primaryActionType === "add") {
    priorityScore *= 0.7;
  }

  return {
    ...base,
    priorityScore: toStr(Math.max(0, priorityScore)),
    primaryActionType,
    rationale,
    portfolioImpact,
    riskNote,
    timingNote,
    qualityBlocker,
  };
}
