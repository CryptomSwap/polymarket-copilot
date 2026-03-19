import type { RuntimeEventBus } from "../events/runtime-event-bus";
import {
  createRuntimeEventId,
  type MarketDepthPayload,
  type MarketLiquidityPayload,
  type MarketQuotePayload,
  type MarketRecoveredPayload,
  type MarketStalePayload,
  type RuntimeEventSource,
} from "../events/runtime-events";
import type {
  AssetDepth,
  AssetLastTrade,
  AssetLiveState,
  AssetLiquidity,
  AssetQuote,
} from "./market-state-types";
import { createEmptyAssetState } from "./market-state-types";
import type { MarketStateStore } from "./market-state-store";
import {
  DEFAULT_METRIC_CONFIG,
  deriveDepthImbalances,
  deriveQuoteMetrics,
  computeLiquidityQualityScore,
  computeIsTradable,
  lastUpdateForAsset,
  type MetricConfig,
} from "./market-state-metrics";
import {
  DEFAULT_HEALTH_CONFIG,
  isStale,
  isDegraded,
  isRecovered,
  type HealthConfig,
} from "./market-state-health";

// ---------- Normalized update inputs ----------

export interface QuoteUpdateInput {
  assetId: string;
  marketId?: string | null;
  outcome?: string | null;
  bestBid: number | null;
  bestAsk: number | null;
  at?: Date;
}

export interface TradeUpdateInput {
  assetId: string;
  marketId?: string | null;
  outcome?: string | null;
  price: number;
  size: number;
  side: "BUY" | "SELL";
  at?: Date;
}

export interface DepthUpdateInput {
  assetId: string;
  marketId?: string | null;
  outcome?: string | null;
  bidTopSize: number | null;
  askTopSize: number | null;
  bidDepth1pct?: number | null;
  askDepth1pct?: number | null;
  at?: Date;
}

export interface RepairSnapshotInput {
  assetId: string;
  marketId?: string | null;
  outcome?: string | null;
  quote?: Partial<AssetQuote>;
  depth?: Partial<AssetDepth>;
  liquidity?: Partial<AssetLiquidity>;
  lastTrade?: Partial<AssetLastTrade>;
  at?: Date;
  reason?: string;
}

export interface MarketStateEngineThresholds {
  /** Minimum absolute change in mid price to emit quote event, in probability points. */
  minMidChangeAbs: number;
  /** Minimum absolute change in spread bps to emit quote event. */
  minSpreadBpsChange: number;
  /** Minimum absolute change in top-of-book imbalance to emit depth event. */
  minImbalanceChange: number;
  /** Min change in liquidity quality score to emit liquidity event. */
  minLiquidityScoreChange: number;
}

export const DEFAULT_ENGINE_THRESHOLDS: MarketStateEngineThresholds = {
  minMidChangeAbs: 0.005,
  minSpreadBpsChange: 5,
  minImbalanceChange: 0.1,
  minLiquidityScoreChange: 0.1,
};

export interface MarketStateEngineOptions {
  store: MarketStateStore;
  eventBus: RuntimeEventBus;
  metricConfig?: MetricConfig;
  healthConfig?: HealthConfig;
  thresholds?: Partial<MarketStateEngineThresholds>;
  /** Source identifier used for runtime events (defaults to "market_state"). */
  eventSource?: RuntimeEventSource;
}

/**
 * Streaming-first market state engine.
 * Consumes normalized quote/depth/trade/snapshot updates and maintains an in-memory AssetLiveState store.
 * Emits material runtime events (market.*) via the internal event bus.
 */
export class MarketStateEngine {
  private readonly store: MarketStateStore;
  private readonly eventBus: RuntimeEventBus;
  private readonly metricConfig: MetricConfig;
  private readonly healthConfig: HealthConfig;
  private readonly thresholds: MarketStateEngineThresholds;
  private readonly eventSource: RuntimeEventSource;
  /** Set in tick(); used by internal debug surface only. */
  private lastTickAt: Date | null = null;

