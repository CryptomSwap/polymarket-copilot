/**
 * Worker WebSocket layer: user feed (authenticated) and market feed (tracked assets).
 * Reconnect and status handled in lib. Dynamic tracked asset set refreshed periodically.
 * Market feed updates are normalized and fed into MarketStateEngine (additive; existing
 * stream health/repair logic unchanged). engine.tick() runs on a timer for staleness.
 * User feed order/fill events are normalized and fed into OrderLifecycleHandler and
 * RuntimePositionUpdater (execution-plane order + inventory); existing persist/drift
 * paths unchanged.
 */

import { createUserWs, defaultWsUserLog } from "../lib/polymarket/ws-user";
import { createMarketWs, type MarketSubscriptionCoverage } from "../lib/polymarket/ws-market";
import type { StreamConnectionState } from "../lib/runtime/stream-connection-state";
import { getTrackedAssetIds } from "../lib/polymarket/tracked-assets";
import { getFunderForRecompute } from "../lib/polymarket/recompute";
import { updateStreamSyncState, getStreamSyncState, shouldRetryTrackedAssetsWithNoFunder } from "../lib/live/streaming-sync";
import { normalizeMarketFeedMessage, feedNormalizedUpdatesToEngine } from "../lib/live/market-feed-normalizer";
import { normalizeUserFeedMessage } from "../lib/live/user-feed-normalizer";
import { feedUserFeedResultToRuntime, type UserFeedRuntimeTelemetry } from "../lib/live/user-feed-to-runtime";
import type { RuntimeLatencyMonitor } from "../lib/runtime/telemetry/runtime-latency-monitor";
import { InMemoryRuntimeEventBus } from "../lib/runtime/events/runtime-event-bus";
import { InMemoryMarketStateStore } from "../lib/runtime/market-state/market-state-store";
import { MarketStateEngine } from "../lib/runtime/market-state/market-state-engine";
import { setMarketStateEngineForDebug } from "../lib/runtime/market-state/market-state-engine-debug";
import { InMemoryOrderLifecycleStore } from "../lib/runtime/order-manager/order-lifecycle-store";
import { DefaultOrderLifecycleHandler } from "../lib/runtime/order-manager/order-lifecycle-handler";
import { InMemoryRuntimePositionStore } from "../lib/runtime/positions/runtime-position-store";
import { DefaultRuntimePositionUpdater } from "../lib/runtime/positions/runtime-position-updater";
import { createDefaultRuntimeRiskState } from "../lib/runtime/risk/runtime-risk-engine";
import { DefaultBotRuntimeContextProvider } from "../lib/runtime/bot-runtime/bot-context";
import { DefaultBotRuntime } from "../lib/runtime/bot-runtime/bot-runtime";
import { setBotRuntimeForDebug } from "../lib/runtime/bot-runtime/bot-runtime-debug";

const TRACKED_ASSETS_REFRESH_MS = 90_000;
const MARKET_STATE_TICK_MS = 10_000;
const BOT_COALESCE_MS = 50;

let userWs: ReturnType<typeof createUserWs> | null = null;
let marketWs: ReturnType<typeof createMarketWs> | null = null;
let refreshInterval: ReturnType<typeof setInterval> | null = null;
let marketStateEngine: MarketStateEngine | null = null;
let marketStateTickInterval: ReturnType<typeof setInterval> | null = null;
let orderLifecycleHandler: DefaultOrderLifecycleHandler | null = null;
let runtimePositionUpdater: DefaultRuntimePositionUpdater | null = null;
let botRuntime: DefaultBotRuntime | null = null;
let orderStore: InMemoryOrderLifecycleStore | null = null;

/** Deps supplied by StreamRuntime when it owns the graph. */
export interface StreamRuntimeDepsForWs {
  eventBus: import("@/lib/runtime/events/runtime-event-bus").InMemoryRuntimeEventBus;
  marketStateStore: InMemoryMarketStateStore;
  marketStateEngine: MarketStateEngine;
  positionStore: InMemoryRuntimePositionStore;
  positionUpdater: DefaultRuntimePositionUpdater;
  orderStore: InMemoryOrderLifecycleStore;
  orderLifecycleHandler: DefaultOrderLifecycleHandler;
  botRuntime: DefaultBotRuntime;
  /** Called after feeding normalized market updates to the engine (for diagnostics.marketUpdatesApplied). */
  onMarketUpdatesApplied?: (count: number) => void;
  /** Optional latency/integrity monitor for stream-to-engine and normalization timing. */
  latencyMonitor?: RuntimeLatencyMonitor | null;
}

