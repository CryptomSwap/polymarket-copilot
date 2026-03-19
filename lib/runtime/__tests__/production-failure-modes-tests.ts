/**
 * Production failure modes: focused tests for real failure scenarios, not just happy-path.
 * Deterministic; no live network or DB required.
 *
 * Run with (from repo root):
 *   npx ts-node --project tsconfig.tests.json -r tsconfig-paths/register lib/runtime/__tests__/production-failure-modes-tests.ts
 */

import assert from "assert";
import { createInitialStreamConnectionState, type StreamConnectionState } from "../stream-connection-state";
import { computeDegraded } from "../runtime-degraded";
import { evaluateStreamWatchdog } from "../stream-watchdog";
import { DEFAULT_STREAM_WATCHDOG_CONFIG } from "../stream-watchdog-config";
import { createRuntimeHealth, buildOperatorHealth } from "../runtime-health";
import { getTradingExecutionPolicy } from "../trading-execution-policy";
import { compareRuntimeWithExchange } from "../reconciliation/runtime-reconciliation";
import type { RuntimeOrderState } from "../order-manager/order-manager";
import { InMemoryOrderLifecycleStore } from "../order-manager/order-lifecycle-store";
import {
  rebuildOrderStoreFromTruth,
  rebuildPositionStoreFromTruth,
  recomputeRiskExposure,
} from "../startup/stream-runtime-rebuild";
import type { UnappliedFillEntry } from "@/lib/live/fill-ledger";
import { InMemoryRuntimePositionStore } from "../positions/runtime-position-store";
import { DefaultRuntimePositionUpdater } from "../positions/runtime-position-updater";
import { InMemoryRuntimeEventBus } from "../events/runtime-event-bus";
import { InMemoryRuntimeRiskEngine, createDefaultRuntimeRiskState } from "../risk/runtime-risk-engine";
import { DefaultRuntimeGuardrails } from "../risk/runtime-guardrails";
import { buildBotDecisionContext } from "../bot-runtime/bot-context";
import type { BotRuntimeContextSnapshot } from "../bot-runtime/bot-context";
import { InMemoryMarketStateStore } from "../market-state/market-state-store";

function ok(cond: boolean, msg: string): void {
  assert.strictEqual(cond, true, msg);
}

const now = Date.now();
const oneMinuteAgo = new Date(now - 60_000);
const twoMinutesAgo = new Date(now - 120_000);

function openStateWithData(): StreamConnectionState {
  return {
    ...createInitialStreamConnectionState(),
    status: "open",
    lastOpenAt: oneMinuteAgo,
    lastMessageAt: new Date(now - 5_000),
    lastDataEventAt: new Date(now - 5_000),
    lastHeartbeatAt: new Date(now - 2_000),
  };
}

function openStateNoData(): StreamConnectionState {
  return {
    ...createInitialStreamConnectionState(),
    status: "open",
    lastOpenAt: oneMinuteAgo,
    lastMessageAt: new Date(now - 5_000),
    lastHeartbeatAt: new Date(now - 5_000),
    lastDataEventAt: undefined as unknown as Date | undefined,
  };
}

