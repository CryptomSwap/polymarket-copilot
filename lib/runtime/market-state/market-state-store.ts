import type {
  AssetLiveState,
  AssetLiveStatePatch,
  AssetDepth,
  AssetHealth,
  AssetLastTrade,
  AssetLiquidity,
  AssetQuote,
  AssetSeq,
  AssetVolatility,
  AssetMarketLink,
  MarketStateSnapshot,
} from "./market-state-types";
import { createEmptyAssetState } from "./market-state-types";

/**
 * In-memory live market state registry.
 * Execution-plane source of truth for trading decisions; no DB, no feed parsing here.
 * Updates are copy-on-write so stored state is not mutated by callers.
 */

function cloneDate(d: Date | null): Date | null {
  return d ? new Date(d.getTime()) : null;
}

function cloneQuote(q: AssetQuote): AssetQuote {
  return {
    bestBid: q.bestBid,
    bestAsk: q.bestAsk,
    mid: q.mid,
    spreadAbs: q.spreadAbs,
    spreadBps: q.spreadBps,
    updatedAt: cloneDate(q.updatedAt),
  };
}

function cloneLastTrade(t: AssetLastTrade): AssetLastTrade {
  return {
    price: t.price,
    size: t.size,
    side: t.side,
    timestamp: cloneDate(t.timestamp),
  };
}

function cloneDepth(d: AssetDepth): AssetDepth {
  return {
    bidTopSize: d.bidTopSize,
    askTopSize: d.askTopSize,
    bidDepth1pct: d.bidDepth1pct,
    askDepth1pct: d.askDepth1pct,
    imbalanceTop: d.imbalanceTop,
    imbalance1pct: d.imbalance1pct,
    updatedAt: cloneDate(d.updatedAt),
  };
}

function cloneVolatility(v: AssetVolatility): AssetVolatility {
  return {
    vol30s: v.vol30s,
    vol2m: v.vol2m,
    return1m: v.return1m,
    updatedAt: cloneDate(v.updatedAt),
  };
}

function cloneLiquidity(l: AssetLiquidity): AssetLiquidity {
  return {
    qualityScore: l.qualityScore,
    isTradable: l.isTradable,
    minExecutableSize: l.minExecutableSize,
    updatedAt: cloneDate(l.updatedAt),
  };
}

function cloneHealth(h: AssetHealth): AssetHealth {
  return {
    isStale: h.isStale,
    isDegraded: h.isDegraded,
    lastMarketEventAt: cloneDate(h.lastMarketEventAt),
    lastRepairAt: cloneDate(h.lastRepairAt),
    sourceConfidence: h.sourceConfidence,
  };
}

function cloneMarket(m: AssetMarketLink): AssetMarketLink {
  return {
    marketId: m.marketId,
    slug: m.slug,
    title: m.title,
  };
}

/** Deep clone of AssetLiveState so callers cannot mutate stored state. */
function cloneAssetState(s: AssetLiveState): AssetLiveState {
  return {
    assetId: s.assetId,
    outcome: s.outcome,
    market: cloneMarket(s.market),
    quote: cloneQuote(s.quote),
    lastTrade: cloneLastTrade(s.lastTrade),
    depth: cloneDepth(s.depth),
    volatility: cloneVolatility(s.volatility),
    liquidity: cloneLiquidity(s.liquidity),
    health: cloneHealth(s.health),
    seq: { ...s.seq },
  };
}