  constructor(opts: MarketStateEngineOptions) {
    this.store = opts.store;
    this.eventBus = opts.eventBus;
    this.metricConfig = opts.metricConfig ?? DEFAULT_METRIC_CONFIG;
    this.healthConfig = opts.healthConfig ?? DEFAULT_HEALTH_CONFIG;
    this.thresholds = { ...DEFAULT_ENGINE_THRESHOLDS, ...(opts.thresholds ?? {}) };
    this.eventSource = opts.eventSource ?? "market_state";
  }

  applyQuoteUpdate(input: QuoteUpdateInput): void {
    const now = input.at ?? new Date();
    const { assetId } = input;
    const prev = this.store.getAsset(assetId) ?? createEmptyAssetState(assetId);

    const quotePatch: Partial<AssetQuote> = {
      bestBid: input.bestBid,
      bestAsk: input.bestAsk,
      updatedAt: now,
    };

    const derivedQuote = deriveQuoteMetrics(
      { ...prev.quote, ...quotePatch },
      this.metricConfig
    );

    const liquidityScore = computeLiquidityQualityScore(
      quotePatch.bestBid ?? prev.quote.bestBid,
      quotePatch.bestAsk ?? prev.quote.bestAsk,
      prev.depth.bidTopSize,
      prev.depth.askTopSize,
      this.metricConfig
    );

    const liquidityPatch: Partial<AssetLiquidity> = {
      qualityScore: liquidityScore ?? prev.liquidity.qualityScore,
      isTradable: computeIsTradable(
        { ...prev.quote, ...quotePatch, ...derivedQuote },
        prev.depth,
        prev.liquidity,
        this.metricConfig
      ),
      updatedAt: now,
    };

    const healthPatch = this.buildHealthPatch(prev, now);

    this.store.patchAsset(assetId, {
      outcome: input.outcome ?? prev.outcome,
      market: { marketId: input.marketId ?? prev.market.marketId },
      quote: { ...quotePatch, ...derivedQuote },
      liquidity: liquidityPatch,
      health: healthPatch,
      seq: {
        localVersion: prev.seq.localVersion + 1,
        lastEventType: "quote",
      },
    });

    const next = this.store.getAsset(assetId);
    if (!next) return;

    this.maybeEmitQuoteEvent(prev, next, now);
    this.maybeEmitLiquidityEvent(prev, next, now);
    this.maybeEmitStaleOrRecoveredEvents(prev, next, now);
  }

  applyTradeUpdate(input: TradeUpdateInput): void {
    const now = input.at ?? new Date();
    const { assetId } = input;
    const prev = this.store.getAsset(assetId) ?? createEmptyAssetState(assetId);

    const lastTradePatch: Partial<AssetLastTrade> = {
      price: input.price,
      size: input.size,
      side: input.side,
      timestamp: now,
    };

    const healthPatch = this.buildHealthPatch(prev, now);

    this.store.patchAsset(assetId, {
      outcome: input.outcome ?? prev.outcome,
      market: { marketId: input.marketId ?? prev.market.marketId },
      lastTrade: lastTradePatch,
      health: healthPatch,
      seq: {
        localVersion: prev.seq.localVersion + 1,
        lastEventType: "trade",
      },
    });

    const next = this.store.getAsset(assetId);
    if (!next) return;

    this.emitTradeEvent(next, input);
    this.maybeEmitStaleOrRecoveredEvents(prev, next, now);
  }

