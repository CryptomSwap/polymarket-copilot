/**
 * Execution quality (market microstructure) input and result types.
 * Used to block or warn on unsafe execution conditions before order submission.
 */

export interface ExecutionQualityInput {
  assetId: string;
  marketId: string;
  side: "BUY" | "SELL";
  /** Intended limit price (0–1 for probability markets). */
  intendedPrice: number;
  /** Intended order size (display units). */
  intendedSize: number;
  /** Best bid price; null if missing. */
  bestBid: number | null;
  /** Best ask price; null if missing. */
  bestAsk: number | null;
  /** Top-of-book bid size (same units as intendedSize). */
  bidDepth: number | null;
  /** Top-of-book ask size (same units as intendedSize). */
  askDepth: number | null;
  /** Spread in bps when precomputed; otherwise derived from bestBid/bestAsk. */
  spreadBps?: number | null;
  /** Last trade price if available. */
  lastTradePrice?: number | null;
  /** Age of quote in ms; null if unknown. */
  quoteAgeMs?: number | null;
  /** Market/feed freshness in ms; null if unknown. */
  marketStateFreshnessMs?: number | null;
  /** Precomputed liquidity score 0–1 when available (e.g. from market state). */
  liquidityScore?: number | null;
  /** Precomputed tradable flag when available. */
  isTradable?: boolean | null;
}

export type ExecutionQualityState = "good" | "warn" | "block";

export type QuoteFreshnessState = "fresh" | "stale" | "unknown" | "missing";

export interface ExecutionQualityResult {
  /** True only when qualityState is "good" or "warn" and no hard blocks. */
  tradable: boolean;
  qualityState: ExecutionQualityState;
  blockingReasons: string[];
  warnings: string[];
  /** Approximate slippage (e.g. bps or probability points); null if not estimable. */
  estimatedSlippage: number | null;
  /** Label for UI: "low" | "moderate" | "high" | "unknown". */
  estimatedFillQuality: "low" | "moderate" | "high" | "unknown";
  /** Absolute spread (ask - bid); null if missing. */
  spread: number | null;
  /** Spread in bps; null if missing. */
  spreadBps: number | null;
  /** Whether same-side and opposite-side depth are sufficient for intended size. */
  depthSufficiency: "sufficient" | "insufficient" | "unknown";
  quoteFreshnessState: QuoteFreshnessState;
  /** ISO timestamp when evaluation ran. */
  evaluatedAt: string;
  /** Safe to persist (no secrets). */
  snapshotJson: string;
}
