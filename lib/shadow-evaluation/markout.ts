/**
 * Pure markout and outcome classification for shadow evaluation.
 * Shared by live evaluation (evaluate.ts) and offline historical dataset builder.
 */

import type { OutcomeClassification } from "./types";

/**
 * Compute markout: (priceLater - price0) / price0 for BUY; (price0 - priceLater) / price0 for SELL.
 * Returns null if either price missing or invalid.
 */
export function markout(
  side: string,
  price0: number,
  priceLater: number
): number | null {
  if (price0 <= 0 || !Number.isFinite(price0) || !Number.isFinite(priceLater)) return null;
  const raw = (priceLater - price0) / price0;
  if (side.toUpperCase() === "SELL") return -raw;
  return raw;
}

/**
 * Favorable: markout > 0. For BUY, price went up; for SELL, price went down after sell.
 */
export function isFavorable(_side: string, markoutVal: number): boolean {
  return markoutVal > 0;
}

/**
 * Classify outcome from wasBlocked, side, and 24h markout.
 * good_block | bad_block | good_allow | bad_allow.
 */
export function classify(
  wasBlocked: boolean,
  side: string,
  markout24h: number | null
): OutcomeClassification | null {
  if (markout24h == null || !Number.isFinite(markout24h)) return null;
  const favorable = isFavorable(side, markout24h);
  if (wasBlocked) return favorable ? "bad_block" : "good_block";
  return favorable ? "good_allow" : "bad_allow";
}
