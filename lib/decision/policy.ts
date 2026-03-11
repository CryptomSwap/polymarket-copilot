/**
 * Policy state and size guidance. Hard blocks remain authoritative; ML cannot override.
 * Advisory only; no autonomous trading.
 */

import type { ReasoningBreakdown } from "./blend";

export type PolicyState =
  | "BLOCK"
  | "REVIEW_REQUIRED"
  | "ALLOW_SMALL"
  | "ALLOW_NORMAL"
  | "ALLOW_HIGH_CONVICTION"
  | "TRIM"
  | "EXIT";

export interface PolicyInput {
  action: string;
  blockedReason: string | null;
  blendedScore: number;
  reasoning: ReasoningBreakdown;
  themeExposurePct: number;
  topConcentrationPct: number;
  hasExistingPosition: boolean;
  suggestedSizeFromRec: number;
  reviewStatus: string;
  /** Signal type for chase/late detection. */
  signalType: string | null;
}

export interface PolicyResult {
  policyState: PolicyState;
  sizeMultiplier: number;
  finalSuggestedSize: number;
  blockReason: string | null;
}

const CONCENTRATION_BLOCK_PCT = 50;
const THEME_WARN_PCT = 40;
const CHASE_TYPES = ["LATE_CHASE", "CHASING"];

/**
 * Apply hard rules first; then map to policy state and size. ML cannot upgrade a blocked recommendation.
 */
export function applyPolicy(input: PolicyInput): PolicyResult {
  const {
    action,
    blockedReason,
    blendedScore,
    reasoning,
    themeExposurePct,
    topConcentrationPct,
    hasExistingPosition,
    suggestedSizeFromRec,
    reviewStatus,
    signalType,
  } = input;

  let blockReason: string | null = null;
  if (blockedReason) blockReason = blockedReason;
  if (topConcentrationPct >= CONCENTRATION_BLOCK_PCT && action !== "TRIM" && action !== "EXIT") {
    blockReason = blockReason ?? `Concentration ${topConcentrationPct.toFixed(0)}% exceeds limit.`;
  }
  if (reasoning.blockers.some((b) => b.toLowerCase().includes("chase") || b.toLowerCase().includes("late"))) {
    blockReason = blockReason ?? "Chase/late setup; review required.";
  }
  if (signalType && CHASE_TYPES.includes(signalType) && blendedScore < 0.6) {
    blockReason = blockReason ?? "Chase setup with low conviction.";
  }

  if (blockReason) {
    const state: PolicyState = blockReason.toLowerCase().includes("review") ? "REVIEW_REQUIRED" : "BLOCK";
    return {
      policyState: state,
      sizeMultiplier: 0,
      finalSuggestedSize: 0,
      blockReason,
    };
  }

  if (action === "EXIT") {
    return {
      policyState: "EXIT",
      sizeMultiplier: 1,
      finalSuggestedSize: Math.min(1, suggestedSizeFromRec),
      blockReason: null,
    };
  }
  if (action === "TRIM") {
    return {
      policyState: "TRIM",
      sizeMultiplier: 0.8,
      finalSuggestedSize: Math.min(0.5, suggestedSizeFromRec * 0.8),
      blockReason: null,
    };
  }

  if (action === "NO_TRADE" || action === "WATCH") {
    return {
      policyState: blendedScore >= 0.5 ? "REVIEW_REQUIRED" : "BLOCK",
      sizeMultiplier: 0,
      finalSuggestedSize: 0,
      blockReason: action === "NO_TRADE" ? "No-trade recommendation." : null,
    };
  }

  let sizeMultiplier = 1;
  if (themeExposurePct > 25) sizeMultiplier *= 0.7;
  if (topConcentrationPct > 35) sizeMultiplier *= 0.6;
  if (reviewStatus !== "APPROVED") sizeMultiplier *= 0.8;
  if (reasoning.mlScore != null && Math.abs(reasoning.heuristicScore - reasoning.mlScore) > 0.25 && reasoning.mlScore < reasoning.heuristicScore) {
    sizeMultiplier *= 0.7;
  }
  if (reasoning.supportive.some((s) => s.includes("ML support"))) sizeMultiplier = Math.min(1.1, sizeMultiplier + 0.1);
  if (reasoning.supportive.some((s) => s.includes("Catalyst"))) sizeMultiplier = Math.min(1.1, sizeMultiplier + 0.05);
  if (reasoning.supportive.some((s) => s.includes("setup history"))) sizeMultiplier = Math.min(1.1, sizeMultiplier + 0.05);
  sizeMultiplier = Math.max(0.2, Math.min(1.2, sizeMultiplier));

  const finalSize = suggestedSizeFromRec * sizeMultiplier;

  let policyState: PolicyState;
  if (blendedScore >= 0.7 && sizeMultiplier >= 0.9 && reviewStatus === "APPROVED") {
    policyState = "ALLOW_HIGH_CONVICTION";
  } else if (blendedScore >= 0.5 && finalSize > 0) {
    policyState = finalSize <= 0.3 ? "ALLOW_SMALL" : "ALLOW_NORMAL";
  } else if (blendedScore >= 0.4) {
    policyState = "REVIEW_REQUIRED";
  } else {
    policyState = "BLOCK";
  }

  return {
    policyState,
    sizeMultiplier,
    finalSuggestedSize: Math.max(0, Math.min(1, finalSize)),
    blockReason: null,
  };
}
