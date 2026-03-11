/**
 * Read-only live strategy placeholder: evaluates real Market State, Position, Order, and Risk
 * inputs and emits conservative decisions with structured reason codes. No order execution.
 */

import type { AssetLiveState } from "../market-state/market-state-types";
import type { RuntimePositionState } from "../positions/runtime-position-store";
import type { RuntimeRiskState } from "../risk/runtime-risk-engine";
import type { RuntimeOrderState } from "../order-manager/order-manager";
import type { BotDecisionContext, BotDecisionOutput } from "./bot-decision-types";

/** Structured reason codes for telemetry and validation. */
export type BotDecisionReasonCode =
  | "stub"
  | "market_stale"
  | "market_degraded"
  | "market_not_tradable"
  | "kill_switch"
  | "asset_halted"
  | "inventory_threshold_exceeded"
  | "market_stale_cancel"
  | "spread_liquidity_favorable"
  | "no_signal"
  | "position_degraded";

export interface LiveStrategyPlaceholderConfig {
  /** Fraction of maxInventoryPerAsset above which we emit REDUCE_RISK (default 0.8). */
  inventoryThresholdFraction?: number;
  /** Min spread bps to consider UPDATE_QUOTES (default 5). */
  minSpreadBpsForQuotes?: number;
  /** Min liquidity quality score to consider UPDATE_QUOTES (default 0.3). */
  minLiquidityForQuotes?: number;
  /** Default size for UPDATE_QUOTES when no position (default 1). */
  defaultQuoteSize?: number;
}

const DEFAULT_CONFIG: Required<LiveStrategyPlaceholderConfig> = {
  inventoryThresholdFraction: 0.8,
  minSpreadBpsForQuotes: 5,
  minLiquidityForQuotes: 0.3,
  defaultQuoteSize: 1,
};

function getAssetState(ctx: BotDecisionContext): AssetLiveState | null {
  const a = ctx.assetLiveState;
  if (a != null && typeof a === "object" && "assetId" in a && "health" in a && "liquidity" in a) {
    return a as AssetLiveState;
  }
  return null;
}

function getPosition(ctx: BotDecisionContext): RuntimePositionState | null {
  const p = ctx.position;
  if (p != null && typeof p === "object" && "netShares" in p) return p as RuntimePositionState;
  return null;
}

function getRiskState(ctx: BotDecisionContext): RuntimeRiskState | null {
  const r = ctx.riskState;
  if (r != null && typeof r === "object" && "limits" in r && "globalAutomationEnabled" in r) return r as RuntimeRiskState;
  return null;
}

function getOpenOrders(ctx: BotDecisionContext): RuntimeOrderState[] {
  const o = ctx.openOrders;
  return Array.isArray(o) ? (o as RuntimeOrderState[]) : [];
}

/**
 * Evaluate context and return a single conservative decision with a structured reason code.
 * Read-only: no side effects, no order placement.
 */
export function evaluateLiveStrategyPlaceholder(
  context: BotDecisionContext,
  config?: LiveStrategyPlaceholderConfig
): BotDecisionOutput {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const assetId = context.assetId ?? "";
  const marketId = (context.assetLiveState != null && typeof context.assetLiveState === "object" && "market" in context.assetLiveState)
    ? (context.assetLiveState as AssetLiveState).market?.marketId ?? undefined
    : undefined;

  const asset = getAssetState(context);
  const position = getPosition(context);
  const risk = getRiskState(context);
  const openOrders = getOpenOrders(context);

  // --- Risk gating ---
  if (risk) {
    if (!risk.globalAutomationEnabled) {
      return { action: "NOOP", assetId, marketId, reason: "kill_switch" };
    }
    if (risk.haltedAssetIds?.includes(assetId)) {
      return { action: "NOOP", assetId, marketId, reason: "asset_halted" };
    }
  }

  // --- Market health: no action unless fresh and tradable ---
  if (asset) {
    const health = asset.health;
    const liquidity = asset.liquidity;
    if (health?.isStale) {
      if (openOrders.length > 0) {
        return { action: "CANCEL_ORDERS", assetId, marketId, reason: "market_stale_cancel" };
      }
      return { action: "NOOP", assetId, marketId, reason: "market_stale" };
    }
    if (health?.isDegraded) {
      if (openOrders.length > 0) {
        return { action: "CANCEL_ORDERS", assetId, marketId, reason: "market_stale_cancel" };
      }
      return { action: "NOOP", assetId, marketId, reason: "market_degraded" };
    }
    if (liquidity?.isTradable === false) {
      return { action: "NOOP", assetId, marketId, reason: "market_not_tradable" };
    }
  } else {
    return { action: "NOOP", assetId, marketId, reason: "no_signal" };
  }

  // --- Position confidence ---
  if (position?.confidence === "degraded") {
    return { action: "NOOP", assetId, marketId, reason: "position_degraded" };
  }

  // --- Inventory threshold → REDUCE_RISK ---
  const maxInv = risk?.limits?.maxInventoryPerAsset ?? 10_000;
  const threshold = maxInv * cfg.inventoryThresholdFraction;
  const absNet = position ? Math.abs(position.netShares) : 0;
  if (absNet >= threshold) {
    return { action: "REDUCE_RISK", assetId, marketId, reason: "inventory_threshold_exceeded" };
  }

  // --- Favorable spread/liquidity → UPDATE_QUOTES (conservative quote at mid) ---
  const quote = asset!.quote;
  const spreadBps = quote?.spreadBps ?? null;
  const qualityScore = asset!.liquidity?.qualityScore ?? null;
  const mid = quote?.mid ?? quote?.bestBid ?? quote?.bestAsk ?? null;

  if (
    spreadBps != null && spreadBps >= cfg.minSpreadBpsForQuotes &&
    qualityScore != null && qualityScore >= cfg.minLiquidityForQuotes &&
    mid != null && Number.isFinite(mid)
  ) {
    const size = cfg.defaultQuoteSize;
    return {
      action: "UPDATE_QUOTES",
      assetId,
      marketId,
      side: "BUY",
      size,
      limitPrice: mid,
      reason: "spread_liquidity_favorable",
      intentId: `live_${assetId}_${context.asOf?.getTime() ?? 0}`,
    };
  }

  return { action: "NOOP", assetId, marketId, reason: "no_signal" };
}
