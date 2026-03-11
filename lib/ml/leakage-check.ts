/**
 * Leakage audit: ensure target/forward columns and evaluation-only data are not used in features.
 * Post-trade and future data must be excluded from pre-trade model inputs. No autonomous trading.
 */

import { FEATURE_NAMES } from "./features";

// Columns that are targets or derived from future (evaluation) data — must NOT appear in feature set.
const FORBIDDEN_FEATURE_NAMES = new Set([
  "forwardReturn1h",
  "forwardReturn6h",
  "forwardReturn24h",
  "labelPositive1h",
  "labelPositive6h",
  "labelPositive24h",
  "wasPositive",
  "priceChange1h",
  "priceChange6h",
  "priceChange24h",
  "marketPriceAtEval",
  "evaluatedAt",
]);

// Post-trade / execution fields that must not influence pre-trade scoring.
const POST_TRADE_FIELDS = new Set([
  "executedOrderId",
  "orderFilledAt",
  "fillPrice",
  "realizedPnl",
  "closedAt",
]);

export interface LeakageCheckResult {
  passed: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Verify the feature set does not include target or evaluation-only columns.
 */
export function checkFeatureSetLeakage(): LeakageCheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const name of FEATURE_NAMES) {
    if (FORBIDDEN_FEATURE_NAMES.has(name)) {
      errors.push(`Feature set must not include target/evaluation column: ${name}`);
    }
  }

  for (const name of FEATURE_NAMES) {
    if (POST_TRADE_FIELDS.has(name)) {
      errors.push(`Feature set must not include post-trade column: ${name}`);
    }
  }

  if (FEATURE_NAMES.includes("priorityScore")) {
    warnings.push("priorityScore is heuristic output; using it as a feature may create feedback. Consider excluding for pure ML ranking.");
  }

  return {
    passed: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Assert that a row used for live scoring does not contain evaluation-only fields.
 * Caller can pass the keys they intend to use; we check none are forbidden.
 */
export function checkLiveScoringInputKeys(keysUsed: string[]): LeakageCheckResult {
  const errors: string[] = [];
  for (const k of keysUsed) {
    if (FORBIDDEN_FEATURE_NAMES.has(k) || POST_TRADE_FIELDS.has(k)) {
      errors.push(`Live scoring must not use: ${k}`);
    }
  }
  return {
    passed: errors.length === 0,
    errors,
    warnings: [],
  };
}
