/**
 * Fill and position update idempotency tests.
 * Positions driven exclusively by lifecycle events; appliedPositionFilledSize on order record.
 *
 * Run with (from repo root):
 *   npx ts-node --project tsconfig.tests.json -r tsconfig-paths/register lib/runtime/__tests__/fill-position-idempotency-tests.ts
 */

import assert from "assert";
import { InMemoryRuntimeEventBus } from "../events/runtime-event-bus";
import { InMemoryOrderLifecycleStore } from "../order-manager/order-lifecycle-store";
import { DefaultOrderLifecycleHandler } from "../order-manager/order-lifecycle-handler";
import { InMemoryRuntimePositionStore } from "../positions/runtime-position-store";
import { DefaultRuntimePositionUpdater, normalizedFillFromOrderFilled, normalizedFillFromOrderPartialFill } from "../positions/runtime-position-updater";
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

  console.log("\n--- Duplicate order.partial_fill: position updated once ---");
  {
    const bus = new InMemoryRuntimeEventBus();
    const orderStore = new InMemoryOrderLifecycleStore();
    const positionStore = new InMemoryRuntimePositionStore();
    const updater = new DefaultRuntimePositionUpdater({ store: positionStore, eventBus: bus, eventSource: "order_manager" });

    orderStore.create({
      clientOrderId: "ord-p",
      funderAddress: "f1",
      assetId: "a1",
      marketId: "m1",
      side: "BUY",
      price: 0.5,
      size: 10,
    });
    orderStore.applyAck("ord-p", "ex-p");

    let positionUpdates = 0;
    bus.subscribe("position.changed", () => { positionUpdates++; });

    const applyPartial = (filledSize: number): void => {
      const order = orderStore.get("ord-p");
      if (!order) return;
      const applied = order.appliedPositionFilledSize ?? 0;
      const delta = filledSize - applied;
      if (delta <= 0) return;
      const fill = normalizedFillFromOrderPartialFill(
        { funderAddress: "f1", assetId: "a1", filledSize, fillPrice: 0.5, filledAt: new Date() },
        order,
        delta
      );
      updater.applyFill(fill);
      orderStore.setAppliedPositionFilledSize("ord-p", filledSize);
    };

    orderStore.applyPartialFill("ord-p", 3, 0.5);
    applyPartial(3);
    check(positionStore.getPosition("f1", "a1")?.netShares === 3, "position 3 after first partial");

    applyPartial(3);
    check(positionStore.getPosition("f1", "a1")?.netShares === 3, "duplicate partial_fill (cumulative 3) does not add again");
    check(positionUpdates === 1, "position.changed emitted once");
  }

  console.log("\n--- Duplicate order.filled: position updated once ---");
  {
    const bus = new InMemoryRuntimeEventBus();
    const orderStore = new InMemoryOrderLifecycleStore();
    const positionStore = new InMemoryRuntimePositionStore();
    const updater = new DefaultRuntimePositionUpdater({ store: positionStore, eventBus: bus, eventSource: "order_manager" });

    orderStore.create({
      clientOrderId: "ord-f",
      funderAddress: "f1",
      assetId: "a2",
      marketId: "m2",
      side: "BUY",
      price: 0.55,
      size: 5,
    });
    orderStore.applyAck("ord-f", "ex-f");
    orderStore.applyFill("ord-f", 5, 0.55);

    let positionUpdates = 0;
    bus.subscribe("position.changed", () => { positionUpdates++; });

    const applyFilled = (): void => {
      const order = orderStore.get("ord-f");
      if (!order) return;
      const applied = order.appliedPositionFilledSize ?? 0;
      const totalFilledSize = 5;
      const delta = totalFilledSize - applied;
      if (delta > 0) {
        const fill = normalizedFillFromOrderFilled({
          funderAddress: "f1",
          assetId: "a2",
          marketId: "m2",
          side: "BUY",
          totalFilledSize: delta,
          avgPrice: 0.55,
          filledAt: new Date(),
        });
        updater.applyFill(fill);
        orderStore.setAppliedPositionFilledSize("ord-f", totalFilledSize);
      }
    };

    applyFilled();
    check(positionStore.getPosition("f1", "a2")?.netShares === 5, "position 5 after first order.filled");

    applyFilled();
    check(positionStore.getPosition("f1", "a2")?.netShares === 5, "duplicate order.filled does not add again");
    check(positionUpdates === 1, "position.changed emitted once");
  }

  console.log("\n--- order.filled before order.partial_fill (out-of-order) ---");
  {
    const bus = new InMemoryRuntimeEventBus();
    const orderStore = new InMemoryOrderLifecycleStore();
    const positionStore = new InMemoryRuntimePositionStore();
    const updater = new DefaultRuntimePositionUpdater({ store: positionStore, eventBus: bus, eventSource: "order_manager" });

    orderStore.create({
      clientOrderId: "ord-oo",
      funderAddress: "f1",
      assetId: "a3",
      marketId: "m3",
      side: "BUY",
      price: 0.5,
      size: 10,
    });
    orderStore.applyAck("ord-oo", "ex-oo");
    orderStore.applyPartialFill("ord-oo", 4, 0.5);
    orderStore.applyPartialFill("ord-oo", 6, 0.52);

    const order = orderStore.get("ord-oo")!;
    ok(order.status === "filled" && order.filledSize === 10, "order fully filled");

    let applied = order.appliedPositionFilledSize ?? 0;
    const totalFilledSize = 10;
    let delta = totalFilledSize - applied;
    if (delta > 0) {
      const fill = normalizedFillFromOrderFilled({
        funderAddress: "f1",
        assetId: "a3",
        marketId: "m3",
        side: "BUY",
        totalFilledSize: delta,
        avgPrice: 0.51,
        filledAt: new Date(),
      });
      updater.applyFill(fill);
      orderStore.setAppliedPositionFilledSize("ord-oo", totalFilledSize);
    }

    applied = orderStore.get("ord-oo")!.appliedPositionFilledSize ?? 0;
    delta = 4 - applied;
    ok(delta <= 0, "partial_fill(4) after filled(10): delta <= 0, no double apply");

    const pos = positionStore.getPosition("f1", "a3");
    check(pos?.netShares === 10, "position 10 from full fill only (no over-apply from later partial)");
  }

  console.log("\n--- User-feed TRADE: lifecycle only, no direct position apply ---");
  {
    const orderStore = new InMemoryOrderLifecycleStore();
    const lifecycleHandler = new DefaultOrderLifecycleHandler({ store: orderStore, eventBus: new InMemoryRuntimeEventBus() });
    const positionStore = new InMemoryRuntimePositionStore();

    orderStore.create({
      clientOrderId: "ord-u",
      funderAddress: "f1",
      assetId: "a4",
      marketId: "m4",
      side: "BUY",
      price: 0.5,
      size: 5,
    });
    orderStore.applyAck("ord-u", "ex-u");

    const telemetry = { lifecycleApplied: 0, unmatchedOrderEvents: 0, lifecycleMismatch: 0, fillLedgerDuplicatesSkipped: 0 };
    await feedUserFeedResultToRuntime(
      {
        funderAddress: "f1",
        lifecycle: { kind: "fill", exchangeOrderId: "ex-u", at: new Date(), totalFilledSize: 5, avgPrice: 0.5 },
        positionFill: { funderAddress: "f1", assetId: "a4", marketId: "m4", outcome: "", side: "BUY", size: 5, price: 0.5, filledAt: new Date() },
        exchangeFillId: null,
      },
      { orderStore, lifecycleHandler, fillLedgerEnabled: false, telemetry }
    );

    check(telemetry.lifecycleApplied === 1, "lifecycle applied once");
    check(orderStore.get("ord-u")?.status === "filled", "order marked filled via lifecycle");
    check(positionStore.getPosition("f1", "a4") == null, "position not updated by user-feed (no direct applyFill)");
  }

  console.log("\n--- Fill replay after reconnect (appliedPositionFilledSize persists on order) ---");
  {
    const orderStore = new InMemoryOrderLifecycleStore();
    const positionStore = new InMemoryRuntimePositionStore();
    const bus = new InMemoryRuntimeEventBus();
    const updater = new DefaultRuntimePositionUpdater({ store: positionStore, eventBus: bus, eventSource: "order_manager" });

    orderStore.create({
      clientOrderId: "ord-r",
      funderAddress: "f1",
      assetId: "a5",
      marketId: "m5",
      side: "BUY",
      price: 0.5,
      size: 10,
    });
    orderStore.applyAck("ord-r", "ex-r");
    orderStore.applyPartialFill("ord-r", 4, 0.5);

    const applyPartial = (filledSize: number): void => {
      const order = orderStore.get("ord-r");
      if (!order) return;
      const applied = order.appliedPositionFilledSize ?? 0;
      const delta = filledSize - applied;
      if (delta <= 0) return;
      const fill = normalizedFillFromOrderPartialFill(
        { funderAddress: "f1", assetId: "a5", filledSize, fillPrice: 0.5, filledAt: new Date() },
        order,
        delta
      );
      updater.applyFill(fill);
      orderStore.setAppliedPositionFilledSize("ord-r", filledSize);
    };

    applyPartial(4);
    check(positionStore.getPosition("f1", "a5")?.netShares === 4, "position 4 after first apply");

    applyPartial(4);
    check(positionStore.getPosition("f1", "a5")?.netShares === 4, "replay same partial: no double apply (appliedPositionFilledSize on order)");
  }

  console.log("\n--- Store transition guards: no mutate terminal ---");
  {
    const store = new InMemoryOrderLifecycleStore();
    store.create({
      clientOrderId: "c-t",
      funderAddress: "f1",
      assetId: "a",
      marketId: "m",
      side: "BUY",
      price: 0.5,
      size: 10,
    });
    store.applyAck("c-t", "ex-t");
    store.applyFill("c-t", 10, 0.5);
    ok(store.get("c-t")?.status === "filled", "order filled");

    store.applyPartialFill("c-t", 1, 0.5);
    check(store.get("c-t")?.status === "filled" && store.get("c-t")?.filledSize === 10, "applyPartialFill on filled is no-op");

    store.applyAck("c-t", "ex-t2");
    check(store.get("c-t")?.status === "filled", "applyAck on filled is no-op");

    store.create({ clientOrderId: "c-r", funderAddress: "f1", assetId: "a", marketId: "m", side: "SELL", price: 0.5, size: 5 });
    store.applyReject("c-r");
    store.applyAck("c-r", "ex-r");
    check(store.get("c-r")?.status === "rejected", "applyAck on rejected is no-op");
  }

  console.log("\n--- appliedPositionFilledSize on new order ---");
  {
    const store = new InMemoryOrderLifecycleStore();
    const o = store.create({
      clientOrderId: "c-ap",
      funderAddress: "f1",
      assetId: "a",
      marketId: "m",
      side: "BUY",
      price: 0.5,
      size: 10,
    });
    check((o.appliedPositionFilledSize ?? 0) === 0, "new order has appliedPositionFilledSize 0");
  }

  console.log("\n--- Summary ---");
  console.log("Passed:", passed, "Failed:", failed);
  if (failed > 0) process.exit(1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
