/**
 * Conservative execution-quality evaluation: spread, depth, quote freshness, slippage estimate.
 * Blocks or warns on unsafe execution conditions. Does not fake precision; missing data → block or warn.
 */

import type { ExecutionQualityInput, ExecutionQualityResult, QuoteFreshnessState } from "./types";
import { getExecutionQualityThresholds } from "./config";

function safeNum(v: number | null | undefined): number | null {
  if (v == null) return null;
  return Number.isFinite(v) ? v : null;
}

function spreadBpsFromQuote(bestBid: number | null, bestAsk: number | null): number | null {
  const bid = safeNum(bestBid);
  const ask = safeNum(bestAsk);
  if (bid == null || ask == null || ask <= bid) return null;
  const mid = (bid + ask) / 2;
  if (mid <= 0 || !Number.isFinite(mid)) return null;
  return ((ask - bid) / mid) * 10_000;
}

function spreadAbs(bestBid: number | null, bestAsk: number | null): number | null {
  const bid = safeNum(bestBid);
  const ask = safeNum(bestAsk);
  if (bid == null || ask == null) return null;
  const s = ask - bid;
  return Number.isFinite(s) ? s : null;
}

/**
 * Rough slippage estimate (bps) when taking liquidity: for BUY we pay at least bestAsk, for SELL we receive at most bestBid.
 * Uses mid as reference; result is approximate.
 */
function roughSlippageBps(
  side: "BUY" | "SELL",
  bestBid: number | null,
  bestAsk: number | null
): number | null {
  const bid = safeNum(bestBid);
  const ask = safeNum(bestAsk);
  if (bid == null || ask == null) return null;
  const mid = (bid + ask) / 2;
  if (mid <= 0 || !Number.isFinite(mid)) return null;
  if (side === "BUY" && ask > 0) {
    return ((ask - mid) / mid) * 10_000;
  }
  if (side === "SELL" && bid > 0) {
    return ((mid - bid) / mid) * 10_000;
  }
  return null;
}

