/**
 * Lifecycle and exposure hardening tests after fill idempotency refactor.
 * Verifies numeric invariants, partial-then-cancel, full-path correctness, exposure consistency.
 *
 * Run with (from repo root):
 *   npx ts-node --project tsconfig.tests.json -r tsconfig-paths/register lib/runtime/__tests__/lifecycle-exposure-hardening-tests.ts
 */

import assert from "assert";
import { InMemoryRuntimeEventBus } from "../events/runtime-event-bus";
import { InMemoryOrderLifecycleStore } from "../order-manager/order-lifecycle-store";
import { DefaultOrderLifecycleHandler } from "../order-manager/order-lifecycle-handler";
import { InMemoryRuntimePositionStore } from "../positions/runtime-position-store";
import {
  DefaultRuntimePositionUpdater,
  normalizedFillFromOrderFilled,
  normalizedFillFromOrderPartialFill,
} from "../positions/runtime-position-updater";
import { getExposureFromStores } from "../runtime-exposure";
import { feedUserFeedResultToRuntime } from "@/lib/live/user-feed-to-runtime";

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

  console.log("\n--- Lifecycle numeric invariants: filledSize never exceeds size ---");
  {
    const store = new InMemoryOrderLifecycleStore();
    store.create({
      clientOrderId: "c-cap",
      funderAddress: "f1",
      assetId: "a",
      marketId: "m",
      side: "BUY",
      price: 0.5,
      size: 10,
    });
    store.applyAck("c-cap", "ex-cap");
    store.applyPartialFill("c-cap", 4, 0.5);
    store.applyPartialFill("c-cap", 20, 0.5);
    const o = store.get("c-cap");
    assert(o);
    check(o.filledSize === 10, "filledSize capped at order size (no overfill)");
    check(o.remainingSize === 0, "remainingSize 0");
    check(o.status === "filled", "status filled");
  }

  console.log("\n--- appliedPositionFilledSize never exceeds filledSize ---");
  {
    const store = new InMemoryOrderLifecycleStore();
    store.create({
      clientOrderId: "c-apcap",
      funderAddress: "f1",
      assetId: "a",
      marketId: "m",
      side: "BUY",
      price: 0.5,
      size: 10,
    });
    store.applyAck("c-apcap", "ex-apcap");
    store.applyPartialFill("c-apcap", 3, 0.5);
    store.setAppliedPositionFilledSize("c-apcap", 100);
    const o = store.get("c-apcap");
    assert(o);
    check((o.appliedPositionFilledSize ?? 0) === 3, "setAppliedPositionFilledSize capped to filledSize (3)");
  }

  console.log("\n--- Partially-filled then cancel: coherent state ---");
  {
    const store = new InMemoryOrderLifecycleStore();
    const positionStore = new InMemoryRuntimePositionStore();
    const bus = new InMemoryRuntimeEventBus();
    const updater = new DefaultRuntimePositionUpdater({ store: positionStore, eventBus: bus, eventSource: "order_manager" });

    store.create({
      clientOrderId: "c-pc",
      funderAddress: "f1",
      assetId: "a-pc",
      marketId: "m-pc",
      side: "BUY",
      price: 0.5,
      size: 10,
    });
    store.applyAck("c-pc", "ex-pc");
    store.applyPartialFill("c-pc", 3, 0.5);

    const order = store.get("c-pc")!;
    const applied = order.appliedPositionFilledSize ?? 0;
    const delta = 3 - applied;
    if (delta > 0) {
      const fill = normalizedFillFromOrderPartialFill(
        { funderAddress: "f1", assetId: "a-pc", filledSize: 3, fillPrice: 0.5, filledAt: new Date() },
        order,
        delta
      );
      updater.applyFill(fill);
      store.setAppliedPositionFilledSize("c-pc", 3);
    }

    store.applyCancel("c-pc");

    const after = store.get("c-pc");
    assert(after);
    check(after.status === "canceled", "order canceled after partial fill");
    check(after.filledSize === 3, "filledSize 3 (only executed fill)");
    check(positionStore.getPosition("f1", "a-pc")?.netShares === 3, "position reflects only executed fill (3)");

    const exposure = getExposureFromStores(positionStore, store);
    check(exposure.workingOrderCount === 0, "workingOrderCount excludes canceled order");
  }

  console.log("\n--- Duplicate cancel ack: no corruption ---");
  {
    const store = new InMemoryOrderLifecycleStore();
    store.create({
      clientOrderId: "c-dc",
      funderAddress: "f1",
      assetId: "a",
      marketId: "m",
      side: "BUY",
      price: 0.5,
      size: 10,
    });
    store.applyAck("c-dc", "ex-dc");
    store.applyCancel("c-dc");
    store.applyCancel("c-dc");
    const o = store.get("c-dc");
    assert(o);
    check(o.status === "canceled", "still canceled after duplicate cancel");
  }

  console.log("\n--- Full-path: user-feed TRADE -> lifecycle -> order.filled subscriber -> position once ---");
  {
    const bus = new InMemoryRuntimeEventBus();
    const orderStore = new InMemoryOrderLifecycleStore();
    const lifecycleHandler = new DefaultOrderLifecycleHandler({ store: orderStore, eventBus: bus });
    const positionStore = new InMemoryRuntimePositionStore();
    const updater = new DefaultRuntimePositionUpdater({ store: positionStore, eventBus: bus, eventSource: "order_manager" });

    orderStore.create({
      clientOrderId: "ord-full",
      funderAddress: "f1",
      assetId: "a-full",
      marketId: "m-full",
      side: "BUY",
      price: 0.55,
      size: 5,
    });
    orderStore.applyAck("ord-full", "ex-full");

    let positionApplyCount = 0;
    bus.subscribe("order.filled", (event) => {
      const payload = (event.payload as {
        funderAddress: string;
        runtimeOrderId: string;
        assetId: string;
        marketId: string;
        side: "BUY" | "SELL";
        totalFilledSize: number;
        avgPrice: number;
        filledAt: Date;
      });
      const order = orderStore.get(payload.runtimeOrderId);
      if (!order) return;
      const applied = order.appliedPositionFilledSize ?? 0;
      const delta = payload.totalFilledSize - applied;
      if (delta > 0) {
        const fill = normalizedFillFromOrderFilled({
          ...payload,
          totalFilledSize: delta,
          avgPrice: payload.avgPrice,
        });
        updater.applyFill(fill);
        orderStore.setAppliedPositionFilledSize(payload.runtimeOrderId, payload.totalFilledSize);
        positionApplyCount++;
      }
    });

    await feedUserFeedResultToRuntime(
      {
        funderAddress: "f1",
        lifecycle: { kind: "fill", exchangeOrderId: "ex-full", at: new Date(), totalFilledSize: 5, avgPrice: 0.55 },
        positionFill: { funderAddress: "f1", assetId: "a-full", marketId: "m-full", outcome: "", side: "BUY", size: 5, price: 0.55, filledAt: new Date() },
        exchangeFillId: null,
      },
      { orderStore, lifecycleHandler, fillLedgerEnabled: false }
    );

    check(orderStore.get("ord-full")?.status === "filled", "order filled via lifecycle (user-feed TRADE path)");
    check(positionApplyCount === 1, "position updated exactly once from order.filled subscriber");
    check(positionStore.getPosition("f1", "a-full")?.netShares === 5, "position 5");
  }

  console.log("\n--- Partial then full fill: position and exposure correct ---");
  {
    const bus = new InMemoryRuntimeEventBus();
    const orderStore = new InMemoryOrderLifecycleStore();
    const lifecycleHandler = new DefaultOrderLifecycleHandler({ store: orderStore, eventBus: bus });
    const positionStore = new InMemoryRuntimePositionStore();
    const updater = new DefaultRuntimePositionUpdater({ store: positionStore, eventBus: bus, eventSource: "order_manager" });

    orderStore.create({
      clientOrderId: "ord-pf",
      funderAddress: "f1",
      assetId: "a-pf",
      marketId: "m-pf",
      side: "BUY",
      price: 0.5,
      size: 10,
    });
    orderStore.applyAck("ord-pf", "ex-pf");

    const unsubPartial = bus.subscribe("order.partial_fill", (ev) => {
      const p = ev.payload as { runtimeOrderId: string; filledSize: number; fillPrice: number; funderAddress: string; assetId: string; filledAt: Date };
      const order = orderStore.get(p.runtimeOrderId)!;
      const applied = order.appliedPositionFilledSize ?? 0;
      const delta = p.filledSize - applied;
      if (delta > 0) {
        updater.applyFill(normalizedFillFromOrderPartialFill(p, order, delta));
        orderStore.setAppliedPositionFilledSize(p.runtimeOrderId, p.filledSize);
      }
    });
    const unsubFilled = bus.subscribe("order.filled", (ev) => {
      const p = ev.payload as { runtimeOrderId: string; totalFilledSize: number; avgPrice: number; funderAddress: string; assetId: string; marketId: string; side: "BUY" | "SELL"; filledAt: Date };
      const order = orderStore.get(p.runtimeOrderId)!;
      const applied = order.appliedPositionFilledSize ?? 0;
      const delta = p.totalFilledSize - applied;
      if (delta > 0) {
        updater.applyFill(normalizedFillFromOrderFilled({ ...p, totalFilledSize: delta }));
        orderStore.setAppliedPositionFilledSize(p.runtimeOrderId, p.totalFilledSize);
      }
    });

    lifecycleHandler.applyPartialFill({
      clientOrderId: "ord-pf",
      fillSize: 4,
      fillPrice: 0.5,
      filledAt: new Date(),
    });
    lifecycleHandler.applyFullFill({
      clientOrderId: "ord-pf",
      totalFilledSize: 10,
      avgPrice: 0.5,
      filledAt: new Date(),
    });

    unsubPartial();
    unsubFilled();

    const pos = positionStore.getPosition("f1", "a-pf");
    check(pos?.netShares === 10, "position 10 after partial then full");
    const exposure = getExposureFromStores(positionStore, orderStore);
    check(exposure.workingOrderCount === 0, "workingOrderCount 0 (order filled)");
    check(exposure.grossExposure === pos!.netShares * (pos!.avgEntryPrice ?? 0), "grossExposure from position");
  }

  console.log("\n--- Exposure consistency: workingOrderCount after fill/cancel ---");
  {
    const orderStore = new InMemoryOrderLifecycleStore();
    const positionStore = new InMemoryRuntimePositionStore();

    orderStore.create({
      clientOrderId: "o1",
      funderAddress: "f1",
      assetId: "a1",
      marketId: "m1",
      side: "BUY",
      price: 0.5,
      size: 10,
    });
    orderStore.applyAck("o1", "ex1");
    let exp = getExposureFromStores(positionStore, orderStore);
    check(exp.workingOrderCount === 1, "workingOrderCount 1 when one working order");

    orderStore.applyCancel("o1");
    exp = getExposureFromStores(positionStore, orderStore);
    check(exp.workingOrderCount === 0, "workingOrderCount 0 after cancel");

    orderStore.create({
      clientOrderId: "o2",
      funderAddress: "f1",
      assetId: "a2",
      marketId: "m2",
      side: "BUY",
      price: 0.6,
      size: 5,
    });
    orderStore.applyAck("o2", "ex2");
    orderStore.applyFill("o2", 5, 0.6);
    exp = getExposureFromStores(positionStore, orderStore);
    check(exp.workingOrderCount === 0, "workingOrderCount 0 after fill (order terminal)");
  }

  console.log("\n--- remainingSize never negative ---");
  {
    const store = new InMemoryOrderLifecycleStore();
    store.create({
      clientOrderId: "c-rem",
      funderAddress: "f1",
      assetId: "a",
      marketId: "m",
      side: "BUY",
      price: 0.5,
      size: 10,
    });
    store.applyAck("c-rem", "ex-rem");
    store.applyPartialFill("c-rem", 10, 0.5);
    store.applyPartialFill("c-rem", 5, 0.5);
    const o = store.get("c-rem");
    assert(o);
    check(o.remainingSize >= 0, "remainingSize >= 0 after over-size partial");
    check(o.filledSize === 10, "filledSize still capped at 10");
  }

  console.log("\n--- Summary ---");
  console.log("Passed:", passed, "Failed:", failed);
  if (failed > 0) process.exit(1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