/** Real connection state for health/dashboard/snapshot. */
export function getStreamConnectionStates(): {
  market: StreamConnectionState | null;
  user: StreamConnectionState | null;
} {
  const market =
    marketWs && "getConnectionState" in marketWs
      ? (marketWs as { getConnectionState(): StreamConnectionState }).getConnectionState()
      : null;
  const user =
    userWs && "getConnectionState" in userWs
      ? (userWs as { getConnectionState(): StreamConnectionState }).getConnectionState()
      : null;
  return { market, user };
}

/** Connection/activity status for health reporting. Uses real connection state. */
export function getStreamRuntimeStatus(): {
  marketWsActive: boolean;
  userWsActive: boolean;
  marketConnection: StreamConnectionState | null;
  userConnection: StreamConnectionState | null;
} {
  const { market, user } = getStreamConnectionStates();
  return {
    marketWsActive: !!(market?.status === "open"),
    userWsActive: !!(user?.status === "open"),
    marketConnection: market,
    userConnection: user,
  };
}

/** Market WS subscription coverage (desired vs subscribed, pending, churn). Null if no market WS. */
export function getMarketSubscriptionCoverage(): MarketSubscriptionCoverage | null {
  if (!marketWs || typeof (marketWs as { getSubscriptionCoverage?: () => MarketSubscriptionCoverage }).getSubscriptionCoverage !== "function") {
    return null;
  }
  return (marketWs as { getSubscriptionCoverage: () => MarketSubscriptionCoverage }).getSubscriptionCoverage();
}

/** Telemetry for user-feed → runtime (lifecycle applied, unmatched, mismatches). Read-only for observers. */
export const userFeedRuntimeTelemetry: UserFeedRuntimeTelemetry = {
  lifecycleApplied: 0,
  unmatchedOrderEvents: 0,
  lifecycleMismatch: 0,
  fillLedgerDuplicatesSkipped: 0,
};

async function refreshTrackedAssetsAndSubscriptions(): Promise<void> {
  const funder = await getFunderForRecompute();
  const assetIds = await getTrackedAssetIds({ funderAddress: funder ?? undefined });
  await updateStreamSyncState({ trackedAssetCount: assetIds.length });

  if (marketWs) {
    // Do not overwrite with empty when we had a non-empty set (avoids clearing due to transient empty result).
    if (assetIds.length > 0) {
      marketWs.setTrackedAssetIds(assetIds);
      if (marketStateEngine) marketStateEngine.setTrackedAssetIds(assetIds);
    }
    return;
  }
  if (assetIds.length === 0) return;

  const log = defaultWsUserLog;
  marketWs = createMarketWs(assetIds);
  if (marketStateEngine) {
    marketWs.onMessage((msg) => {
      try {
        const updates = normalizeMarketFeedMessage(msg);
        feedNormalizedUpdatesToEngine(updates, marketStateEngine);
      } catch (e) {
        log("warn", "Market feed normalizer error", { error: String(e) });
      }
    });
  }
  marketWs.connect().then(
    () => log("info", "Market WebSocket connected", { marketCount: assetIds.length }),
    (err) => log("error", "Market WebSocket connect failed", { error: String(err) })
  );
}