  applyDepthUpdate(input: DepthUpdateInput): void {
    const now = input.at ?? new Date();
    const { assetId } = input;
    const prev = this.store.getAsset(assetId) ?? createEmptyAssetState(assetId);

    const depthPatch: Partial<AssetDepth> = {
      bidTopSize: input.bidTopSize,
      askTopSize: input.askTopSize,
      bidDepth1pct: input.bidDepth1pct ?? prev.depth.bidDepth1pct,
      askDepth1pct: input.askDepth1pct ?? prev.depth.askDepth1pct,
      updatedAt: now,
    };

    const derivedDepth = deriveDepthImbalances(
      { ...prev.depth, ...depthPatch },
      this.metricConfig
    );

    const liquidityScore = computeLiquidityQualityScore(
      prev.quote.bestBid,
      prev.quote.bestAsk,
      depthPatch.bidTopSize ?? prev.depth.bidTopSize,
      depthPatch.askTopSize ?? prev.depth.askTopSize,
      this.metricConfig
    );

    const liquidityPatch: Partial<AssetLiquidity> = {
      qualityScore: liquidityScore ?? prev.liquidity.qualityScore,
      isTradable: computeIsTradable(
        prev.quote,
        { ...prev.depth, ...depthPatch, ...derivedDepth },
        prev.liquidity,
        this.metricConfig
      ),
      updatedAt: now,
    };

    const healthPatch = this.buildHealthPatch(prev, now);

    this.store.patchAsset(assetId, {
      outcome: input.outcome ?? prev.outcome,
      market: { marketId: input.marketId ?? prev.market.marketId },
      depth: { ...depthPatch, ...derivedDepth },
      liquidity: liquidityPatch,
      health: healthPatch,
      seq: {
        localVersion: prev.seq.localVersion + 1,
        lastEventType: "depth",
      },
    });

    const next = this.store.getAsset(assetId);
    if (!next) return;

    this.maybeEmitDepthEvent(prev, next, now);
    this.maybeEmitLiquidityEvent(prev, next, now);
    this.maybeEmitStaleOrRecoveredEvents(prev, next, now);
  }

  applyRepairSnapshot(input: RepairSnapshotInput): void {
    const now = input.at ?? new Date();
    const { assetId } = input;
    const prev = this.store.getAsset(assetId) ?? createEmptyAssetState(assetId);

    const healthPatch = {
      ...this.buildHealthPatch(prev, now),
      lastRepairAt: now,
    };

    this.store.patchAsset(assetId, {
      outcome: input.outcome ?? prev.outcome,
      market: { marketId: input.marketId ?? prev.market.marketId },
      quote: input.quote,
      depth: input.depth,
      liquidity: input.liquidity,
      lastTrade: input.lastTrade,
      health: healthPatch,
      seq: {
        localVersion: prev.seq.localVersion + 1,
        lastEventType: "repair",
      },
    });

    const next = this.store.getAsset(assetId);
    if (!next) return;

    this.emitRepairEvent(next, input.reason ?? "snapshot_applied", now);
    this.maybeEmitStaleOrRecoveredEvents(prev, next, now);
  }

  /**
   * Periodic tick for staleness checks and future time-based metrics.
   * Call from a scheduler with a reasonable cadence (e.g. 5–10s).
   */
  tick(now: Date = new Date()): void {
    this.lastTickAt = now;
    for (const asset of this.store.getAssets()) {
      const lastEventAt = asset.health.lastMarketEventAt ?? lastUpdateForAsset(asset);
      const wasStale = asset.health.isStale;
      const wasDegraded = asset.health.isDegraded;
      const nowStale = isStale(lastEventAt, now, this.healthConfig);
      const nowDegraded = isDegraded(lastEventAt, now, this.healthConfig);
      // Update both stale and degraded flags; degraded is a "soft warning" and should clear when the
      // asset recovers (i.e. lastMarketEventAt becomes recent again), rather than latching forever.
      if (nowStale !== wasStale || nowDegraded !== wasDegraded) {
        const healthPatch = {
          isStale: nowStale,
          isDegraded: nowDegraded,
        };
        this.store.patchAsset(asset.assetId, { health: healthPatch });
        const updated = this.store.getAsset(asset.assetId);
        if (!updated) continue;
        this.maybeEmitStaleOrRecoveredEvents(asset, updated, now);
      }
    }
  }

