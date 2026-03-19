/**
 * Map freshness / runtime-policy raw reasons to calibration subtypes.
 * Deterministic; used for grouping shadow outcomes.
 */

import type { RuntimePolicySubtype } from "./types";

const STALE_MARKET_RAW = new Set([
  "market_data_stale",
  "freshness:market_data_stale",
  "market_stale",
]);
const STALE_USER_RAW = new Set([
  "user_data_stale",
  "freshness:user_data_stale",
]);
const STALE_RECONCILIATION_RAW = new Set([
  "reconciliation_stale",
  "freshness:reconciliation_stale",
  "reconciliation_drift",
]);
const STALE_DECISION_RAW = new Set([
  "decision_snapshot_stale",
  "stale_decision_snapshot",
]);
const RUNTIME_PHASE_RAW = new Set([
  "runtime_not_ready",
  "runtime_rebuilding",
  "runtime_reconciling",
  "freshness:runtime_not_ready",
]);
const RUNTIME_SAFETY_RAW = new Set([
  "runtime_safety_blocked",
  "blocked",
  "guardrail_blocked",
]);
const KILL_SWITCH_RAW = new Set([
  "kill_switch_global",
  "kill_switch_asset",
  "watchdog_kill_switch",
]);
const EXCHANGE_TRUTH_RAW = new Set([
  "exchange_truth_unavailable",
  "exchange_truth_stale",
  "exchange_truth_unverified",
  "exchange_truth_orders_stale",
  "exchange_truth_fills_stale",
]);
const REPLAY_BACKLOG_RAW = new Set(["replay_backlog", "fill_replay_backlog"]);
const RUNTIME_ERROR_RAW = new Set(["runtime_error", "runtime_errors"]);

function normalizeRaw(s: string): string {
  return String(s).trim().toLowerCase();
}

/** Map a single raw reason to a runtime-policy subtype, or null if not freshness/policy-related. */
export function runtimePolicySubtypeFromRaw(raw: string): RuntimePolicySubtype | null {
  const s = normalizeRaw(raw);
  if (!s) return null;

  if (STALE_MARKET_RAW.has(s)) return "stale_market_data";
  if (s.includes("market_data_stale") || s.includes("market_stale")) return "stale_market_data";

  if (STALE_USER_RAW.has(s)) return "stale_user_feed";
  if (s.includes("user_data_stale")) return "stale_user_feed";

  if (s.includes("portfolio") && s.includes("stale")) return "stale_portfolio_truth";

  if (STALE_RECONCILIATION_RAW.has(s)) return "stale_reconciliation";
  if (s.includes("reconciliation_stale") || s.includes("reconciliation_drift")) return "stale_reconciliation";

  if (STALE_DECISION_RAW.has(s)) return "stale_decision_snapshot";
  if (s.includes("decision_snapshot") || s.includes("stale_decision")) return "stale_decision_snapshot";

  if (RUNTIME_PHASE_RAW.has(s)) return "runtime_phase_block";
  if (s.includes("runtime_rebuilding") || s.includes("runtime_reconciling") || s.includes("runtime_not_ready") || s.includes("starting")) return "runtime_phase_block";

  if (KILL_SWITCH_RAW.has(s)) return "runtime_safety_kill_switch";
  if (s.includes("kill_switch") || s.includes("watchdog_kill")) return "runtime_safety_kill_switch";

  if (RUNTIME_SAFETY_RAW.has(s)) return "runtime_safety_blocked";
  if (s.includes("runtime_safety") && s.includes("blocked")) return "runtime_safety_blocked";

  if (EXCHANGE_TRUTH_RAW.has(s)) return "exchange_truth_unavailable";
  if (s.includes("exchange_truth")) return "exchange_truth_unavailable";

  if (REPLAY_BACKLOG_RAW.has(s)) return "replay_backlog";
  if (s.includes("replay_backlog")) return "replay_backlog";

  if (RUNTIME_ERROR_RAW.has(s)) return "runtime_error";
  if (s.includes("runtime_error")) return "runtime_error";

  if (s.startsWith("freshness:")) {
    const rest = s.slice("freshness:".length);
    if (rest.includes("market")) return "stale_market_data";
    if (rest.includes("user")) return "stale_user_feed";
    if (rest.includes("reconciliation")) return "stale_reconciliation";
    if (rest.includes("decision") || rest.includes("snapshot")) return "stale_decision_snapshot";
    if (rest.includes("runtime")) return "runtime_phase_block";
    return "other_freshness_policy";
  }

  if (s.includes("stale") || s.includes("freshness")) {
    if (s.includes("quote_stale") || s.includes("missing_quote")) return null;
    return "other_freshness_policy";
  }

  return null;
}

/** Extract runtime-policy subtypes from blocking reasons. */
export function subtypesFromBlockingReasons(rawReasons: unknown): RuntimePolicySubtype[] {
  const arr = Array.isArray(rawReasons) ? rawReasons : rawReasons != null ? [String(rawReasons)] : [];
  const set = new Set<RuntimePolicySubtype>();
  for (const r of arr) {
    const sub = runtimePolicySubtypeFromRaw(String(r).trim());
    if (sub != null) set.add(sub);
  }
  return Array.from(set);
}

/** Check if any blocking reason is freshness / runtime-policy related. */
export function hasRuntimePolicyBlock(blockingReasons: unknown): boolean {
  const arr = Array.isArray(blockingReasons) ? blockingReasons : [];
  for (const r of arr) {
    if (runtimePolicySubtypeFromRaw(String(r)) != null) return true;
  }
  return false;
}