export function evaluateExecutionQuality(input: ExecutionQualityInput): ExecutionQualityResult {
  const cfg = getExecutionQualityThresholds();
  const evaluatedAt = new Date().toISOString();
  const blockingReasons: string[] = [];
  const warnings: string[] = [];

  const bestBid = safeNum(input.bestBid);
  const bestAsk = safeNum(input.bestAsk);
  const bidDepth = safeNum(input.bidDepth);
  const askDepth = safeNum(input.askDepth);
  const intendedPrice = safeNum(input.intendedPrice);
  const intendedSize = safeNum(input.intendedSize) ?? 0;

  const spread = spreadAbs(bestBid, bestAsk);
  const spreadBps = input.spreadBps != null && Number.isFinite(input.spreadBps)
    ? input.spreadBps
    : spreadBpsFromQuote(bestBid, bestAsk);

  let quoteFreshnessState: QuoteFreshnessState = "unknown";
  if (input.quoteAgeMs != null && Number.isFinite(input.quoteAgeMs)) {
    if (input.quoteAgeMs > cfg.staleQuoteBlockMs) {
      quoteFreshnessState = "stale";
      blockingReasons.push("quote_stale");
    } else if (input.quoteAgeMs > cfg.staleQuoteWarnMs) {
      quoteFreshnessState = "stale";
      warnings.push("quote_age_degraded");
    } else {
      quoteFreshnessState = "fresh";
    }
  } else if (bestBid == null && bestAsk == null) {
    quoteFreshnessState = "missing";
    blockingReasons.push("missing_quote");
  }

  if (input.isTradable === false) {
    blockingReasons.push("not_tradable");
  }

  const needBid = input.side === "SELL";
  const needAsk = input.side === "BUY";
  if (needAsk && bestAsk == null) {
    blockingReasons.push("missing_best_ask");
  }
  if (needBid && bestBid == null) {
    blockingReasons.push("missing_best_bid");
  }

  if (bestBid != null && bestAsk != null && bestBid >= bestAsk) {
    blockingReasons.push("crossed_book");
  }

  if (spreadBps != null) {
    if (spreadBps >= cfg.spreadBlockBps) {
      blockingReasons.push("spread_too_wide");
    } else if (spreadBps >= cfg.spreadWarnBps) {
      warnings.push("wide_spread");
    }
  }

  let depthSufficiency: ExecutionQualityResult["depthSufficiency"] = "unknown";
  if (intendedSize > 0) {
    const sameSideDepth = input.side === "BUY" ? (askDepth ?? 0) : (bidDepth ?? 0);
    if (sameSideDepth <= 0) {
      depthSufficiency = "unknown";
      warnings.push("depth_unknown");
    } else if (sameSideDepth < intendedSize * cfg.minDepthBlockRatio) {
      depthSufficiency = "insufficient";
      blockingReasons.push("insufficient_depth");
    } else if (sameSideDepth < intendedSize * cfg.minDepthWarnRatio) {
      depthSufficiency = "insufficient";
      warnings.push("depth_low");
    } else {
      depthSufficiency = "sufficient";
    }
  }

  if (
    intendedPrice != null &&
    Number.isFinite(intendedPrice) &&
    bestBid != null &&
    bestAsk != null
  ) {
    const ref = input.side === "BUY" ? bestAsk : bestBid;
    const dist = Math.abs(intendedPrice - ref);
    if (dist > cfg.maxPriceDeviationPct) {
      blockingReasons.push("intended_price_far_from_market");
    }
  }

  const slippageBps = roughSlippageBps(input.side, bestBid, bestAsk);
  if (slippageBps != null) {
    if (slippageBps >= cfg.slippageBlockBps) {
      blockingReasons.push("estimated_slippage_high");
    } else if (slippageBps >= cfg.slippageWarnBps) {
      warnings.push("estimated_slippage_moderate");
    }
  }

  if (
    input.liquidityScore != null &&
    Number.isFinite(input.liquidityScore)
  ) {
    if (input.liquidityScore < cfg.minLiquidityScoreBlock) {
      blockingReasons.push("liquidity_below_threshold");
    } else if (input.liquidityScore < cfg.minLiquidityScoreWarn) {
      warnings.push("liquidity_low");
    }
  }

  let estimatedFillQuality: ExecutionQualityResult["estimatedFillQuality"] = "unknown";
  if (slippageBps != null) {
    if (slippageBps >= cfg.slippageBlockBps) estimatedFillQuality = "high";
    else if (slippageBps >= cfg.slippageWarnBps) estimatedFillQuality = "moderate";
    else estimatedFillQuality = "low";
  }

  let qualityState: ExecutionQualityResult["qualityState"] = "good";
  if (blockingReasons.length > 0) qualityState = "block";
  else if (warnings.length > 0) qualityState = "warn";

  const tradable = qualityState !== "block";

  const midPrice =
    bestBid != null && bestAsk != null && bestAsk > bestBid ? (bestBid + bestAsk) / 2 : null;

  const snapshot = {
    evaluatedAt,
    qualityState,
    tradable,
    blockingReasons,
    warnings,
    spread: spread ?? null,
    spreadBps: spreadBps ?? null,
    bestBid,
    bestAsk,
    midPrice,
    intendedPrice: intendedPrice ?? null,
    depthSufficiency,
    quoteFreshnessState,
    estimatedSlippageBps: slippageBps ?? null,
    estimatedFillQuality,
  };

  return {
    tradable,
    qualityState,
    blockingReasons,
    warnings,
    estimatedSlippage: slippageBps != null ? slippageBps / 10_000 : null,
    estimatedFillQuality,
    spread: spread ?? null,
    spreadBps: spreadBps ?? null,
    depthSufficiency,
    quoteFreshnessState,
    evaluatedAt,
    snapshotJson: JSON.stringify(snapshot),
  };
}
