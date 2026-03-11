/**
 * Runtime core unit tests: market state, bot scheduler, positions, orders, risk.
 *
 * Run with (from repo root):
 *   npx ts-node --project tsconfig.tests.json -r tsconfig-paths/register lib/runtime/__tests__/runtime-core-tests.ts
 */

import assert from "assert";

import { InMemoryMarketStateStore } from "../market-state/market-state-store";
import { createEmptyAssetState } from "../market-state/market-state-types";
import {
  computeMidFromQuote,
  computeSpreadAbs,
  computeSpreadBps,
  computeTopOfBookImbalance,
} from "../market-state/market-state-metrics";
import { isStale, isDegraded, isRecovered, DEFAULT_HEALTH_CONFIG } from "../market-state/market-state-health";
import { InMemoryRuntimeEventBus } from "../events/runtime-event-bus";
import { MarketStateEngine, type QuoteUpdateInput, type DepthUpdateInput } from "../market-state/market-state-engine";

import { EventDrivenBotScheduler } from "../bot-runtime/bot-scheduler";
import type { BotRuntimeContextProvider, BotRuntimeContextSnapshot } from "../bot-runtime/bot-context";
import { buildBotDecisionContext, DefaultBotRuntimeContextProvider } from "../bot-runtime/bot-context";
import type { BotDecisionEnvelope } from "../bot-runtime/bot-decision-types";
import type { OrderIntentCreatedPayload } from "../events/runtime-events";

import { InMemoryRuntimePositionStore } from "../positions/runtime-position-store";
import { DefaultRuntimePositionUpdater, type NormalizedFillInput } from "../positions/runtime-position-updater";

import { InMemoryOrderLifecycleStore } from "../order-manager/order-lifecycle-store";
import { DefaultOrderLifecycleHandler } from "../order-manager/order-lifecycle-handler";
import { DefaultOrderIntentReconciler } from "../order-manager/order-intent-reconciler";
import { DefaultOrderStaleSweeper } from "../order-manager/order-stale-sweeper";
import type { OrderIntent } from "../order-manager/order-manager";

import { DefaultRuntimeGuardrails } from "../risk/runtime-guardrails";
import { createDefaultRuntimeRiskState, InMemoryRuntimeRiskEngine, type RuntimeRiskState } from "../risk/runtime-risk-engine";
import { isPaperOrLiveStubExecutionAllowed, assertNoLiveOrderPlacement, ROLLOUT_ALLOWED_MODES } from "../runtime-config";
import type { RuntimeConfig } from "../runtime-config";
import { getExposureFromStores, updateRiskExposureFromStores } from "../runtime-exposure";
import {
  normalizedFillFromOrderFilled,
  normalizedFillFromOrderPartialFill,
} from "../positions/runtime-position-updater";
import { DefaultRuntimeDiagnosticsCollector } from "../telemetry/runtime-diagnostics";
import { PaperOrderManager } from "../order-manager/paper-order-manager";
import { PaperExchangeAdapter, LivePolymarketAdapterStub } from "../order-manager/order-exchange-adapter";

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function ok(cond: boolean, msg: string): void {
  assert.strictEqual(cond, true, msg);
}

