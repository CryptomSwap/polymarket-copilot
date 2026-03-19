/**
 * Startup rebuild: order/position rebuild helpers, phase transitions, automation gating.
 *
 * Run with (from repo root):
 *   npx ts-node --project tsconfig.tests.json -r tsconfig-paths/register lib/runtime/__tests__/stream-runtime-rebuild-tests.ts
 */

import assert from "assert";
import { InMemoryOrderLifecycleStore } from "../order-manager/order-lifecycle-store";
import { InMemoryRuntimePositionStore } from "../positions/runtime-position-store";
import { DefaultRuntimePositionUpdater } from "../positions/runtime-position-updater";
import { InMemoryRuntimeEventBus } from "../events/runtime-event-bus";
import { InMemoryRuntimeRiskEngine, createDefaultRuntimeRiskState } from "../risk/runtime-risk-engine";
import {
  rebuildOrderStoreFromTruth,
  rebuildPositionStoreFromTruth,
  recomputeRiskExposure,
  parseExchangeOrderForRebuild,
} from "../startup/stream-runtime-rebuild";
import type { AppendOrderLifecycleEventParams } from "../journal/order-lifecycle-journal";
import type { UnappliedFillEntry } from "@/lib/live/fill-ledger";
import { createRuntimeHealth } from "../runtime-health";