/** Deep merge patch into base. undefined = leave as-is; null = clear. */
function applyPatch(base: AssetLiveState, patch: AssetLiveStatePatch): AssetLiveState {
  const next = cloneAssetState(base);

  if (patch.outcome !== undefined) next.outcome = patch.outcome;
  if (patch.market) {
    next.market = {
      marketId: patch.market.marketId !== undefined ? patch.market.marketId : next.market.marketId,
      slug: patch.market.slug !== undefined ? patch.market.slug : next.market.slug,
      title: patch.market.title !== undefined ? patch.market.title : next.market.title,
    };
  }
  if (patch.quote) {
    const q = patch.quote;
    next.quote = {
      bestBid: q.bestBid !== undefined ? q.bestBid : next.quote.bestBid,
      bestAsk: q.bestAsk !== undefined ? q.bestAsk : next.quote.bestAsk,
      mid: q.mid !== undefined ? q.mid : next.quote.mid,
      spreadAbs: q.spreadAbs !== undefined ? q.spreadAbs : next.quote.spreadAbs,
      spreadBps: q.spreadBps !== undefined ? q.spreadBps : next.quote.spreadBps,
      updatedAt: q.updatedAt !== undefined ? cloneDate(q.updatedAt) : next.quote.updatedAt,
    };
  }
  if (patch.lastTrade) {
    const t = patch.lastTrade;
    next.lastTrade = {
      price: t.price !== undefined ? t.price : next.lastTrade.price,
      size: t.size !== undefined ? t.size : next.lastTrade.size,
      side: t.side !== undefined ? t.side : next.lastTrade.side,
      timestamp: t.timestamp !== undefined ? cloneDate(t.timestamp) : next.lastTrade.timestamp,
    };
  }
  if (patch.depth) {
    const d = patch.depth;
    next.depth = {
      bidTopSize: d.bidTopSize !== undefined ? d.bidTopSize : next.depth.bidTopSize,
      askTopSize: d.askTopSize !== undefined ? d.askTopSize : next.depth.askTopSize,
      bidDepth1pct: d.bidDepth1pct !== undefined ? d.bidDepth1pct : next.depth.bidDepth1pct,
      askDepth1pct: d.askDepth1pct !== undefined ? d.askDepth1pct : next.depth.askDepth1pct,
      imbalanceTop: d.imbalanceTop !== undefined ? d.imbalanceTop : next.depth.imbalanceTop,
      imbalance1pct: d.imbalance1pct !== undefined ? d.imbalance1pct : next.depth.imbalance1pct,
      updatedAt: d.updatedAt !== undefined ? cloneDate(d.updatedAt) : next.depth.updatedAt,
    };
  }
  if (patch.volatility) {
    const v = patch.volatility;
    next.volatility = {
      vol30s: v.vol30s !== undefined ? v.vol30s : next.volatility.vol30s,
      vol2m: v.vol2m !== undefined ? v.vol2m : next.volatility.vol2m,
      return1m: v.return1m !== undefined ? v.return1m : next.volatility.return1m,
      updatedAt: v.updatedAt !== undefined ? cloneDate(v.updatedAt) : next.volatility.updatedAt,
    };
  }
  if (patch.liquidity) {
    const l = patch.liquidity;
    next.liquidity = {
      qualityScore: l.qualityScore !== undefined ? l.qualityScore : next.liquidity.qualityScore,
      isTradable: l.isTradable !== undefined ? l.isTradable : next.liquidity.isTradable,
      minExecutableSize: l.minExecutableSize !== undefined ? l.minExecutableSize : next.liquidity.minExecutableSize,
      updatedAt: l.updatedAt !== undefined ? cloneDate(l.updatedAt) : next.liquidity.updatedAt,
    };
  }
  if (patch.health) {
    const h = patch.health;
    next.health = {
      isStale: h.isStale !== undefined ? h.isStale : next.health.isStale,
      isDegraded: h.isDegraded !== undefined ? h.isDegraded : next.health.isDegraded,
      lastMarketEventAt: h.lastMarketEventAt !== undefined ? cloneDate(h.lastMarketEventAt) : next.health.lastMarketEventAt,
      lastRepairAt: h.lastRepairAt !== undefined ? cloneDate(h.lastRepairAt) : next.health.lastRepairAt,
      sourceConfidence: h.sourceConfidence !== undefined ? h.sourceConfidence : next.health.sourceConfidence,
    };
  }
  if (patch.seq) {
    const s = patch.seq;
    next.seq = {
      localVersion: s.localVersion !== undefined ? s.localVersion : next.seq.localVersion,
      lastEventType: s.lastEventType !== undefined ? s.lastEventType : next.seq.lastEventType,
    };
  }

  return next;
}

export interface MarketStateStore {
  getAsset(assetId: string): AssetLiveState | null;
  getAssets(assetIds?: string[]): AssetLiveState[];
  upsertAsset(state: AssetLiveState | (Partial<AssetLiveState> & { assetId: string })): void;
  patchAsset(assetId: string, patch: AssetLiveStatePatch): void;
  hasAsset(assetId: string): boolean;
  removeAsset(assetId: string): void;
  markAssetTracked(assetId: string): void;
  markAssetUntracked(assetId: string): void;
  getTrackedAssetIds(): string[];
  snapshot(): MarketStateSnapshot;
  clear(): void;
}

export class InMemoryMarketStateStore implements MarketStateStore {
  private readonly byAssetId = new Map<string, AssetLiveState>();
  private readonly trackedIds = new Set<string>();

  getAsset(assetId: string): AssetLiveState | null {
    const s = this.byAssetId.get(assetId);
    return s ? cloneAssetState(s) : null;
  }

  getAssets(assetIds?: string[]): AssetLiveState[] {
    if (assetIds == null || assetIds.length === 0) {
      return Array.from(this.byAssetId.values()).map(cloneAssetState);
    }
    const out: AssetLiveState[] = [];
    const set = new Set(assetIds);
    for (const id of set) {
      const s = this.byAssetId.get(id);
      if (s) out.push(cloneAssetState(s));
    }
    return out;
  }

  upsertAsset(state: AssetLiveState | (Partial<AssetLiveState> & { assetId: string })): void {
    const id = state.assetId;
    const existing = this.byAssetId.get(id);
    let next: AssetLiveState;
    if (existing) {
      const full = state as AssetLiveState;
      if (
        full.quote != null &&
        full.lastTrade != null &&
        full.depth != null &&
        full.volatility != null &&
        full.liquidity != null &&
        full.health != null &&
        full.seq != null &&
        full.market != null
      ) {
        next = cloneAssetState(full);
      } else {
        next = applyPatch(existing, state as AssetLiveStatePatch);
      }
    } else {
      next = applyPatch(createEmptyAssetState(id), state as AssetLiveStatePatch);
    }
    this.byAssetId.set(id, next);
  }

  patchAsset(assetId: string, patch: AssetLiveStatePatch): void {
    const existing = this.byAssetId.get(assetId);
    const next = existing ? applyPatch(existing, patch) : applyPatch(createEmptyAssetState(assetId), patch);
    this.byAssetId.set(assetId, next);
  }

  hasAsset(assetId: string): boolean {
    return this.byAssetId.has(assetId);
  }

  removeAsset(assetId: string): void {
    this.byAssetId.delete(assetId);
    this.trackedIds.delete(assetId);
  }

  markAssetTracked(assetId: string): void {
    this.trackedIds.add(assetId);
  }

  markAssetUntracked(assetId: string): void {
    this.trackedIds.delete(assetId);
  }

  getTrackedAssetIds(): string[] {
    return Array.from(this.trackedIds);
  }

  snapshot(): MarketStateSnapshot {
    const asOf = new Date();
    const assets = new Map<string, AssetLiveState>();
    for (const [id, s] of this.byAssetId) {
      assets.set(id, cloneAssetState(s));
    }
    return { asOf, assets };
  }

  clear(): void {
    this.byAssetId.clear();
    this.trackedIds.clear();
  }
}