async function run(): Promise<void> {
  let passed = 0;
  let failed = 0;

  function check(cond: boolean, msg: string): void {
    if (cond) {
      passed++;
      // eslint-disable-next-line no-console
      console.log("  OK:", msg);
    } else {
      failed++;
      // eslint-disable-next-line no-console
      console.error("  FAIL:", msg);
    }
  }

  // ---------- MarketStateStore updates ----------

  // eslint-disable-next-line no-console
  console.log("\nMarketStateStore updates");
  {
    const store = new InMemoryMarketStateStore();
    const base = createEmptyAssetState("a1");
    store.upsertAsset(base);

    const fetched1 = store.getAsset("a1");
    check(!!fetched1, "getAsset returns asset after upsert");
    assert(fetched1);
    check(fetched1.assetId === "a1", "assetId propagated");

    // Patch outcome and quote; ensure copy-on-write (mutating fetched does not affect store)
    store.patchAsset("a1", {
      outcome: "YES",
      quote: { bestBid: 0.4, bestAsk: 0.6, mid: 0.5, spreadAbs: 0.2, spreadBps: 40, updatedAt: new Date() },
    });
    const fetched2 = store.getAsset("a1");
    assert(fetched2);
    check(fetched2.outcome === "YES", "patchAsset updates outcome");
    check(fetched2.quote.bestBid === 0.4 && fetched2.quote.bestAsk === 0.6, "patchAsset updates quote");

    fetched2.quote.bestBid = 0.1;
    const fetched3 = store.getAsset("a1");
    assert(fetched3);
    check(fetched3.quote.bestBid === 0.4, "getAsset returns cloned state (immutability)");
  }

  // ---------- Metric computations ----------

  // eslint-disable-next-line no-console
  console.log("\nMetric computations");
  {
    const mid = computeMidFromQuote(0.4, 0.6);
    check(mid === 0.5, "mid price from quote");

    const spreadAbs = computeSpreadAbs(0.4, 0.6);
    check(spreadAbs === 0.2, "absolute spread");

    const spreadBps = computeSpreadBps(0.4, 0.6, mid);
    check(Math.round(spreadBps ?? 0) === 4000, "spread bps computed from mid");

    const imb = computeTopOfBookImbalance(10, 30);
    check(imb !== null && Math.abs(imb - (-0.5)) < 1e-9, "top-of-book imbalance");
  }

  // ---------- Stale / recovery health transitions ----------

  // eslint-disable-next-line no-console
  console.log("\nHealth transitions");
  {
    const now = new Date();
    const old = new Date(now.getTime() - DEFAULT_HEALTH_CONFIG.staleAfterMs - 1);
    const recent = new Date(now.getTime() - DEFAULT_HEALTH_CONFIG.recoveryGraceMs + 1);

    check(isStale(null, now), "null last event is stale");
    check(isStale(old, now), "old last event is stale");
    check(!isStale(now, now), "fresh event is not stale");

    check(isDegraded(old, now), "old event is degraded");
    check(!isDegraded(now, now), "fresh event is not degraded");

    check(isRecovered(recent, now), "recent event is recovered");
    check(!isRecovered(null, now), "null last event is not recovered");
  }

  // ---------- MarketStateEngine material event thresholds ----------

  // eslint-disable-next-line no-console
  console.log("\nMarketStateEngine thresholds");
  {
    const store = new InMemoryMarketStateStore();
    const bus = new InMemoryRuntimeEventBus();
    const engine = new MarketStateEngine({ store, eventBus: bus });

    let quoteEvents = 0;
    bus.subscribe("market.quote.changed", () => {
      quoteEvents++;
    });

    const q1: QuoteUpdateInput = {
      assetId: "a-thresh",
      bestBid: 0.49,
      bestAsk: 0.51,
      at: new Date(),
    };
    const q2: QuoteUpdateInput = {
      assetId: "a-thresh",
      bestBid: 0.4901,
      bestAsk: 0.5099,
      at: new Date(),
    };

    engine.applyQuoteUpdate(q1);
    engine.applyQuoteUpdate(q2);

    check(quoteEvents === 1, "tiny mid change below threshold does not emit second quote event");

    const q3: QuoteUpdateInput = {
      assetId: "a-thresh",
      bestBid: 0.4,
      bestAsk: 0.6,
      at: new Date(),
    };
    engine.applyQuoteUpdate(q3);
    check(quoteEvents === 2, "material mid change emits second quote event");
  }

  // ---------- BotScheduler coalescing ----------

  // eslint-disable-next-line no-console
  console.log("\nBotScheduler coalescing");
  {
    const marketStore = new InMemoryMarketStateStore();
    const posStore = new InMemoryRuntimePositionStore();
    const snapshot: BotRuntimeContextSnapshot = {
      asOf: new Date(),
      marketStateStore: marketStore,
      positionStore: posStore,
      riskState: createDefaultRuntimeRiskState(),
    };
    const contextProvider: BotRuntimeContextProvider = {
      createSnapshot(): BotRuntimeContextSnapshot {
        return snapshot;
      },
    };

    const envelopes: BotDecisionEnvelope[] = [];
    const scheduler = new EventDrivenBotScheduler(
      { contextProvider, coalesceMs: 10, funderAddress: "f1", strategyId: "s1" },
      (env) => {
        envelopes.push(env);
      }
    );
    scheduler.start();
    scheduler.enqueue("asset-1");
    scheduler.enqueue("asset-1"); // should be coalesced
    scheduler.enqueue("asset-2", "high");

    await sleep(25);

    check(
      envelopes.length === 2 &&
        envelopes.some((e) => e.context.assetId === "asset-1") &&
        envelopes.some((e) => e.context.assetId === "asset-2"),
      "BotScheduler coalesces duplicate asset and drains both assets once"
    );
    scheduler.stop();
  }

  // ---------- RuntimePositionUpdater fill application ----------

  // eslint-disable-next-line no-console
  console.log("\nRuntimePositionUpdater applyFill");
  {
    const store = new InMemoryRuntimePositionStore();
    const bus = new InMemoryRuntimeEventBus();
    const updater = new DefaultRuntimePositionUpdater({
      store,
      eventBus: bus,
      eventSource: "order_manager",
    });

    let events = 0;
    bus.subscribe("position.changed", () => {
      events++;
    });

    const fill: NormalizedFillInput = {
      funderAddress: "f1",
      assetId: "asset-pos",
      marketId: "m-pos",
      outcome: "YES",
      side: "BUY",
      size: 5,
      price: 0.6,
      filledAt: new Date(),
    };

    updater.applyFill(fill);
    const pos = store.getPosition("f1", "asset-pos");
    assert(pos);
    check(pos.netShares === 5, "netShares updated from fill");
    check(events === 1, "position.changed emitted for material fill");
  }

  // ---------- OrderLifecycleStore status transitions ----------

  // eslint-disable-next-line no-console
  console.log("\nOrderLifecycleStore transitions");
  {
    const store = new InMemoryOrderLifecycleStore();
    const created = store.create({
      clientOrderId: "c1",
      funderAddress: "f1",
      assetId: "asset-o",
      marketId: "m-o",
      side: "BUY",
      price: 0.5,
      size: 10,
    });
    check(created.status === "pending_submit", "new order pending_submit");

    store.applyAck("c1", "ex1");
    const acked = store.get("c1");
    assert(acked);
    check(acked.status === "working", "applyAck moves to working");

    store.applyPartialFill("c1", 4, 0.5);
    const partial = store.get("c1");
    assert(partial);
    check(
      partial.status === "partially_filled" && partial.filledSize === 4 && partial.remainingSize === 6,
      "applyPartialFill updates filled/remaining and status"
    );

    store.applyFill("c1", 6, 0.5);
    const filled = store.get("c1");
    assert(filled);
    check(filled.status === "filled" && filled.remainingSize === 0, "applyFill completes order");

    store.applyCancel("c1");
    const afterCancel = store.get("c1");
    assert(afterCancel);
    check(afterCancel.status === "filled", "applyCancel on filled order is no-op (terminal protected)");
  }

  // ---------- Desired-vs-actual order reconciliation ----------

  // eslint-disable-next-line no-console
  console.log("\nOrderIntentReconciler desired-vs-actual");
  {
    const reconciler = new DefaultOrderIntentReconciler();
    const intent: OrderIntent = {
      funderAddress: "f1",
      strategyId: "s1",
      assetId: "asset-r",
      marketId: "m-r",
      side: "BUY",
      limitPrice: 0.5,
      size: 10,
      intentId: "i1",
    };
    const working: any[] = [
      {
        clientOrderId: "c-keep",
        assetId: "asset-r",
        side: "BUY",
        price: 0.5,
        size: 10,
        intentId: "i1",
      },
      {
        clientOrderId: "c-cancel",
        assetId: "asset-r",
        side: "SELL",
        price: 0.6,
        size: 5,
        intentId: null,
      },
    ];

    const { actions } = reconciler.reconcile([intent], working as any);
    const kinds = actions.map((a) => a.kind).sort();
    check(
      kinds.length === 2 && kinds.includes("KEEP") && kinds.includes("CANCEL"),
      "reconciler keeps matching order and cancels stray working order"
    );
  }

  // ---------- StaleOrderSweeper detection ----------

  // eslint-disable-next-line no-console
  console.log("\nStaleOrderSweeper detection");
  {
    const store = new InMemoryOrderLifecycleStore();
    const bus = new InMemoryRuntimeEventBus();
    const sweeper = new DefaultOrderStaleSweeper({
      store,
      eventBus: bus,
      config: {
        pendingSubmitAckThresholdMs: 0,
        workingStaleMs: 0,
      },
    });

    // Pending submit becomes stale immediately with threshold 0
    store.create({
      clientOrderId: "c-stale",
      funderAddress: "f1",
      assetId: "asset-s",
      marketId: "m-s",
      side: "BUY",
      price: 0.5,
      size: 10,
    });

    const recs = sweeper.sweep();
    check(recs.length === 1 && recs[0].clientOrderId === "c-stale", "sweeper detects stale pending submit");
  }

  // ---------- Risk guardrail blocking behavior ----------

  // eslint-disable-next-line no-console
  console.log("\nRisk guardrails blocking");
  {
    const bus = new InMemoryRuntimeEventBus();
    const guardrails = new DefaultRuntimeGuardrails({ eventBus: bus });
    const riskState: RuntimeRiskState = createDefaultRuntimeRiskState({
      exchangeHealth: "unhealthy",
      globalAutomationEnabled: true,
    });

    const context: any = {
      funderAddress: "f1",
      strategyId: "s1",
      asOf: new Date(),
      assetId: "asset-risk",
    };

    const result = guardrails.evaluate(context, riskState, null);
    check(result.verdict === "blocked", "guardrails block when exchange is unhealthy");
  }

  // ---------- Runtime mode: paper/live_stub execution allowed ----------

  // eslint-disable-next-line no-console
  console.log("\nRuntime mode execution gate");
  {
    check(isPaperOrLiveStubExecutionAllowed({ mode: "paper", allowedModes: [], source: "test" }), "paper mode allows execution");
    check(!isPaperOrLiveStubExecutionAllowed({ mode: "observe_only", allowedModes: [], source: "test" }), "observe_only blocks execution");
    check(!isPaperOrLiveStubExecutionAllowed({ mode: "disabled", allowedModes: [], source: "test" }), "disabled blocks execution");
  }

  // ---------- Exposure update from stores ----------

  // eslint-disable-next-line no-console
  console.log("\nExposure update from stores");
  {
    const riskEngine = new InMemoryRuntimeRiskEngine({ grossExposure: 0, netExposure: 0, workingOrderCount: 0 });
    const positionStore = new InMemoryRuntimePositionStore();
    const orderStore = new InMemoryOrderLifecycleStore();
    positionStore.upsertPosition({
      funderAddress: "f1",
      assetId: "a1",
      marketId: "m1",
      outcome: "YES",
      side: "LONG",
      netShares: 100,
      avgEntryPrice: 0.5,
      realizedPnlApprox: 0,
      unrealizedPnlApprox: 0,
      lastFillAt: null,
      exposureNotional: 50,
      confidence: "live",
      openedAt: null,
      updatedAt: new Date(),
    });
    orderStore.create({ clientOrderId: "c1", funderAddress: "f1", assetId: "a1", marketId: "m1", side: "BUY", price: 0.5, size: 10 });
    updateRiskExposureFromStores(riskEngine, positionStore, orderStore);
    const state = riskEngine.getState();
    check(state.grossExposure === 50, "gross exposure updated from position store");
    check(state.netExposure === 50, "net exposure from LONG position");
    check(state.workingOrderCount === 1, "working order count updated from order store");
    positionStore.upsertPosition({
      funderAddress: "f2",
      assetId: "a2",
      marketId: "m2",
      outcome: "YES",
      side: "SHORT",
      netShares: -60,
      avgEntryPrice: 0.5,
      realizedPnlApprox: 0,
      unrealizedPnlApprox: 0,
      lastFillAt: null,
      exposureNotional: 30,
      confidence: "live",
      openedAt: null,
      updatedAt: new Date(),
    });
    updateRiskExposureFromStores(riskEngine, positionStore, orderStore);
    const state2 = riskEngine.getState();
    check(state2.grossExposure === 80, "gross exposure sum of both positions");
    check(state2.netExposure === 20, "net exposure LONG 50 - SHORT 30");
  }

  // ---------- getExposureFromStores (read-only) ----------

  // eslint-disable-next-line no-console
  console.log("\ngetExposureFromStores returns gross and net");
  {
    const positionStore = new InMemoryRuntimePositionStore();
    const orderStore = new InMemoryOrderLifecycleStore();
    positionStore.upsertPosition({
      funderAddress: "f1",
      assetId: "a1",
      marketId: "m1",
      outcome: "YES",
      side: "LONG",
      netShares: 10,
      avgEntryPrice: 0.5,
      realizedPnlApprox: 0,
      unrealizedPnlApprox: 0,
      lastFillAt: null,
      exposureNotional: 5,
      confidence: "live",
      openedAt: null,
      updatedAt: new Date(),
    });
    positionStore.upsertPosition({
      funderAddress: "f1",
      assetId: "a2",
      marketId: "m2",
      outcome: "YES",
      side: "SHORT",
      netShares: -4,
      avgEntryPrice: 0.5,
      realizedPnlApprox: 0,
      unrealizedPnlApprox: 0,
      lastFillAt: null,
      exposureNotional: 2,
      confidence: "live",
      openedAt: null,
      updatedAt: new Date(),
    });
    const snap = getExposureFromStores(positionStore, orderStore);
    check(snap.grossExposure === 7, "gross 5+2");
    check(snap.netExposure === 3, "net 5-2");
  }

  // ---------- order.filled → position updater ----------

  // eslint-disable-next-line no-console
  console.log("\norder.filled updates RuntimePositionStore");
  {
    const store = new InMemoryRuntimePositionStore();
    const bus = new InMemoryRuntimeEventBus();
    const updater = new DefaultRuntimePositionUpdater({ store, eventBus: bus, eventSource: "order_manager" });
    const payload = {
      funderAddress: "f1",
      assetId: "asset-fill",
      marketId: "m-fill",
      side: "BUY" as const,
      totalFilledSize: 3,
      avgPrice: 0.55,
      filledAt: new Date(),
    };
    const fill = normalizedFillFromOrderFilled(payload);
    updater.applyFill(fill);
    const pos = store.getPosition("f1", "asset-fill");
    assert(pos);
    check(pos.netShares === 3 && pos.avgEntryPrice === 0.55, "position updated from order.filled payload");
  }

  // ---------- order.partial_fill (delta) updates position incrementally ----------

  // eslint-disable-next-line no-console
  console.log("\norder.partial_fill delta updates RuntimePositionStore");
  {
    const store = new InMemoryRuntimePositionStore();
    const bus = new InMemoryRuntimeEventBus();
    const updater = new DefaultRuntimePositionUpdater({ store, eventBus: bus, eventSource: "order_manager" });
    const order = { marketId: "m1", side: "BUY" as const };
    const payload1 = { funderAddress: "f1", assetId: "a1", filledSize: 2, fillPrice: 0.5, filledAt: new Date() };
    const fill1 = normalizedFillFromOrderPartialFill(payload1, order, 2);
    updater.applyFill(fill1);
    const pos1 = store.getPosition("f1", "a1");
    assert(pos1);
    check(pos1.netShares === 2, "position after first partial (size 2)");
    const payload2 = { funderAddress: "f1", assetId: "a1", filledSize: 5, fillPrice: 0.52, filledAt: new Date() };
    const fill2 = normalizedFillFromOrderPartialFill(payload2, order, 3);
    updater.applyFill(fill2);
    const pos2 = store.getPosition("f1", "a1");
    assert(pos2);
    check(pos2.netShares === 5, "position after second partial (cumulative 5, delta 3)");
  }

  // ---------- Diagnostics: intent blocked and position counters ----------

  // eslint-disable-next-line no-console
  console.log("\nDiagnostics records intent blocked and position updates");
  {
    const collector = new DefaultRuntimeDiagnosticsCollector();
    collector.recordIntentBlockedByMode("observe_only");
    collector.recordIntentBlockedByMode("observe_only");
    collector.recordIntentBlockedByGuardrails();
    collector.recordPositionUpdate();
    collector.recordPositionUpdate();
    collector.recordExposureUpdate();
    const snap = collector.getSnapshot();
    check((snap.intentsBlockedByMode?.observe_only ?? 0) === 2, "intentsBlockedByMode.observe_only");
    check((snap.intentsBlockedByGuardrails ?? 0) === 1, "intentsBlockedByGuardrails");
    check((snap.positionUpdates ?? 0) === 2, "positionUpdates");
    check((snap.exposureUpdates ?? 0) === 1, "exposureUpdates");
  }

  // ---------- PaperOrderManager rejects live adapter ----------

  // eslint-disable-next-line no-console
  console.log("\nPaperOrderManager rejects live adapter");
  {
    const store = new InMemoryOrderLifecycleStore();
    const reconciler = new DefaultOrderIntentReconciler();
    const liveStubAdapter = new LivePolymarketAdapterStub();
    const orderManager = new PaperOrderManager({
      store,
      reconciler,
      adapter: liveStubAdapter,
    });
    const intent: OrderIntent = {
      funderAddress: "f1",
      strategyId: "s1",
      assetId: "a1",
      marketId: "m1",
      side: "BUY",
      limitPrice: 0.5,
      size: 10,
      intentId: undefined,
    };
    let threw = false;
    try {
      await orderManager.reconcileIntents([intent]);
    } catch (e) {
      threw = true;
      check(String(e).includes("Live adapter not allowed"), "throws when adapter is live");
    }
    check(threw, "reconcileIntents throws with live adapter");
  }

  // ---------- assertNoLiveOrderPlacement throws when mode is live ----------

  // eslint-disable-next-line no-console
  console.log("\nassertNoLiveOrderPlacement throws for live mode");
  {
    let threw = false;
    try {
      assertNoLiveOrderPlacement({ mode: "live", allowedModes: [], source: "test" });
    } catch (e) {
      threw = true;
      check(String(e).includes("Live order placement"), "error message mentions live order placement");
    }
    check(threw, "assertNoLiveOrderPlacement throws when config.mode is live");
  }

  // ---------- Intent → OrderManager (paper mode): integration-style ----------

  // eslint-disable-next-line no-console
  console.log("\norder.intent.created leads to OrderManager in paper mode");
  {
    const bus = new InMemoryRuntimeEventBus();
    const orderStore = new InMemoryOrderLifecycleStore();
    const lifecycleHandler = new DefaultOrderLifecycleHandler({ store: orderStore, eventBus: bus });
    const positionStore = new InMemoryRuntimePositionStore();
    const positionUpdater = new DefaultRuntimePositionUpdater({ store: positionStore, eventBus: bus, eventSource: "order_manager" });
    const riskEngine = new InMemoryRuntimeRiskEngine();
    const guardrails = new DefaultRuntimeGuardrails({ eventBus: bus });
    const marketStore = new InMemoryMarketStateStore();
    const contextProvider = new DefaultBotRuntimeContextProvider(
      { marketStateStore: marketStore, positionStore, getOpenOrdersForAsset: (f, a) => orderStore.listOpenByAsset(f, a) },
      riskEngine.getState()
    );
    const orderManager = new PaperOrderManager({
      store: orderStore,
      reconciler: new DefaultOrderIntentReconciler(),
      adapter: new PaperExchangeAdapter(),
      eventBus: bus,
      lifecycleHandler,
    });
    let reconciled = false;
    const config: RuntimeConfig = { mode: "paper", allowedModes: ROLLOUT_ALLOWED_MODES, source: "test" };
    const unsub = bus.subscribe("order.intent.created", (event) => {
      const payload = event.payload as OrderIntentCreatedPayload;
      if (!isPaperOrLiveStubExecutionAllowed(config)) return;
      updateRiskExposureFromStores(riskEngine, positionStore, orderStore);
      contextProvider.updateRiskState(riskEngine.getState());
      const snapshot = contextProvider.createSnapshot();
      const context = buildBotDecisionContext(snapshot, {
        funderAddress: payload.funderAddress,
        strategyId: payload.strategyId,
        assetId: payload.assetId,
        asOf: new Date(),
        getOpenOrdersForAsset: (f, a) => orderStore.listOpenByAsset(f, a),
      });
      const proposedAction = { action: "UPDATE_QUOTES" as const, assetId: payload.assetId, marketId: payload.marketId, side: payload.side, size: payload.size, limitPrice: payload.limitPrice, intentId: payload.intentId };
      const result = guardrails.evaluate(context, riskEngine.getState(), proposedAction);
      if (result.verdict !== "allowed") return;
      const intent: OrderIntent = { funderAddress: payload.funderAddress, strategyId: payload.strategyId, assetId: payload.assetId, marketId: payload.marketId, side: payload.side, size: payload.size, limitPrice: payload.limitPrice, intentId: payload.intentId };
      void orderManager.reconcileIntents([intent]).then(() => { reconciled = true; });
    });
    bus.publish({
      id: "evt-1",
      type: "order.intent.created",
      source: "bot_runtime",
      occurredAt: new Date(),
      payload: {
        funderAddress: "f1",
        strategyId: "s1",
        assetId: "asset-int",
        marketId: "m-int",
        side: "BUY",
        size: 5,
        limitPrice: 0.5,
        intentId: "i1",
      } as OrderIntentCreatedPayload,
    });
    await sleep(100);
    unsub();
    check(reconciled, "intent event led to reconcileIntents (paper mode)");
    const allOrders = orderStore.getAll();
    check(allOrders.length >= 1, "order store has at least one order after intent");
  }

  // eslint-disable-next-line no-console
  console.log(`\nRuntime core tests finished. Passed=${passed}, Failed=${failed}`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Runtime core tests threw", err);
  process.exitCode = 1;
});

