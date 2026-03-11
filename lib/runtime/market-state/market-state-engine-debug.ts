/**
 * Safe read-only debug surface for Market State Engine.
 * Used by internal/ops routes only; no credentials, no write, no order hooks.
 */

import type { MarketStateEngine } from "./market-state-engine";
import type { AssetLiveState } from "./market-state-types";
import { isStale, isDegraded, DEFAULT_HEALTH_CONFIG } from "./market-state-health";

let engineRef: MarketStateEngine | null = null;

/**
 * Register the engine for debug inspection (e.g. from stream-runtime when it starts).
 * Call with null when the runtime shuts down.
 */
export function setMarketStateEngineForDebug(engine: MarketStateEngine | null): void {
  engineRef = engine;
}

/**
 * Get the registered engine, if any. Used by internal API routes.
 */
export function getMarketStateEngineForDebug(): MarketStateEngine | null {
  return engineRef;
}

// ---------- Serializable summary types (no Dates in JSON; use ISO strings) ----------

export interface MarketStateEngineDebugSummary {
  status: "ok" | "no_engine";
  message?: string;
  engine?: {
    trackedAssetCount: number;
    totalAssetCount: number;
    freshCount: number;
    staleCount: number;
    degradedCount: number;
    lastTickAt: string | null;
    snapshotAt: string;
    sampleAssets: AssetSummary[];
    /** Present when request asked for a single assetId. */
    asset?: AssetSummary | null;
  };
}

export interface AssetSummary {
  assetId: string;
  marketId: string | null;
  outcome: string;
  quote: {
    bestBid: number | null;
    bestAsk: number | null;
    mid: number | null;
    spreadBps: number | null;
    updatedAt: string | null;
  };
  depth: {
    bidTopSize: number | null;
    askTopSize: number | null;
    imbalanceTop: number | null;
    imbalance1pct: number | null;
    updatedAt: string | null;
  };
  lastTrade: {
    price: number | null;
    size: number | null;
    side: string | null;
    timestamp: string | null;
  };
  liquidity: {
    qualityScore: number | null;
    isTradable: boolean;
    updatedAt: string | null;
  };
  health: {
    isStale: boolean;
    isDegraded: boolean;
    lastMarketEventAt: string | null;
    lastRepairAt: string | null;
  };
  seq: { localVersion: number; lastEventType: string | null };
}

function toIso(d: Date | null | undefined): string | null {
  if (d == null) return null;
  const t = d instanceof Date ? d.getTime() : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function assetToSummary(a: AssetLiveState): AssetSummary {
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
    depth: {
      bidTopSize: a.depth.bidTopSize,
      askTopSize: a.depth.askTopSize,
      imbalanceTop: a.depth.imbalanceTop,
      imbalance1pct: a.depth.imbalance1pct,
      updatedAt: toIso(a.depth.updatedAt),
    },
    lastTrade: {
      price: a.lastTrade.price,
      size: a.lastTrade.size,
      side: a.lastTrade.side,
      timestamp: toIso(a.lastTrade.timestamp),
    },
    liquidity: {
      qualityScore: a.liquidity.qualityScore,
      isTradable: a.liquidity.isTradable,
      updatedAt: toIso(a.liquidity.updatedAt),
    },
    health: {
      isStale: a.health.isStale,
      isDegraded: a.health.isDegraded,
      lastMarketEventAt: toIso(a.health.lastMarketEventAt),
      lastRepairAt: toIso(a.health.lastRepairAt),
    },
    seq: { localVersion: a.seq.localVersion, lastEventType: a.seq.lastEventType },
  };
}

export interface BuildDebugPayloadOptions {
  /** If set, include only this asset (and set engine.asset). */
  assetId?: string | null;
  /** Max number of assets in sampleAssets (default 10). */
  limit?: number;
}

const DEFAULT_SAMPLE_LIMIT = 10;
const MAX_SAMPLE_LIMIT = 50;

/**
 * Build a JSON-serializable debug payload from the engine.
 * Read-only; does not mutate engine or store.
 */
export function buildMarketStateEngineDebugPayload(
  engine: MarketStateEngine,
  opts: BuildDebugPayloadOptions = {}
): MarketStateEngineDebugSummary {
  const now = new Date();
  const limit = Math.min(
    opts.limit ?? DEFAULT_SAMPLE_LIMIT,
    MAX_SAMPLE_LIMIT
  );

  const snapshot = engine.getSnapshot();
  const trackedIds = engine.getTrackedAssetIds();
  const lastTickAt = engine.getLastTickAt();

  const assets = Array.from(snapshot.assets.values());
  let freshCount = 0;
  let staleCount = 0;
  let degradedCount = 0;
  for (const a of assets) {
    const lastEventAt = a.health.lastMarketEventAt ?? a.quote.updatedAt ?? a.depth.updatedAt ?? null;
    if (isStale(lastEventAt, now, DEFAULT_HEALTH_CONFIG)) staleCount++;
    else freshCount++;
    if (isDegraded(lastEventAt, now, DEFAULT_HEALTH_CONFIG)) degradedCount++;
  }

  let sampleAssets: AssetSummary[] = [];
  let singleAsset: AssetSummary | null | undefined;

  if (opts.assetId != null && opts.assetId.trim() !== "") {
    const one = engine.getAssetState(opts.assetId.trim());
    singleAsset = one ? assetToSummary(one) : null;
  }

  const sample = assets.slice(0, limit);
  sampleAssets = sample.map(assetToSummary);

  return {
    status: "ok",
    engine: {
      trackedAssetCount: trackedIds.length,
      totalAssetCount: assets.length,
      freshCount,
      staleCount,
      degradedCount,
      lastTickAt: toIso(lastTickAt),
      snapshotAt: snapshot.asOf.toISOString(),
      sampleAssets,
      ...(singleAsset !== undefined && { asset: singleAsset }),
    },
  };
}

/**
 * Build the response for when no engine is registered.
 */
export function buildNoEngineDebugPayload(): MarketStateEngineDebugSummary {
  return {
    status: "no_engine",
    message:
      "Market state engine not attached to this process. Attach via setMarketStateEngineForDebug() when the runtime starts.",
  };
}