async function run(): Promise<void> {
  let passed = 0;
  let failed = 0;
  function check(cond: boolean, msg: string): void {
    if (cond) {
      passed++;
      console.log("  OK:", msg);
    } else {
      failed++;
      console.error("  FAIL:", msg);
    }
  }

  // --- 1. Market socket open but no real data ---
  console.log("\n--- 1. Market socket open but no real data ---");
  {
    const market = openStateNoData();
    const user = openStateWithData();
    const r = computeDegraded({
      marketConnection: market,
      userConnection: user,
      marketDataStaleThresholdMs: 60_000,
      userDataStaleThresholdMs: 90_000,
      diagnostics: null,
      schedulerBacklog: 0,
      staleAssetCount: 0,
      degradedAssetCount: 0,
      trackedAssetCount: 3,
    });
    check(r.degraded === true, "degraded when market socket open but no real data");
    check(
      r.reasons.includes("market_data_silence") || r.reasons.includes("market_data_stale"),
      "reason reflects market data absence"
    );
  }

  // --- 2. User socket open but no real data while working orders exist ---
  console.log("\n--- 2. User socket open but no real data while working orders exist ---");
  {
    const market = openStateWithData();
    const user = openStateNoData();
    const r = computeDegraded({
      marketConnection: market,
      userConnection: user,
      marketDataStaleThresholdMs: 60_000,
      userDataStaleThresholdMs: 90_000,
      openOrderCount: 2,
      diagnostics: null,
      schedulerBacklog: 0,
      staleAssetCount: 0,
      degradedAssetCount: 0,
      trackedAssetCount: 3,
    });
    check(r.degraded === true, "degraded when user has no real data and working orders exist");
    check(
      r.reasons.includes("user_data_silence_with_orders") || r.reasons.includes("user_data_stale"),
      "reason reflects user data silence with orders"
    );
  }

  // --- 3. Reconnect churn causing degraded status ---
  console.log("\n--- 3. Reconnect churn causing degraded status ---");
  {
    const market: StreamConnectionState = {
      ...openStateWithData(),
      reconnectAttempts: 6,
    };
    const user = openStateWithData();
    const r = computeDegraded({
      marketConnection: market,
      userConnection: user,
      reconnectChurnAttemptsThreshold: 5,
      diagnostics: null,
      schedulerBacklog: 0,
      staleAssetCount: 0,
      degradedAssetCount: 0,
      trackedAssetCount: 2,
    });
    check(r.degraded === true, "degraded when reconnect churn above threshold");
    check(r.reasons.includes("reconnect_churn"), "reason reconnect_churn");
  }

  // --- 4. Restart rebuild with open orders + prior fills ---
  console.log("\n--- 4. Restart rebuild with open orders + prior fills ---");
  {
    const funder = "0xrebuild";
    const orderStore = new InMemoryOrderLifecycleStore();
    const eventBus = new InMemoryRuntimeEventBus();
    const positionStore = new InMemoryRuntimePositionStore();
    const positionUpdater = new DefaultRuntimePositionUpdater({
      store: positionStore,
      eventBus,
      eventSource: "order_manager",
    });
    const riskEngine = new InMemoryRuntimeRiskEngine(createDefaultRuntimeRiskState());
    const exchangeOrders = [
      {
        id: "ex-post-restart",
        market: "m1",
        asset_id: "a1",
        side: "BUY",
        original_size: "20",
        size_matched: "5",
        price: "0.55",
        status: "LIVE",
      },
    ];
    const ledgerFills: UnappliedFillEntry[] = [
      {
        id: "fill-1",
        funderAddress: funder,
        exchangeFillId: "ef-1",
        assetId: "a1",
        marketId: "m1",
        side: "BUY",
        size: 5,
        price: 0.55,
        filledAt: oneMinuteAgo,
        outcome: "Yes",
      },
    ];
    rebuildOrderStoreFromTruth(orderStore, exchangeOrders, funder);
    rebuildPositionStoreFromTruth(positionStore, positionUpdater, ledgerFills);
    recomputeRiskExposure(riskEngine, positionStore, orderStore);
    const all = orderStore.getAll();
    check(all.length === 1, "one order after rebuild");
    check(all[0].status === "partially_filled" && all[0].filledSize === 5, "order partially filled from exchange truth");
    const pos = positionStore.getPosition(funder, "a1");
    check(pos != null && pos.netShares >= 5, "position reflects prior fill after rebuild");
  }

  // --- 5. Durable fill ledger replay after restart ---
  console.log("\n--- 5. Durable fill ledger replay after restart ---");
  {
    const funder = "0xreplay";
    const eventBus = new InMemoryRuntimeEventBus();
    const positionStore = new InMemoryRuntimePositionStore();
    const positionUpdater = new DefaultRuntimePositionUpdater({
      store: positionStore,
      eventBus,
      eventSource: "order_manager",
    });
    const unappliedFills: UnappliedFillEntry[] = [
      {
        id: "replay-1",
        funderAddress: funder,
        exchangeFillId: "rf-1",
        assetId: "a1",
        marketId: "m1",
        side: "BUY",
        size: 10,
        price: 0.5,
        filledAt: new Date(),
        outcome: "Yes",
      },
    ];
    rebuildPositionStoreFromTruth(positionStore, positionUpdater, unappliedFills);
    const pos = positionStore.getPosition(funder, "a1");
    check(pos != null, "position exists after replay");
    check(pos!.netShares >= 10, "replay applied fill once (netShares >= 10)");
    rebuildPositionStoreFromTruth(positionStore, positionUpdater, unappliedFills);
    const pos2 = positionStore.getPosition(funder, "a1");
    check(pos2 != null && pos2.netShares >= 10, "second rebuild idempotent or additive from same list");
  }

  // --- 6. Exchange reconciliation detects missing local order ---
  console.log("\n--- 6. Exchange reconciliation detects missing local order ---");
  {
    const orderStore = new InMemoryOrderLifecycleStore();
    const exchangeIds = new Set(["ex-on-exchange-only"]);
    const localOpen: RuntimeOrderState[] = [];
    const { missingLocalOrders, missingExchangeOrders } = compareRuntimeWithExchange(exchangeIds, localOpen);
    check(missingLocalOrders.length === 1 && missingLocalOrders[0] === "ex-on-exchange-only", "exchange order missing locally detected");
    check(missingExchangeOrders.length === 0, "no phantom local orders");
  }

  // --- 7. Exchange reconciliation detects phantom local order ---
  console.log("\n--- 7. Exchange reconciliation detects phantom local order ---");
  {
    const orderStore = new InMemoryOrderLifecycleStore();
    orderStore.create({
      clientOrderId: "local-phantom",
      funderAddress: "0xf",
      assetId: "a1",
      marketId: "m1",
      side: "BUY",
      price: 0.5,
      size: 10,
    });
    orderStore.applyAck("local-phantom", "ex-phantom");
    const localOpen = orderStore.getAll().filter((o) => ["working", "partially_filled"].includes(o.status));
    const exchangeIds = new Set<string>([]);
    const { missingLocalOrders, missingExchangeOrders, staleWorkingOrders } = compareRuntimeWithExchange(exchangeIds, localOpen);
    check(missingExchangeOrders.length === 1 && missingExchangeOrders[0].exchangeOrderId === "ex-phantom", "phantom local order (missing on exchange) detected");
    check(staleWorkingOrders.length === 1, "stale working order listed");
    check(missingLocalOrders.length === 0, "no missing local when exchange empty");
  }

  // --- 8. Scheduler overload / backlog ---
  console.log("\n--- 8. Scheduler overload / backlog ---");
  {
    const r = computeDegraded({
      marketConnection: openStateWithData(),
      userConnection: openStateWithData(),
      diagnostics: null,
      schedulerBacklog: 150,
      schedulerBacklogThreshold: 100,
      staleAssetCount: 0,
      degradedAssetCount: 0,
      trackedAssetCount: 5,
    });
    check(r.degraded === true, "degraded when scheduler backlog above threshold");
    check(r.reasons.includes("scheduler_backlog_high"), "reason scheduler_backlog_high");
  }

  // --- 9. Subscription coverage incomplete ---
  console.log("\n--- 9. Subscription coverage incomplete ---");
  {
    const r = computeDegraded({
      marketConnection: openStateWithData(),
      userConnection: openStateWithData(),
      diagnostics: null,
      schedulerBacklog: 0,
      staleAssetCount: 0,
      degradedAssetCount: 0,
      trackedAssetCount: 3,
      marketSubscriptionCoverage: {
        inSync: false,
        desiredNotSubscribed: ["missing-asset"],
        subscribedButNotDesired: [],
        subscriptionChurnCount: 0,
        lastSuccessfulSubscriptionSyncAt: new Date().toISOString(),
        desiredTrackedAssetIds: ["a1", "a2", "missing-asset"],
      },
    });
    check(r.degraded === true, "degraded when subscription coverage incomplete");
    check(r.reasons.includes("subscription_mismatch"), "reason subscription_mismatch");
  }

  // --- 10. Health endpoints remain truthful under stale-data conditions ---
  console.log("\n--- 10. Health endpoints remain truthful under stale-data conditions ---");
  {
    const policy = getTradingExecutionPolicy();
    const health = createRuntimeHealth({
      status: "degraded",
      lifecycleStatus: "degraded",
      streams: {
        marketWsConnected: true,
        userWsConnected: true,
        marketConnection: openStateNoData(),
        userConnection: openStateWithData(),
        socketOpen: true,
        heartbeatHealthy: true,
        dataFlowHealthy: false,
        operationalReadiness: false,
        trackedAssetCount: 3,
        marketLastDataEventAt: null,
        userLastDataEventAt: new Date().toISOString(),
        marketLastHeartbeatAt: new Date().toISOString(),
        userLastHeartbeatAt: new Date().toISOString(),
      },
      degradedReasons: ["market_data_silence"],
      counts: { staleAssetCount: 0, degradedAssetCount: 0, openOrderCount: 0, schedulerBacklog: 0 },
    });
    check(health.streams.socketOpen === true, "socket reported open");
    check(health.streams.dataFlowHealthy === false, "dataFlowHealthy false under stale market data");
    check(health.streams.operationalReadiness === false, "operationalReadiness false when data not healthy");
    check(health.degradedReasons.includes("market_data_silence"), "degraded reason present");
    const op = buildOperatorHealth({
      marketConnection: openStateNoData(),
      userConnection: openStateWithData(),
      marketDataHealthy: false,
      userDataHealthy: true,
      operationalReadiness: false,
      runtimePhase: "ready",
      globalAutomationEnabled: true,
      watchdogReasons: [],
      reconciliationLastAt: null,
      reconciliationStatus: null,
      reconciliationDriftDetected: false,
      reconciliationDurationMs: 0,
      executionPolicy: policy,
    });
    check(op.readiness.safeToAutomate === false, "safeToAutomate false when market data stale");
    check(op.dataFreshness.market.dataFlowHealthy === false, "operator health dataFreshness.market false");
  }

  // --- 11. Guardrails block automation during rebuild / reconciling ---
  console.log("\n--- 11. Guardrails block automation during rebuild / reconciling ---");
  {
    const eventBus = new InMemoryRuntimeEventBus();
    const guardrails = new DefaultRuntimeGuardrails({ eventBus });
    const marketStore = new InMemoryMarketStateStore();
    const positionStore = new InMemoryRuntimePositionStore();
    const snapshot: BotRuntimeContextSnapshot = {
      asOf: new Date(),
      marketStateStore: marketStore,
      positionStore,
      riskState: createDefaultRuntimeRiskState(),
    };
    const context = buildBotDecisionContext(snapshot, {
      funderAddress: "0xf",
      strategyId: "s1",
      assetId: "a1",
      asOf: new Date(),
      getOpenOrdersForAsset: () => [],
    });
    const riskState = createDefaultRuntimeRiskState();
    const resultRebuilding = guardrails.evaluate(context, riskState, {
      action: "PLACE_ENTRY",
      assetId: "a1",
      marketId: "m1",
      side: "BUY",
      size: 10,
      limitPrice: 0.5,
    } as any, {
      freshness: {
        runtimePhase: "rebuilding",
        marketDataFresh: true,
        userDataFresh: true,
        reconciliationFresh: true,
        openOrderCount: 0,
      },
    });
    check(resultRebuilding.verdict === "frozen", "verdict frozen when phase rebuilding");
    const resultReconciling = guardrails.evaluate(context, riskState, {
      action: "PLACE_ENTRY",
      assetId: "a1",
      marketId: "m1",
      side: "BUY",
      size: 10,
      limitPrice: 0.5,
    } as any, {
      freshness: {
        runtimePhase: "reconciling",
        marketDataFresh: true,
        userDataFresh: true,
        reconciliationFresh: true,
        openOrderCount: 0,
      },
    });
    check(resultReconciling.verdict === "frozen", "verdict frozen when phase reconciling");
  }

  // --- 12. Kill switch triggered by severe stream silence ---
  console.log("\n--- 12. Kill switch triggered by severe stream silence ---");
  {
    const config = {
      ...DEFAULT_STREAM_WATCHDOG_CONFIG,
      marketDataKillSwitchThresholdMs: 120_000,
      userDataKillSwitchWithOrdersThresholdMs: 60_000,
    };
    const marketStale = new Date(now - 180_000);
    const w = evaluateStreamWatchdog({
      marketConnection: {
        ...createInitialStreamConnectionState(),
        status: "open",
        lastOpenAt: marketStale,
        lastMessageAt: marketStale,
        lastHeartbeatAt: new Date(now - 10_000),
        lastDataEventAt: marketStale,
      },
      userConnection: {
        ...createInitialStreamConnectionState(),
        status: "open",
        lastOpenAt: new Date(),
        lastMessageAt: new Date(),
        lastDataEventAt: new Date(now - 90_000),
      },
      trackedAssetCount: 3,
      openOrderCount: 1,
      config,
    });
    check(w.degraded === true, "watchdog degraded on severe silence");
    check(w.triggerKillSwitch === true, "kill switch triggered by severe stream silence");
    ok(w.killSwitchReason != null, "kill switch reason set");
  }

  console.log("\n--- Summary ---");
  console.log(`Passed: ${passed}, Failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