export async function startWebsockets(): Promise<void> {
  const log = defaultWsUserLog;

  const eventBus = new InMemoryRuntimeEventBus();
  const marketStateStore = new InMemoryMarketStateStore();
  marketStateEngine = new MarketStateEngine({ store: marketStateStore, eventBus });
  setMarketStateEngineForDebug(marketStateEngine);
  marketStateTickInterval = setInterval(() => {
    try {
      if (marketStateEngine) marketStateEngine.tick();
    } catch (err) {
      defaultWsUserLog("error", "Market state engine tick failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, MARKET_STATE_TICK_MS);

  orderStore = new InMemoryOrderLifecycleStore();
  orderLifecycleHandler = new DefaultOrderLifecycleHandler({ store: orderStore, eventBus });
  const positionStore = new InMemoryRuntimePositionStore();
  runtimePositionUpdater = new DefaultRuntimePositionUpdater({ store: positionStore, eventBus, eventSource: "user_ws" });

  const funder = await getFunderForRecompute();
  const riskState = createDefaultRuntimeRiskState({ grossExposure: 0, netExposure: 0 });
  const contextProvider = new DefaultBotRuntimeContextProvider(
    {
      marketStateStore,
      positionStore,
      getOpenOrdersForAsset: (f, a) => orderStore!.listOpenByAsset(f, a),
    },
    riskState
  );
  botRuntime = new DefaultBotRuntime({
    contextProvider,
    eventBus,
    funderAddress: funder ?? "",
    strategyId: "default",
    coalesceMs: BOT_COALESCE_MS,
    marketStateStore,
    getOpenOrdersForAsset: (f, a) => orderStore!.listOpenByAsset(f, a),
  });
  botRuntime.start();
  setBotRuntimeForDebug(botRuntime);
  userWs = createUserWs({ log });
  userWs.onMessage((msg) => {
    const result = normalizeUserFeedMessage(funder ?? "", msg);
    if (result && orderStore) {
      void feedUserFeedResultToRuntime(result, {
        orderStore,
        lifecycleHandler: orderLifecycleHandler,
        fillLedgerEnabled: true,
        log: (level, message, meta) => log(level === "warn" ? "warn" : "info", message, meta),
        telemetry: userFeedRuntimeTelemetry,
      }).catch((e) => log("warn", "User feed to runtime error", { error: String(e) }));
    }
  });
  userWs.connect().then(
    () => log("info", "User WebSocket connected and ready", {}),
    (err) => log("error", "User WebSocket connect failed", { error: String(err) })
  );

  const assetIds = await getTrackedAssetIds({ funderAddress: funder ?? undefined });
  await updateStreamSyncState({ trackedAssetCount: assetIds.length });

  if (assetIds.length > 0) {
    if (marketStateEngine) marketStateEngine.setTrackedAssetIds(assetIds);
    marketWs = createMarketWs(assetIds);
    marketWs.onMessage((msg) => {
      try {
        const updates = normalizeMarketFeedMessage(msg);
        feedNormalizedUpdatesToEngine(updates, marketStateEngine);
      } catch (e) {
        log("warn", "Market feed normalizer error", { error: String(e) });
      }
    });
    marketWs.connect().then(
      () => log("info", "Market WebSocket connected", { marketCount: assetIds.length }),
      (err) => log("error", "Market WebSocket connect failed", { error: String(err) })
    );
  } else {
    log("info", "Market WebSocket deferred (no tracked assets yet)", {});
  }

  refreshInterval = setInterval(() => {
    refreshTrackedAssetsAndSubscriptions().catch((err) =>
      log("error", "refreshTrackedAssets failed", { error: String(err) })
    );
  }, TRACKED_ASSETS_REFRESH_MS);
}

/**
 * Start WebSockets using runtime-owned deps (from StreamRuntime). Call from StreamRuntime.start().
 * Does not create engine/store/bot or market tick interval; runtime owns those.
 */
export async function startWebsocketsWithRuntime(
  deps: StreamRuntimeDepsForWs,
  funderOverride: string | null
): Promise<void> {
  const log = defaultWsUserLog;
  marketStateEngine = deps.marketStateEngine;
  orderStore = deps.orderStore;
  orderLifecycleHandler = deps.orderLifecycleHandler;
  runtimePositionUpdater = deps.positionUpdater;
  botRuntime = deps.botRuntime;

  const funder = funderOverride ?? (await getFunderForRecompute()) ?? "";
  userWs = createUserWs({ log });
  userWs.onMessage((msg) => {
    const receivedAt = Date.now();
    const normStart = Date.now();
    const result = normalizeUserFeedMessage(funder, msg);
    deps.latencyMonitor?.recordUserNormalizationMs(Date.now() - normStart);
    if (!result) {
      deps.latencyMonitor?.recordMalformedUserPayload();
      return;
    }
    if (orderStore) {
      const beforeApply = Date.now();
      void feedUserFeedResultToRuntime(result, {
        orderStore,
        lifecycleHandler: orderLifecycleHandler,
        fillLedgerEnabled: true,
        log: (level, message, meta) => log(level === "warn" ? "warn" : "info", message, meta),
        telemetry: userFeedRuntimeTelemetry,
        onUnmatchedExchangeOrderId: () => deps.latencyMonitor?.recordUnmatchedExchangeOrderId(),
        onDuplicateLifecycleEvent: () => deps.latencyMonitor?.recordDuplicateLifecycleEvent(),
      })
        .then(() => {
          deps.latencyMonitor?.recordUserStreamToEngineMs(Date.now() - receivedAt);
          deps.latencyMonitor?.recordLifecycleApplyMs(Date.now() - beforeApply);
        })
        .catch((e) => log("warn", "User feed to runtime error", { error: String(e) }));
    } else {
      deps.latencyMonitor?.recordUserStreamToEngineMs(Date.now() - receivedAt);
    }
  });
  userWs.connect().then(
    () => log("info", "User WebSocket connected and ready", {}),
    (err) => log("error", "User WebSocket connect failed", { error: String(err) })
  );

  let assetIds = await getTrackedAssetIds({ funderAddress: funder || undefined });
  if (shouldRetryTrackedAssetsWithNoFunder(assetIds, (await getStreamSyncState())?.trackedAssetCount ?? null)) {
    assetIds = await getTrackedAssetIds({ funderAddress: undefined });
  }
  await updateStreamSyncState({ trackedAssetCount: assetIds.length });
  if (marketStateEngine) marketStateEngine.setTrackedAssetIds(assetIds);

  if (assetIds.length > 0) {
    marketWs = createMarketWs(assetIds);
    marketWs.onMessage((msg) => {
      const receivedAt = Date.now();
      try {
        const normStart = Date.now();
        const updates = normalizeMarketFeedMessage(msg);
        deps.latencyMonitor?.recordMarketNormalizationMs(Date.now() - normStart);
        if (msg != null && updates.length === 0) {
          deps.latencyMonitor?.recordMalformedMarketPayload();
        }
        const applyStart = Date.now();
        feedNormalizedUpdatesToEngine(updates, marketStateEngine);
        deps.latencyMonitor?.recordMarketEngineApplyMs(Date.now() - applyStart);
        deps.latencyMonitor?.recordMarketStreamToEngineMs(Date.now() - receivedAt);
        if (updates.length > 0) deps.onMarketUpdatesApplied?.(updates.length);
      } catch (e) {
        log("warn", "Market feed normalizer error", { error: String(e) });
        deps.latencyMonitor?.recordMalformedMarketPayload();
      }
    });
    marketWs.connect().then(
      () => log("info", "Market WebSocket connected", { marketCount: assetIds.length }),
      (err) => log("error", "Market WebSocket connect failed", { error: String(err) })
    );
  } else {
    log("info", "Market WebSocket deferred (no tracked assets yet)", {});
  }

  refreshInterval = setInterval(() => {
    refreshTrackedAssetsAndSubscriptions().catch((err) =>
      log("error", "refreshTrackedAssets failed", { error: String(err) })
    );
  }, TRACKED_ASSETS_REFRESH_MS);
}

export function stopWebsockets(): void {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
  if (marketStateTickInterval) {
    clearInterval(marketStateTickInterval);
    marketStateTickInterval = null;
  }
  // Close websockets first to stop message flow, then null dependent refs (reduces late-message race).
  if (userWs) {
    userWs.close();
    userWs = null;
  }
  if (marketWs) {
    marketWs.close();
    marketWs = null;
  }
  marketStateEngine = null;
  orderLifecycleHandler = null;
  runtimePositionUpdater = null;
  orderStore = null;
  setBotRuntimeForDebug(null);
  if (botRuntime) {
    botRuntime.stop();
    botRuntime = null;
  }
}
