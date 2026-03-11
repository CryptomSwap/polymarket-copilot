/**
 * Live, in-memory market state types for the execution-plane.
 * Authoritative source of truth for trading decisions; no DB on the hot path.
 * Naming aligns with runtime and WS conventions (assetId, marketId camelCase).
 */

// ---------- Nested state blocks (all timestamps as Date) ----------

export interface AssetQuote {
  bestBid: number | null;
  bestAsk: number | null;
  mid: number | null;
  spreadAbs: number | null;
  spreadBps: number | null;
  updatedAt: Date | null;
}

export interface AssetLastTrade {
  price: number | null;
  size: number | null;
  side: "BUY" | "SELL" | null;
  timestamp: Date | null;
}

export interface AssetDepth {
  bidTopSize: number | null;
  askTopSize: number | null;
  bidDepth1pct: number | null;
  askDepth1pct: number | null;
  imbalanceTop: number | null;
  imbalance1pct: number | null;
  updatedAt: Date | null;
}

export interface AssetVolatility {
  vol30s: number | null;
  vol2m: number | null;
  return1m: number | null;
  updatedAt: Date | null;
}

export interface AssetLiquidity {
  qualityScore: number | null;
  isTradable: boolean;
  minExecutableSize: number | null;
  updatedAt: Date | null;
}

export interface AssetHealth {
  isStale: boolean;
  isDegraded: boolean;
  lastMarketEventAt: Date | null;
  lastRepairAt: Date | null;
  sourceConfidence: number | null;
}

export interface AssetSeq {
  localVersion: number;
  lastEventType: string | null;
}

// ---------- Canonical market linkage (nullable when not yet resolved) ----------

export interface AssetMarketLink {
  marketId: string | null;
  slug: string | null;
  title: string | null;
}

// ---------- Full asset state keyed by assetId ----------

export interface AssetLiveState {
  assetId: string;
  outcome: string;

  /** Canonical market linkage when available (from catalog or WS). */
  market: AssetMarketLink;

  quote: AssetQuote;
  lastTrade: AssetLastTrade;
  depth: AssetDepth;
  volatility: AssetVolatility;
  liquidity: AssetLiquidity;
  health: AssetHealth;
  seq: AssetSeq;
}

// ---------- Snapshot (read-only view for consumers) ----------

export interface MarketStateSnapshot {
  asOf: Date;
  /** Map assetId -> state. Consumers must not mutate returned objects. */
  assets: Map<string, AssetLiveState>;
}

// ---------- Partial updates (for patchAsset) ----------

export type AssetLiveStatePatch = Partial<{
  outcome: string;
  market: Partial<AssetMarketLink>;
  quote: Partial<AssetQuote>;
  lastTrade: Partial<AssetLastTrade>;
  depth: Partial<AssetDepth>;
  volatility: Partial<AssetVolatility>;
  liquidity: Partial<AssetLiquidity>;
  health: Partial<AssetHealth>;
  seq: Partial<AssetSeq>;
}>;

// ---------- Default / empty state factory ----------

const NULL_DATE = null as Date | null;

function defaultQuote(): AssetQuote {
  return {
    bestBid: null,
    bestAsk: null,
    mid: null,
    spreadAbs: null,
    spreadBps: null,
    updatedAt: NULL_DATE,
  };
}

function defaultLastTrade(): AssetLastTrade {
  return {
    price: null,
    size: null,
    side: null,
    timestamp: NULL_DATE,
  };
}

function defaultDepth(): AssetDepth {
  return {
    bidTopSize: null,
    askTopSize: null,
    bidDepth1pct: null,
    askDepth1pct: null,
    imbalanceTop: null,
    imbalance1pct: null,
    updatedAt: NULL_DATE,
  };
}

function defaultVolatility(): AssetVolatility {
  return {
    vol30s: null,
    vol2m: null,
    return1m: null,
    updatedAt: NULL_DATE,
  };
}

function defaultLiquidity(): AssetLiquidity {
  return {
    qualityScore: null,
    isTradable: false,
    minExecutableSize: null,
    updatedAt: NULL_DATE,
  };
}

function defaultHealth(): AssetHealth {
  return {
    isStale: true,
    isDegraded: true,
    lastMarketEventAt: NULL_DATE,
    lastRepairAt: NULL_DATE,
    sourceConfidence: null,
  };
}

function defaultSeq(): AssetSeq {
  return {
    localVersion: 0,
    lastEventType: null,
  };
}

function defaultMarket(): AssetMarketLink {
  return {
    marketId: null,
    slug: null,
    title: null,
  };
}

/**
 * Create a default empty AssetLiveState for an asset.
 * Use when inserting a new asset into the store before any feed data.
 */
export function createEmptyAssetState(assetId: string): AssetLiveState {
  return {
    assetId,
    outcome: "",
    market: defaultMarket(),
    quote: defaultQuote(),
    lastTrade: defaultLastTrade(),
    depth: defaultDepth(),
    volatility: defaultVolatility(),
    liquidity: defaultLiquidity(),
    health: defaultHealth(),
    seq: defaultSeq(),
  };
}