  getAssetState(assetId: string): AssetLiveState | null {
    return this.store.getAsset(assetId);
  }

  getSnapshot() {
    return this.store.snapshot();
  }

  /** Last time tick() was called; null if never. For debug/observability only. */
  getLastTickAt(): Date | null {
    return this.lastTickAt;
  }

  /** Tracked asset IDs (subscription set). For debug/observability only. */
  getTrackedAssetIds(): string[] {
    return this.store.getTrackedAssetIds();
  }

  /** Sync tracked asset set (e.g. when WS subscription changes). */
  setTrackedAssetIds(assetIds: string[]): void {
    const nextSet = new Set(assetIds);
    for (const id of this.store.getTrackedAssetIds()) {
      if (!nextSet.has(id)) this.store.markAssetUntracked(id);
    }
    for (const id of assetIds) {
      this.store.markAssetTracked(id);
    }
  }

  // ---------- Internal helpers ----------

  private buildHealthPatch(prev: AssetLiveState, now: Date): Partial<AssetLiveState["health"]> {
    const lastEventAt = now;
    const stale = isStale(lastEventAt, now, this.healthConfig);
    const degraded = isDegraded(lastEventAt, now, this.healthConfig);
    return {
      isStale: stale,
      isDegraded: degraded,
      lastMarketEventAt: lastEventAt,
    };
  }

  private maybeEmitQuoteEvent(prev: AssetLiveState, next: AssetLiveState, occurredAt: Date): void {
    const prevMid = prev.quote.mid ?? null;
    const nextMid = next.quote.mid ?? null;
    const prevSpreadBps = prev.quote.spreadBps ?? null;
    const nextSpreadBps = next.quote.spreadBps ?? null;

    const midChanged =
      prevMid == null || nextMid == null
        ? prevMid !== nextMid
        : Math.abs(nextMid - prevMid) >= this.thresholds.minMidChangeAbs;

    const spreadChanged =
      prevSpreadBps == null || nextSpreadBps == null
        ? prevSpreadBps !== nextSpreadBps
        : Math.abs(nextSpreadBps - prevSpreadBps) >= this.thresholds.minSpreadBpsChange;

    if (!midChanged && !spreadChanged) return;

    const payload: MarketQuotePayload = {
      assetId: next.assetId,
      marketId: next.market.marketId ?? "",
      outcome: next.outcome,
      bestBid: next.quote.bestBid,
      bestAsk: next.quote.bestAsk,
      midPrice: nextMid,
      lastTradePrice: next.lastTrade.price,
    };

    this.eventBus.publish({
      id: createRuntimeEventId(),
      type: "market.quote.changed",
      source: this.eventSource,
      occurredAt,
      payload,
    });
  }

  private maybeEmitDepthEvent(prev: AssetLiveState, next: AssetLiveState, occurredAt: Date): void {
    const prevTop = prev.depth.imbalanceTop ?? null;
    const nextTop = next.depth.imbalanceTop ?? null;
    const prevNear = prev.depth.imbalance1pct ?? null;
    const nextNear = next.depth.imbalance1pct ?? null;

    const topChanged =
      prevTop == null || nextTop == null
        ? prevTop !== nextTop
        : Math.abs(nextTop - prevTop) >= this.thresholds.minImbalanceChange;

    const nearChanged =
      prevNear == null || nextNear == null
        ? prevNear !== nextNear
        : Math.abs(nextNear - prevNear) >= this.thresholds.minImbalanceChange;

    if (!topChanged && !nearChanged) return;

    const payload: MarketDepthPayload = {
      assetId: next.assetId,
      marketId: next.market.marketId ?? "",
      outcome: next.outcome,
      bestBidSize: (next.depth.bidTopSize ?? 0) as number,
      bestAskSize: (next.depth.askTopSize ?? 0) as number,
      bidDepth: next.depth.bidDepth1pct ?? undefined,
      askDepth: next.depth.askDepth1pct ?? undefined,
    };

    this.eventBus.publish({
      id: createRuntimeEventId(),
      type: "market.depth.changed",
      source: this.eventSource,
      occurredAt,
      payload,
    });
  }

