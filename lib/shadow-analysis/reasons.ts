/**
 * Deterministic normalization of blocking reasons into groups for calibration analysis.
 * Raw reasons are preserved in samples; this only assigns a group label.
 */

export const REASON_GROUP = {
  EXECUTION_QUALITY: "execution_quality",
  EXECUTION_POLICY_FRESHNESS: "execution_policy_freshness",
  EXECUTION_POLICY_EXPOSURE: "execution_policy_exposure",
  EXECUTION_POLICY_LIQUIDITY: "execution_policy_liquidity",
  EXECUTION_POLICY_PRICING: "execution_policy_pricing",
  EXECUTION_POLICY_OPERATIONAL: "execution_policy_operational",
  EXECUTION_POLICY_RECOMMENDATION: "execution_policy_recommendation",
  GUARDRAIL_FRESHNESS: "guardrail_freshness",
  GUARDRAIL_LIQUIDITY: "guardrail_liquidity",
  GUARDRAIL_EXPOSURE: "guardrail_exposure",
  GUARDRAIL_OPERATIONAL: "guardrail_operational",
  GUARDRAIL_MARKET_HEALTH: "guardrail_market_health",
  CONCENTRATION: "concentration",
  RUNTIME_SAFETY: "runtime_safety",
  RECOMMENDATION: "recommendation",
  OTHER: "other",
} as const;

export type ReasonGroup = (typeof REASON_GROUP)[keyof typeof REASON_GROUP];

/** Map a single raw reason string to a normalized group. Deterministic and explicit. */
export function normalizeBlockingReason(raw: string): ReasonGroup {
  const s = String(raw).trim().toLowerCase();
  if (!s) return REASON_GROUP.OTHER;

  if (s.startsWith("execution_quality:")) return REASON_GROUP.EXECUTION_QUALITY;
  if (s.startsWith("freshness:")) return REASON_GROUP.EXECUTION_POLICY_FRESHNESS;
  if (s.startsWith("exposure:")) return REASON_GROUP.EXECUTION_POLICY_EXPOSURE;
  if (s.startsWith("liquidity:")) return REASON_GROUP.EXECUTION_POLICY_LIQUIDITY;
  if (s.startsWith("pricing:")) return REASON_GROUP.EXECUTION_POLICY_PRICING;
  if (s.startsWith("operational:")) return REASON_GROUP.EXECUTION_POLICY_OPERATIONAL;
  if (s.startsWith("recommendation:")) return REASON_GROUP.EXECUTION_POLICY_RECOMMENDATION;
  if (s.startsWith("concentration:") || s === "single_market" || s === "single_theme") return REASON_GROUP.CONCENTRATION;

  if (
    s.includes("concentration") ||
    s.includes("single_market") ||
    s.includes("single_theme") ||
    s.includes("exposure_total_breach") ||
    s.includes("exposure_per_asset") ||
    s.includes("working_orders_breach") ||
    s.includes("inventory_per_asset")
  ) {
    if (s.startsWith("exposure:")) return REASON_GROUP.EXECUTION_POLICY_EXPOSURE;
    if (
      s === "exposure_total_breach" ||
      s === "exposure_per_asset_breach" ||
      s === "working_orders_breach" ||
      s === "inventory_per_asset_breach"
    )
      return REASON_GROUP.GUARDRAIL_EXPOSURE;
  }

  if (
    s === "market_data_stale" ||
    s === "user_data_stale" ||
    s === "reconciliation_stale" ||
    s === "runtime_rebuilding" ||
    s === "runtime_reconciling" ||
    s === "exchange_truth_unverified" ||
    s === "exchange_truth_stale" ||
    s === "exchange_truth_unavailable" ||
    s === "exchange_truth_orders_stale" ||
    s === "exchange_truth_fills_stale"
  )
    return REASON_GROUP.GUARDRAIL_FRESHNESS;

  if (
    s === "liquidity_below_threshold" ||
    s === "spread_below_threshold" ||
    s === "not_tradable"
  )
    return REASON_GROUP.GUARDRAIL_LIQUIDITY;

  if (
    s === "kill_switch_global" ||
    s === "kill_switch_asset" ||
    s === "watchdog_kill_switch" ||
    s === "exchange_unhealthy" ||
    s === "degraded_safe_mode" ||
    s === "asset_execution_frozen" ||
    s === "execution_verification_required" ||
    s === "submit_ambiguous" ||
    s === "cancel_ambiguous" ||
    s === "replace_ambiguous"
  )
    return REASON_GROUP.GUARDRAIL_OPERATIONAL;

  if (
    s === "market_stale" ||
    s === "market_degraded" ||
    s === "market_health_unknown" ||
    s === "position_degraded" ||
    s === "position_reconciling"
  )
    return REASON_GROUP.GUARDRAIL_MARKET_HEALTH;

  if (
    s === "quote_stale" ||
    s === "stale_quote" ||
    s === "spread_too_wide" ||
    s === "insufficient_depth" ||
    s === "missing_quote" ||
    s === "missing_best_ask" ||
    s === "missing_best_bid" ||
    s === "crossed_book" ||
    s === "intended_price_far_from_market" ||
    s === "estimated_slippage_high" ||
    s === "liquidity_below_threshold" ||
    s === "not_tradable"
  )
    return REASON_GROUP.EXECUTION_QUALITY;

  if (s.includes("runtime_safety") || s.includes("kill_switch") || s.includes("blocked"))
    return REASON_GROUP.RUNTIME_SAFETY;

  if (s.includes("blocked_reason") || s.includes("recommendation_blocked"))
    return REASON_GROUP.RECOMMENDATION;

  return REASON_GROUP.OTHER;
}

/** Normalize an array of raw reasons; returns unique groups and preserves raw samples per group. */
export function normalizeBlockingReasons(
  rawReasons: unknown
): { groups: ReasonGroup[]; rawByGroup: Record<string, string[]> } {
  const arr = Array.isArray(rawReasons) ? rawReasons : rawReasons != null ? [String(rawReasons)] : [];
  const groups: ReasonGroup[] = [];
  const rawByGroup: Record<string, string[]> = {};
  const seenGroup = new Set<string>();
  for (const r of arr) {
    const raw = String(r).trim();
    if (!raw) continue;
    const group = normalizeBlockingReason(raw);
    if (!seenGroup.has(group)) {
      seenGroup.add(group);
      groups.push(group);
    }
    if (!rawByGroup[group]) rawByGroup[group] = [];
    if (!rawByGroup[group].includes(raw)) rawByGroup[group].push(raw);
  }
  return { groups, rawByGroup };
}
