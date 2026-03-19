/**
 * Map execution-quality raw reasons and warnings to calibration subtypes.
 * Deterministic; used for grouping shadow outcomes.
 */

import type { ExecutionQualitySubtype } from "./types";

const STALE_QUOTE_RAW = new Set([
  "quote_stale", "stale_quote", "missing_quote", "quote_age_degraded",
  "execution_quality:quote_stale", "execution_quality:missing_quote",
]);
const SPREAD_WIDE_RAW = new Set([
  "spread_too_wide", "wide_spread",
  "execution_quality:spread_too_wide",
]);
const INSUFFICIENT_DEPTH_RAW = new Set([
  "insufficient_depth", "depth_low", "depth_unknown",
  "execution_quality:insufficient_depth",
]);
const SLIPPAGE_RAW = new Set([
  "estimated_slippage_high", "estimated_slippage_moderate",
  "execution_quality:estimated_slippage_high",
]);
const NOT_TRADABLE_RAW = new Set([
  "not_tradable", "missing_best_ask", "missing_best_bid", "crossed_book",
  "execution_quality:not_tradable", "execution_quality:missing_best_ask",
  "execution_quality:missing_best_bid", "execution_quality:crossed_book",
]);
const LOW_LIQUIDITY_RAW = new Set([
  "liquidity_below_threshold", "liquidity_low",
  "execution_quality:liquidity_below_threshold",
]);
const PRICE_FAR_RAW = new Set([
  "intended_price_far_from_market",
  "execution_quality:intended_price_far_from_market",
]);

function normalizeRaw(s: string): string {
  return String(s).trim().toLowerCase();
}

/** Map a single raw reason (block or warning) to an execution-quality subtype, or null if not eq-related. */
export function executionQualitySubtypeFromRaw(raw: string): ExecutionQualitySubtype | null {
  const s = normalizeRaw(raw);
  if (s.startsWith("execution_quality:")) {
    const rest = s.slice("execution_quality:".length);
    if (STALE_QUOTE_RAW.has(rest) || rest === "quote_stale" || rest === "missing_quote") return "stale_quote";
    if (SPREAD_WIDE_RAW.has(rest) || rest === "spread_too_wide") return "spread_too_wide";
    if (INSUFFICIENT_DEPTH_RAW.has(rest) || rest === "insufficient_depth" || rest === "depth_low") return "insufficient_depth";
    if (SLIPPAGE_RAW.has(rest) || rest === "estimated_slippage_high") return "slippage_too_high";
    if (NOT_TRADABLE_RAW.has(rest) || rest === "not_tradable" || rest === "missing_best_ask" || rest === "missing_best_bid" || rest === "crossed_book") return "not_tradable";
    if (LOW_LIQUIDITY_RAW.has(rest) || rest === "liquidity_below_threshold") return "low_liquidity_score";
    if (PRICE_FAR_RAW.has(rest) || rest === "intended_price_far_from_market") return "price_too_far_from_market";
    return "other";
  }
  if (STALE_QUOTE_RAW.has(s)) return "stale_quote";
  if (SPREAD_WIDE_RAW.has(s)) return "spread_too_wide";
  if (INSUFFICIENT_DEPTH_RAW.has(s)) return "insufficient_depth";
  if (SLIPPAGE_RAW.has(s)) return "slippage_too_high";
  if (NOT_TRADABLE_RAW.has(s)) return "not_tradable";
  if (LOW_LIQUIDITY_RAW.has(s)) return "low_liquidity_score";
  if (PRICE_FAR_RAW.has(s)) return "price_too_far_from_market";
  return null;
}

/** Extract execution-quality subtypes from blocking reasons (e.g. from policy or snapshot). */
export function subtypesFromBlockingReasons(rawReasons: unknown): ExecutionQualitySubtype[] {
  const arr = Array.isArray(rawReasons) ? rawReasons : rawReasons != null ? [String(rawReasons)] : [];
  const set = new Set<ExecutionQualitySubtype>();
  for (const r of arr) {
    const raw = String(r).trim();
    const sub = executionQualitySubtypeFromRaw(raw);
    if (sub != null) set.add(sub);
  }
  return Array.from(set);
}

/** Extract execution-quality subtypes from snapshot warnings (e.g. wide_spread, depth_low). */
export function subtypesFromWarnings(warnings: unknown): ExecutionQualitySubtype[] {
  const arr = Array.isArray(warnings) ? warnings : warnings != null ? [String(warnings)] : [];
  const set = new Set<ExecutionQualitySubtype>();
  for (const w of arr) {
    const raw = String(w).trim();
    const sub = executionQualitySubtypeFromRaw(raw);
    if (sub != null && sub !== "other") set.add(sub);
  }
  return Array.from(set);
}

/** Check if any blocking reason is execution-quality related (for filtering candidates). */
export function hasExecutionQualityBlock(blockingReasons: unknown): boolean {
  const arr = Array.isArray(blockingReasons) ? blockingReasons : [];
  for (const r of arr) {
    if (executionQualitySubtypeFromRaw(String(r)) != null) return true;
  }
  return false;
}

/** Check if snapshot has execution-quality warnings (allowed-with-warning cohort). */
export function snapshotHasEqWarnings(executionQualitySnapshotJson: string | null | undefined): boolean {
  if (!executionQualitySnapshotJson) return false;
  try {
    const o = JSON.parse(executionQualitySnapshotJson) as { warnings?: unknown[] };
    return Array.isArray(o?.warnings) && o.warnings.length > 0;
  } catch {
    return false;
  }
}