  private maybeEmitLiquidityEvent(prev: AssetLiveState, next: AssetLiveState, occurredAt: Date): void {
    const prevScore = prev.liquidity.qualityScore ?? null;
    const nextScore = next.liquidity.qualityScore ?? null;
    const prevTradable = prev.liquidity.isTradable;
    const nextTradable = next.liquidity.isTradable;

    const scoreChanged =
      prevScore == null || nextScore == null
        ? prevScore !== nextScore
        : Math.abs(nextScore - prevScore) >= this.thresholds.minLiquidityScoreChange;

    const tradableChanged = prevTradable !== nextTradable;

    if (!scoreChanged && !tradableChanged) return;

    const payload: MarketLiquidityPayload = {
      assetId: next.assetId,
      marketId: next.market.marketId ?? "",
      topLiquidity:
        (next.quote.bestBid ?? 0) * (next.depth.bidTopSize ?? 0) +
        (next.quote.bestAsk ?? 0) * (next.depth.askTopSize ?? 0),
      spreadBps: next.quote.spreadBps,
    };

    this.eventBus.publish({
      id: createRuntimeEventId(),
      type: "market.liquidity.changed",
      source: this.eventSource,
      occurredAt,
      payload,
    });
  }

  private maybeEmitStaleOrRecoveredEvents(
    prev: AssetLiveState,
    next: AssetLiveState,
    occurredAt: Date
  ): void {
    const wasStale = prev.health.isStale;
    const isNowStale = next.health.isStale;

    if (!wasStale && isNowStale) {
      const lastUpdateAt = lastUpdateForAsset(next) ?? occurredAt;
      const payload: MarketStalePayload = {
        assetId: next.assetId,
        marketId: next.market.marketId ?? "",
        lastUpdateAt,
        staleAfterMs: this.healthConfig.staleAfterMs,
      };
      this.eventBus.publish({
        id: createRuntimeEventId(),
        type: "market.stale",
        source: this.eventSource,
        occurredAt,
        payload,
      });
      return;
    }

    const lastEventAt = next.health.lastMarketEventAt ?? lastUpdateForAsset(next);
    if (wasStale && !isNowStale && isRecovered(lastEventAt, occurredAt, this.healthConfig)) {
      const payload: MarketRecoveredPayload = {
        assetId: next.assetId,
        marketId: next.market.marketId ?? "",
        recoveredAt: occurredAt,
      };
      this.eventBus.publish({
        id: createRuntimeEventId(),
        type: "market.recovered",
        source: this.eventSource,
        occurredAt,
        payload,
      });
    }
  }

  private emitTradeEvent(next: AssetLiveState, input: TradeUpdateInput): void {
    this.eventBus.publish({
      id: createRuntimeEventId(),
      type: "market.trade.printed",
      source: this.eventSource,
      occurredAt: input.at ?? new Date(),
      payload: {
        assetId: next.assetId,
        marketId: next.market.marketId ?? "",
        outcome: next.outcome,
        price: input.price,
        size: input.size,
        side: input.side,
      },
    });
  }

  private emitRepairEvent(next: AssetLiveState, reason: string, occurredAt: Date): void {
    this.eventBus.publish({
      id: createRuntimeEventId(),
      type: "market.repaired",
      source: this.eventSource,
      occurredAt,
      payload: {
        assetId: next.assetId,
        marketId: next.market.marketId ?? "",
        reason,
        repairedAt: occurredAt,
      },
    });
  }
}

