/**
 * Market Detail Live — UI-oriented payload from runtime state only.
 * No DB, no analytics; use for professional Market Detail UI.
 * Historical/chart data stays separate.
 */

import type { MarketStateEngine } from "./market-state-engine";
import type { AssetLiveState } from "./market-state-types";

// ---------- Serializable response (ISO strings for dates) ----------

export interface MarketDetailLiveQuote {
  bestBid: number | null;
  bestAsk: number | null;
  mid: number | null;
  spreadBps: number | null;
  updatedAt: string | null;
}

export interface MarketDetailLiveDepthSummary {
  bidTopSize: number | null;
  askTopSize: number | null;
  imbalanceTop: number | null;
  updatedAt: string | null;
}

export interface MarketDetailLiveLastTrade {
  price: number | null;
  size: number | null;
  side: string | null;
  timestamp: string | null;
}

/** Single last trade from runtime; full trade tape is separate analytics. */
export interface MarketDetailLiveTradeTape {
  /** Runtime only has last trade; historical tape from analytics. */
  lastTrade: MarketDetailLiveLastTrade;
}

export interface MarketDetailLiveLiquidity {
  qualityScore: number | null;
  isTradable: boolean;
  minExecutableSize: number | null;
  updatedAt: string | null;
}

export interface MarketDetailLiveVolatility {
  vol30s: number | null;
  vol2m: number | null;
  return1m: number | null;
  updatedAt: string | null;
}

export interface MarketDetailLiveHealth {
  isStale: boolean;
  isDegraded: boolean;
  lastMarketEventAt: string | null;
  lastRepairAt: string | null;
}

export interface MarketDetailLiveBotSummary {
  lastAction: string | null;
  lastEvaluatedAt: string | null;
  lastDecisionAt: string | null;
  mode: string;
}

export interface MarketDetailLivePayload {
  source: "runtime";
  /** When runtime engine is not attached, available is false and only meta fields are set. */
  available: boolean;
  asOf: string;
  assetId: string;
  marketId: string | null;
  outcome: string;
  quote: MarketDetailLiveQuote;
  spread: { bps: number | null; abs: number | null };
  depthSummary: MarketDetailLiveDepthSummary;
  /** Last trade only; full tape is separate historical/analytics. */
  tradeTape: MarketDetailLiveTradeTape;
  liquidity: MarketDetailLiveLiquidity;
  volatility: MarketDetailLiveVolatility;
  health: MarketDetailLiveHealth;
  /** Present when bot runtime is attached and has state for this asset. */
  botSummary: MarketDetailLiveBotSummary | null;
}

function toIso(d: Date | null | undefined): string | null {
  if (d == null) return null;
  const t = d instanceof Date ? d.getTime() : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function fromAsset(a: AssetLiveState): Omit<MarketDetailLivePayload, "source" | "available" | "asOf" | "botSummary"> {
  return {
    assetId: a.assetId,
    marketId: a.market.marketId,
    outcome: a.outcome,
    quote: {
      bestBid: a.quote.bestBid,
      bestAsk: a.quote.bestAsk,
      mid: a.quote.mid,
      spreadBps: a.quote.spreadBps,
      updatedAt: toIso(a.quote.updatedAt),
    },
    spread: {
      bps: a.quote.spreadBps,
      abs: a.quote.spreadAbs,
    },
    depthSummary: {
      bidTopSize: a.depth.bidTopSize,
      askTopSize: a.depth.askTopSize,
      imbalanceTop: a.depth.imbalanceTop,
      updatedAt: toIso(a.depth.updatedAt),
    },
    tradeTape: {
      lastTrade: {
        price: a.lastTrade.price,
        size: a.lastTrade.size,
        side: a.lastTrade.side,
        timestamp: toIso(a.lastTrade.timestamp),
      },
    },
    liquidity: {
      qualityScore: a.liquidity.qualityScore,
      isTradable: a.liquidity.isTradable,
      minExecutableSize: a.liquidity.minExecutableSize,
      updatedAt: toIso(a.liquidity.updatedAt),
    },
    volatility: {
      vol30s: a.volatility.vol30s,
      vol2m: a.volatility.vol2m,
      return1m: a.volatility.return1m,
      updatedAt: toIso(a.volatility.updatedAt),
    },
    health: {
      isStale: a.health.isStale,
      isDegraded: a.health.isDegraded,
      lastMarketEventAt: toIso(a.health.lastMarketEventAt),
      lastRepairAt: toIso(a.health.lastRepairAt),
    },
  };
}

const EMPTY_QUOTE: MarketDetailLiveQuote = {
  bestBid: null,
  bestAsk: null,
  mid: null,
  spreadBps: null,
  updatedAt: null,
};
const EMPTY_DEPTH: MarketDetailLiveDepthSummary = {
  bidTopSize: null,
  askTopSize: null,
  imbalanceTop: null,
  updatedAt: null,
};
const EMPTY_LAST_TRADE: MarketDetailLiveLastTrade = {
  price: null,
  size: null,
  side: null,
  timestamp: null,
};
const EMPTY_LIQUIDITY: MarketDetailLiveLiquidity = {
  qualityScore: null,
  isTradable: false,
  minExecutableSize: null,
  updatedAt: null,
};
const EMPTY_VOLATILITY: MarketDetailLiveVolatility = {
  vol30s: null,
  vol2m: null,
  return1m: null,
  updatedAt: null,
};
const EMPTY_HEALTH: MarketDetailLiveHealth = {
  isStale: true,
  isDegraded: true,
  lastMarketEventAt: null,
  lastRepairAt: null,
};

/**
 * Build UI-oriented market detail from runtime engine (and optional bot summary).
 * Read-only; does not mutate engine.
 */
export function buildMarketDetailLivePayload(
  engine: MarketStateEngine | null,
  assetId: string,
  botSummary: MarketDetailLiveBotSummary | null,
  now: Date = new Date()
): MarketDetailLivePayload {
  const asOf = now.toISOString();
  if (!engine) {
    return {
      source: "runtime",
      available: false,
      asOf,
      assetId,
      marketId: null,
      outcome: "",
      quote: EMPTY_QUOTE,
      spread: { bps: null, abs: null },
      depthSummary: EMPTY_DEPTH,
      tradeTape: { lastTrade: EMPTY_LAST_TRADE },
      liquidity: EMPTY_LIQUIDITY,
      volatility: EMPTY_VOLATILITY,
      health: EMPTY_HEALTH,
      botSummary,
    };
  }

  const asset = engine.getAssetState(assetId);
  if (!asset) {
    return {
      source: "runtime",
      available: true,
      asOf,
      assetId,
      marketId: null,
      outcome: "",
      quote: EMPTY_QUOTE,
      spread: { bps: null, abs: null },
      depthSummary: EMPTY_DEPTH,
      tradeTape: { lastTrade: EMPTY_LAST_TRADE },
      liquidity: EMPTY_LIQUIDITY,
      volatility: EMPTY_VOLATILITY,
      health: EMPTY_HEALTH,
      botSummary,
    };
  }

  const base = fromAsset(asset);
  return {
    source: "runtime",
    available: true,
    asOf,
    ...base,
    botSummary,
  };
}