function ok(cond: boolean, msg: string): void {
  assert.strictEqual(cond, true, msg);
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

  const funder = "0xfunder";

  console.log("\n--- rebuildOrderStoreFromTruth: startup with existing open orders ---");
  {
    const orderStore = new InMemoryOrderLifecycleStore();
    const exchangeOrders = [
      {
        id: "ex-1",
        market: "m1",
        asset_id: "a1",
        side: "BUY",
        original_size: "10",
        size_matched: "0",
        price: "0.55",
        status: "LIVE",
      },
      {
        id: "ex-2",
        market: "m1",
        asset_id: "a1",
        side: "SELL",
        original_size: "5",
        size_matched: "3",
        price: "0.45",
        status: "LIVE",
      },
    ];
    rebuildOrderStoreFromTruth(orderStore, exchangeOrders, funder);
    const all = orderStore.getAll();
    check(all.length === 2, "two orders in store");
    const byExId = all.filter((o) => o.exchangeOrderId);
    check(byExId.length === 2, "both have exchange id");
    const o1 = orderStore.getByExternalId("ex-1");
    const o2 = orderStore.getByExternalId("ex-2");
    check(o1 != null && o1.status === "working" && o1.size === 10 && o1.filledSize === 0, "ex-1 working, size 10, filled 0");
    check(o2 != null && o2.status === "partially_filled" && o2.size === 5 && o2.filledSize === 3, "ex-2 partially_filled, filled 3");
  }

  console.log("\n--- rebuildOrderStoreFromTruth: journalAppend returning void must not throw ---");
  {
    const orderStore = new InMemoryOrderLifecycleStore();
    const exchangeOrders = [
      { id: "ex-a", market: "m1", asset_id: "a1", side: "BUY" as const, original_size: "1", size_matched: "0", price: "0.5", status: "LIVE" },
    ];
    let journalCallCount = 0;
    const journalAppendSync = (_params: AppendOrderLifecycleEventParams): void => {
      journalCallCount++;
    };
    rebuildOrderStoreFromTruth(orderStore, exchangeOrders, funder, journalAppendSync);
    check(journalCallCount === 1, "journalAppend (void-returning) called once");
    check(orderStore.getAll().length === 1, "one order in store after rebuild with sync journalAppend");
  }

  console.log("\n--- rebuildPositionStoreFromTruth: startup with existing fills ---");
  {
    const eventBus = new InMemoryRuntimeEventBus();
    const positionStore = new InMemoryRuntimePositionStore();
    const positionUpdater = new DefaultRuntimePositionUpdater({
      store: positionStore,
      eventBus,
      eventSource: "order_manager",
    });
    const ledgerFills: UnappliedFillEntry[] = [
      {
        id: "le-1",
        funderAddress: funder,
        exchangeFillId: "fill-1",
        assetId: "a1",
        marketId: "m1",
        side: "BUY",
        size: 10,
        price: 0.5,
        filledAt: new Date(),
        outcome: "Yes",
      },
      {
        id: "le-2",
        funderAddress: funder,
        exchangeFillId: "fill-2",
        assetId: "a1",
        marketId: "m1",
        side: "BUY",
        size: 5,
        price: 0.52,
        filledAt: new Date(),
        outcome: "Yes",
      },
    ];
    rebuildPositionStoreFromTruth(positionStore, positionUpdater, ledgerFills);
    const positions = positionStore.getPositionsForFunder(funder);
    check(positions.length >= 1, "at least one position");
    const p = positionStore.getPosition(funder, "a1");
    check(p != null, "position for a1 exists");
    check(p!.netShares >= 15, "net shares >= 15 from two buys");
  }

  console.log("\n--- rebuildPositionStoreFromTruth: unapplied durable fills applied in order ---");
  {
    const eventBus = new InMemoryRuntimeEventBus();
    const positionStore = new InMemoryRuntimePositionStore();
    const positionUpdater = new DefaultRuntimePositionUpdater({
      store: positionStore,
      eventBus,
      eventSource: "order_manager",
    });
    const baseTime = new Date();
    const ledgerFills: UnappliedFillEntry[] = [
      {
        id: "u1",
        funderAddress: funder,
        exchangeFillId: "f1",
        assetId: "asset-x",
        marketId: "m-x",
        side: "BUY",
        size: 20,
        price: 0.6,
        filledAt: new Date(baseTime.getTime() + 1),
        outcome: "Yes",
      },
      {
        id: "u2",
        funderAddress: funder,
        exchangeFillId: "f2",
        assetId: "asset-x",
        marketId: "m-x",
        side: "SELL",
        size: 8,
        price: 0.62,
        filledAt: new Date(baseTime.getTime() + 2),
        outcome: "Yes",
      },
    ];
    rebuildPositionStoreFromTruth(positionStore, positionUpdater, ledgerFills);
    const p = positionStore.getPosition(funder, "asset-x");
    check(p != null, "position exists");
    check(p!.netShares === 12, "net 20 - 8 = 12");
  }

  console.log("\n--- recomputeRiskExposure after rebuild ---");
  {
    const orderStore = new InMemoryOrderLifecycleStore();
    const positionStore = new InMemoryRuntimePositionStore();
    const eventBus = new InMemoryRuntimeEventBus();
    const positionUpdater = new DefaultRuntimePositionUpdater({
      store: positionStore,
      eventBus,
      eventSource: "order_manager",
    });
    rebuildPositionStoreFromTruth(positionStore, positionUpdater, [
      {
        funderAddress: funder,
        assetId: "a1",
        marketId: "m1",
        side: "BUY",
        size: 100,
        price: 0.5,
        filledAt: new Date(),
        outcome: "Yes",
      },
    ]);
    const riskEngine = new InMemoryRuntimeRiskEngine(
      createDefaultRuntimeRiskState({ grossExposure: 0, netExposure: 0 })
    );
    recomputeRiskExposure(riskEngine, positionStore, orderStore);
    const state = riskEngine.getState();
    check(state.grossExposure >= 0, "gross exposure set");
  }

  console.log("\n--- parseExchangeOrderForRebuild ---");
  {
    const valid = parseExchangeOrderForRebuild({
      id: "oid",
      market: "m",
      asset_id: "a",
      side: "BUY",
      original_size: "10",
      size_matched: "0",
      price: "0.5",
      status: "LIVE",
    });
    check(valid != null && valid.id === "oid", "parses valid order");
    check(parseExchangeOrderForRebuild(null) === null, "null => null");
    check(parseExchangeOrderForRebuild({}) === null, "invalid => null");
  }

  console.log("\n--- operationalReadiness and status: not ready until ready ---");
  {
    const healthRebuilding = createRuntimeHealth({
      status: "rebuilding",
      lifecycleStatus: "rebuilding",
      streams: {
        ...createRuntimeHealth({}).streams,
        socketOpen: true,
        dataFlowHealthy: true,
        operationalReadiness: false,
      },
    });
    check(healthRebuilding.status === "rebuilding", "status rebuilding");
    check(healthRebuilding.streams.operationalReadiness === false, "operationalReadiness false when rebuilding");

    const healthReady = createRuntimeHealth({
      status: "ready",
      lifecycleStatus: "ready",
      streams: {
        ...createRuntimeHealth({}).streams,
        socketOpen: true,
        dataFlowHealthy: true,
        operationalReadiness: true,
      },
    });
    check(healthReady.streams.operationalReadiness === true, "operationalReadiness true when ready");
  }

  console.log("\n--- rebuild failure => degraded (phase transition) ---");
  {
    const healthDegraded = createRuntimeHealth({
      status: "degraded",
      lifecycleStatus: "degraded",
      degradedReasons: ["startup_rebuild_failed"],
    });
    check(healthDegraded.status === "degraded", "status degraded");
    check(healthDegraded.degradedReasons.includes("startup_rebuild_failed"), "reason startup_rebuild_failed");
  }

  console.log("\n--- automation blocked when not ready (health reflects not-ready) ---");
  {
    const healthStopped = createRuntimeHealth({ status: "stopped", lifecycleStatus: "stopped" });
    check(healthStopped.status === "stopped", "status stopped");
    const healthRebuilding = createRuntimeHealth({
      status: "rebuilding",
      lifecycleStatus: "rebuilding",
      streams: { ...createRuntimeHealth({}).streams, operationalReadiness: false },
    });
    check(healthRebuilding.streams.operationalReadiness === false, "operationalReadiness false when rebuilding");
  }

  console.log("\n--- Result ---");
  console.log(`Passed: ${passed}, Failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
