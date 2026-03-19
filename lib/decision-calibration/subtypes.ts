/**
 * Map decision-stage outputs and blocking reasons to calibration subtypes.
 * Deterministic; uses reasoningBreakdown, policyState, sizeMultiplier, and raw block reasons.
 */

import type { DecisionStageSubtype } from "./types";

/** Staged decision snapshot shape (from reasoningJson / decisionSnapshotJson when present). */
export interface DecisionSnapshotLike {
  blockers?: string[];
  edgeReasons?: string[];
  marketQualityReasons?: string[];
  portfolioFitReasons?: string[];
  sizingReasons?: string[];
  policyState?: string;
  blockReason?: string | null;
  sizeMultiplier?: number;
  blendedScore?: number;
  finalSuggestedSize?: number;
}

function normalizeRaw(s: string): string {
  return String(s).trim().toLowerCase();
}

/** Map raw block reason (e.g. from execution policy "recommendation:...") to decision-stage subtype. */
export function decisionSubtypeFromBlockReason(raw: string): DecisionStageSubtype | null {
  const s = normalizeRaw(raw);
  if (!s) return null;
  if (s.startsWith("recommendation:") || s.includes("blocked_reason") || s.includes("review required")) return "eligibility_block";
  if (s.includes("theme concentration") && s.includes("exceeds limit")) return "poor_portfolio_fit";
  if (s.includes("market quality") || s.includes("liquidity too low")) return "poor_market_quality";
  if (s.includes("portfolio fit") || s.includes("high concentration")) return "poor_portfolio_fit";
  return null;
}

/** Extract subtypes from a parsed decision snapshot (reasoningBreakdown, policyState, sizeMultiplier). */
export function subtypesFromDecisionSnapshot(snapshot: DecisionSnapshotLike): DecisionStageSubtype[] {
  const set = new Set<DecisionStageSubtype>();
  const blockers = snapshot.blockers ?? [];
  const mqReasons = snapshot.marketQualityReasons ?? [];
  const pfReasons = snapshot.portfolioFitReasons ?? [];
  const sizingReasons = snapshot.sizingReasons ?? [];
  const policyState = (snapshot.policyState ?? "").toLowerCase();
  const blockReason = (snapshot.blockReason ?? "").toLowerCase();
  const sizeMultiplier = typeof snapshot.sizeMultiplier === "number" ? snapshot.sizeMultiplier : parseFloat(String(snapshot.sizeMultiplier));
  const finalSize =
    snapshot.finalSuggestedSize != null && typeof snapshot.finalSuggestedSize === "number"
      ? snapshot.finalSuggestedSize
      : snapshot.finalSuggestedSize != null
        ? parseFloat(String(snapshot.finalSuggestedSize))
        : NaN;
  const blendedScore = typeof snapshot.blendedScore === "number" ? snapshot.blendedScore : parseFloat(String(snapshot.blendedScore ?? 0));

  if (blockers.length > 0) set.add("eligibility_block");

  if (Number.isFinite(blendedScore)) {
    if (blendedScore >= 0.65) set.add("high_conviction_edge");
    else if (blendedScore >= 0.45) set.add("medium_conviction_edge");
    else if (blendedScore > 0 && blendedScore < 0.25) set.add("low_conviction_edge");
  }

  for (const r of mqReasons) {
    const t = normalizeRaw(r);
    if (t.includes("liquidity too low") || t.includes("market crowded")) set.add("poor_market_quality");
    else if (t.includes("moderate liquidity") || t.includes("saturation")) set.add("borderline_market_quality");
  }
  if (mqReasons.length > 0 && !set.has("poor_market_quality")) set.add("borderline_market_quality");

  for (const r of pfReasons) {
    const t = normalizeRaw(r);
    if (t.includes("high concentration") || t.includes("high theme") || t.includes("behavior flags") || t.includes("portfolio overconcentrated")) set.add("poor_portfolio_fit");
    else if (t.includes("moderate") || t.includes("low concentration")) set.add("portfolio_fit_penalty");
  }

  if (Number.isFinite(sizeMultiplier)) {
    if (sizeMultiplier <= 0 || (Number.isFinite(finalSize) && finalSize <= 0)) set.add("size_zero");
    else if (sizeMultiplier < 1) set.add("size_reduced");
  }

  for (const r of sizingReasons) {
    const t = normalizeRaw(r);
    if (t.includes("exit") || t.includes("trim")) set.add("exit_trim_logic");
    if (t.includes("no-trade") || t.includes("watch only")) set.add("size_zero");
  }

  if (policyState === "exit" || policyState === "trim") set.add("exit_trim_logic");
  if (blockReason.includes("theme concentration") && blockReason.includes("exceeds")) set.add("poor_portfolio_fit");

  return Array.from(set);
}

/** Check if blocking reasons indicate decision-stage (recommendation) block. */
export function hasDecisionStageBlock(blockingReasons: unknown): boolean {
  const arr = Array.isArray(blockingReasons) ? blockingReasons : [];
  for (const r of arr) {
    const s = normalizeRaw(String(r));
    if (s.startsWith("recommendation:") || s.includes("blocked_reason") || s.includes("review required")) return true;
    if (s.includes("theme concentration") && s.includes("exceeds limit")) return true;
  }
  return false;
}

/** Parse decisionSnapshotJson and return subtypes; returns [] on parse error or null. */
export function subtypesFromDecisionSnapshotJson(json: string | null | undefined): DecisionStageSubtype[] {
  if (!json) return [];
  try {
    const o = JSON.parse(json) as DecisionSnapshotLike;
    return subtypesFromDecisionSnapshot(o);
  } catch {
    return [];
  }
}
