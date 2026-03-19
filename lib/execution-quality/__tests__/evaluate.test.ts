/**
 * Execution quality evaluator tests: good market, missing quote, crossed book, stale, spread, depth, slippage, policy integration.
 */

import { evaluateExecutionQuality } from "../evaluate";
import type { ExecutionQualityInput } from "../types";

function check(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function baseInput(overrides: Partial<ExecutionQualityInput> = {}): ExecutionQualityInput {
  return {
    assetId: "a1",
    marketId: "m1",
    side: "BUY",
    intendedPrice: 0.5,
    intendedSize: 10,
    bestBid: 0.48,
    bestAsk: 0.52,
    bidDepth: 100,
    askDepth: 100,
    ...overrides,
  };
}

function run(): void {
  console.log("\n--- 1. Good tight market passes ---");
  {
    const r = evaluateExecutionQuality(baseInput({ bestBid: 0.495, bestAsk: 0.505, askDepth: 50 }));
    check(r.tradable === true, "tradable");
    check(r.qualityState === "good", "qualityState good");
    check(r.blockingReasons.length === 0, "no block reasons");
    check(r.spreadBps != null && r.spreadBps < 500, "spread reasonable");
    check(r.depthSufficiency === "sufficient", "depth sufficient");
  }

  console.log("\n--- 2. Missing quote blocks ---");
  {
    const r = evaluateExecutionQuality(baseInput({ bestBid: null, bestAsk: null }));
    check(r.tradable === false, "not tradable");
    check(r.qualityState === "block", "block");
    check(r.blockingReasons.includes("missing_quote"), "missing_quote");
  }

  console.log("\n--- 3. Crossed book blocks ---");
  {
    const r = evaluateExecutionQuality(baseInput({ bestBid: 0.55, bestAsk: 0.45 }));
    check(r.tradable === false, "not tradable");
    check(r.blockingReasons.includes("crossed_book"), "crossed_book");
  }

  console.log("\n--- 4. Stale quote blocks ---");
  {
    const r = evaluateExecutionQuality(baseInput({ quoteAgeMs: 90_000 }));
    check(r.qualityState === "block", "block");
    check(r.blockingReasons.includes("quote_stale"), "quote_stale");
  }

  console.log("\n--- 5. Stale quote warns when degraded ---");
  {
    const r = evaluateExecutionQuality(baseInput({ quoteAgeMs: 45_000 }));
    check(r.warnings.some((w) => w.includes("quote_age") || w.includes("degraded")), "quote age warning");
  }

  console.log("\n--- 6. Wide spread blocks ---");
  {
    const r = evaluateExecutionQuality(baseInput({ bestBid: 0.3, bestAsk: 0.7 }));
    check(r.blockingReasons.includes("spread_too_wide"), "spread_too_wide");
  }

  console.log("\n--- 7. Insufficient depth blocks ---");
  {
    const r = evaluateExecutionQuality(baseInput({ intendedSize: 100, askDepth: 10 }));
    check(r.blockingReasons.includes("insufficient_depth"), "insufficient_depth");
    check(r.depthSufficiency === "insufficient", "depthSufficiency insufficient");
  }

  console.log("\n--- 8. Intended price far from best blocks ---");
  {
    const r = evaluateExecutionQuality(baseInput({ intendedPrice: 0.9, bestAsk: 0.52 }));
    check(r.blockingReasons.includes("intended_price_far_from_market"), "intended_price_far");
  }

  console.log("\n--- 9. Estimated slippage surfaced and conservative ---");
  {
    const r = evaluateExecutionQuality(baseInput({ bestBid: 0.4, bestAsk: 0.6 }));
    check(r.estimatedSlippage != null || r.spreadBps != null, "slippage or spread surfaced");
    check(r.snapshotJson.length > 0, "snapshotJson non-empty");
    check(r.estimatedFillQuality !== undefined, "estimatedFillQuality set");
  }

  console.log("\n--- 10. not tradable blocks ---");
  {
    const r = evaluateExecutionQuality(baseInput({ isTradable: false }));
    check(r.blockingReasons.includes("not_tradable"), "not_tradable");
  }

  console.log("\n--- 11. Missing best ask for BUY blocks ---");
  {
    const r = evaluateExecutionQuality(baseInput({ bestAsk: null }));
    check(r.blockingReasons.includes("missing_best_ask"), "missing_best_ask");
  }

  console.log("\n--- 12. Liquidity score below threshold blocks ---");
  {
    const r = evaluateExecutionQuality(baseInput({ liquidityScore: 0.1 }));
    check(r.blockingReasons.includes("liquidity_below_threshold"), "liquidity_below_threshold");
  }

  console.log("\n--- 13. Depth low warns ---");
  {
    const r = evaluateExecutionQuality(baseInput({ intendedSize: 50, askDepth: 25 }));
    check(r.warnings.some((w) => w.includes("depth")), "depth warning");
  }

  console.log("\nAll execution-quality tests passed.");
}

run();
