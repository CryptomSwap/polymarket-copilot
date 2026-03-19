/**
 * Map portfolio-risk / concentration raw reasons to calibration subtypes.
 * Deterministic; used for grouping shadow outcomes.
 */

import type { PortfolioRiskSubtype } from "./types";

const TOTAL_EXPOSURE_RAW = new Set([
  "exposure_total_breach",
  "exposure:exposure_total_breach",
  "total_exposure_breach",
]);
const SINGLE_MARKET_RAW = new Set([
  "single_market_concentration_breach",
  "single_market",
  "market_concentration_breach",
  "exposure:single_market_concentration_breach",
  "concentration:single_market",
]);
const SINGLE_THEME_RAW = new Set([
  "single_theme_concentration_breach",
  "single_theme",
  "theme_concentration_breach",
  "exposure:single_theme_concentration_breach",
  "concentration:single_theme",
]);
const NEAR_RESOLUTION_RAW = new Set([
  "near_resolution_concentration",
  "near_resolution_exposure",
  "near_resolution",
]);
const ILLIQUID_RAW = new Set(["illiquid_exposure", "illiquid", "liquidity_context_missing"]);
const CORRELATED_RAW = new Set(["correlated_exposure", "correlated", "cluster_concentration"]);
const PORTFOLIO_FIT_RAW = new Set([
  "high concentration",
  "theme concentration",
  "portfolio_fit",
  "portfolio_fit_penalty",
  "concentration_penalty",
]);
const BEHAVIOR_CONFLICT_RAW = new Set(["behavior_conflict", "conflict", "trim before automation"]);

function normalizeRaw(s: string): string {
  return String(s).trim().toLowerCase();
}

/** Map a single raw reason to a portfolio-risk subtype, or null if not risk-related. */
export function portfolioRiskSubtypeFromRaw(raw: string): PortfolioRiskSubtype | null {
  const s = normalizeRaw(raw);
  if (!s) return null;

  if (TOTAL_EXPOSURE_RAW.has(s)) return "total_exposure";
  if (s.includes("exposure_total") || s.includes("total_exposure_breach")) return "total_exposure";

  if (SINGLE_MARKET_RAW.has(s)) return "single_market_concentration";
  if (s.includes("single_market") || s.includes("market_concentration")) return "single_market_concentration";

  if (SINGLE_THEME_RAW.has(s)) return "single_theme_concentration";
  if (s.includes("single_theme") || s.includes("theme_concentration")) return "single_theme_concentration";
  if (s.includes("theme concentration") && s.includes("exceeds limit")) return "single_theme_concentration";

  if (NEAR_RESOLUTION_RAW.has(s)) return "near_resolution_exposure";
  if (s.includes("near_resolution")) return "near_resolution_exposure";

  if (ILLIQUID_RAW.has(s)) return "illiquid_exposure";
  if (s.includes("illiquid")) return "illiquid_exposure";

  if (CORRELATED_RAW.has(s)) return "correlated_exposure";
  if (s.includes("correlated")) return "correlated_exposure";

  if (PORTFOLIO_FIT_RAW.has(s)) return "portfolio_fit_penalty";
  if (s.includes("high concentration") || s.includes("concentration penalty")) return "portfolio_fit_penalty";

  if (BEHAVIOR_CONFLICT_RAW.has(s)) return "behavior_conflict";

  if (
    s.includes("concentration") ||
    s.includes("exposure") && (s.includes("breach") || s.includes("limit"))
  ) {
    if (s.includes("market")) return "single_market_concentration";
    if (s.includes("theme")) return "single_theme_concentration";
    if (s.includes("total")) return "total_exposure";
    return "other_portfolio_risk";
  }

  return null;
}

/** Extract portfolio-risk subtypes from blocking reasons. */
export function subtypesFromBlockingReasons(rawReasons: unknown): PortfolioRiskSubtype[] {
  const arr = Array.isArray(rawReasons) ? rawReasons : rawReasons != null ? [String(rawReasons)] : [];
  const set = new Set<PortfolioRiskSubtype>();
  for (const r of arr) {
    const sub = portfolioRiskSubtypeFromRaw(String(r).trim());
    if (sub != null) set.add(sub);
  }
  return Array.from(set);
}

/** Check if any blocking reason is portfolio-risk / concentration related. */
export function hasPortfolioRiskBlock(blockingReasons: unknown): boolean {
  const arr = Array.isArray(blockingReasons) ? blockingReasons : [];
  for (const r of arr) {
    if (portfolioRiskSubtypeFromRaw(String(r)) != null) return true;
  }
  return false;
}

/** Extract risk subtypes from portfolio risk snapshot (concentrationFlags, riskFlags). */
export function subtypesFromPortfolioRiskSnapshot(snapshotJson: string | null | undefined): PortfolioRiskSubtype[] {
  if (!snapshotJson) return [];
  try {
    const o = JSON.parse(snapshotJson) as {
      concentrationFlags?: { code?: string }[];
      riskFlags?: { code?: string }[];
    };
    const set = new Set<PortfolioRiskSubtype>();
    for (const f of o?.concentrationFlags ?? []) {
      const sub = portfolioRiskSubtypeFromRaw(f?.code ?? "");
      if (sub != null) set.add(sub);
    }
    for (const f of o?.riskFlags ?? []) {
      const sub = portfolioRiskSubtypeFromRaw(f?.code ?? "");
      if (sub != null) set.add(sub);
    }
    return Array.from(set);
  } catch {
    return [];
  }
}
