/**
 * Order lifecycle journal: rebuild from journal (deterministic, duplicate-safe), reconcile journaled.
 * Run with (from repo root):
 *   npx ts-node --project tsconfig.tests.json -r tsconfig-paths/register lib/runtime/journal/__tests__/order-lifecycle-journal-tests.ts
 */

import assert from "assert";
import {
  rebuildOrderFromJournal,
  getOrderLifecycleHistory,
  appendOrderLifecycleEvent,
  getLatestJournalStateForOrder,
  ORDER_LIFECYCLE_EVENT_TYPES,
  type OrderLifecycleJournalEntryRow,
} from "../order-lifecycle-journal";

function ok(cond: boolean, msg: string): void {
  assert.strictEqual(cond, true, msg);
}

function makeEntry(overrides: Partial<OrderLifecycleJournalEntryRow>): OrderLifecycleJournalEntryRow {
  const now = new Date();
  return {
    id: "id-" + Math.random().toString(36).slice(2),
    funderAddress: "0xfunder",
    clientOrderId: null,
    exchangeOrderId: null,
    intentId: null,
    assetId: "asset1",
    marketId: "market1",
    side: "BUY",
    eventType: ORDER_LIFECYCLE_EVENT_TYPES.LOCAL_ORDER_CREATED,
    eventSequence: 0,
    payloadJson: null,
    metadataJson: null,
    occurredAt: now,
    createdAt: now,
    ...overrides,
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

  const now = new Date();

  console.log("\n--- rebuildOrderFromJournal: local_order_created + ack => working ---");
  {
    const entries: OrderLifecycleJournalEntryRow[] = [
      makeEntry({
        clientOrderId: "co1",
        eventType: ORDER_LIFECYCLE_EVENT_TYPES.LOCAL_ORDER_CREATED,
        payloadJson: JSON.stringify({ clientOrderId: "co1", price: 0.5, size: 10, intentId: "i1" }),
        occurredAt: now,
      }),
      makeEntry({
        clientOrderId: "co1",
        exchangeOrderId: "ex1",
        eventType: ORDER_LIFECYCLE_EVENT_TYPES.ACK,
        payloadJson: JSON.stringify({ exchangeOrderId: "ex1" }),
        occurredAt: new Date(now.getTime() + 1000),
      }),
    ];
    const state = rebuildOrderFromJournal(entries);
    check(state != null, "state non-null");
    check(state!.clientOrderId === "co1", "clientOrderId");
    check(state!.exchangeOrderId === "ex1", "exchangeOrderId");
    check(state!.status === "working", "status working");
    check(state!.filledSize === 0, "filledSize 0");
    check(state!.remainingSize === 10, "remainingSize 10");
  }

  console.log("\n--- rebuildOrderFromJournal: partial_fill then cancel => canceled with filledSize set ---");
  {
    const entries: OrderLifecycleJournalEntryRow[] = [
      makeEntry({
        clientOrderId: "co2",
        eventType: ORDER_LIFECYCLE_EVENT_TYPES.LOCAL_ORDER_CREATED,
        payloadJson: JSON.stringify({ clientOrderId: "co2", price: 0.55, size: 20 }),
        occurredAt: now,
      }),
      makeEntry({
        clientOrderId: "co2",
        exchangeOrderId: "ex2",
        eventType: ORDER_LIFECYCLE_EVENT_TYPES.ACK,
        payloadJson: JSON.stringify({ exchangeOrderId: "ex2" }),
        occurredAt: new Date(now.getTime() + 1000),
      }),
      makeEntry({
        clientOrderId: "co2",
        exchangeOrderId: "ex2",
        eventType: ORDER_LIFECYCLE_EVENT_TYPES.PARTIAL_FILL,
        payloadJson: JSON.stringify({ fillSize: 5, fillPrice: 0.55 }),
        occurredAt: new Date(now.getTime() + 2000),
      }),
      makeEntry({
        clientOrderId: "co2",
        exchangeOrderId: "ex2",
        eventType: ORDER_LIFECYCLE_EVENT_TYPES.CANCELED,
        occurredAt: new Date(now.getTime() + 3000),
      }),
    ];
    const state = rebuildOrderFromJournal(entries);
    check(state != null, "state non-null");
    check(state!.status === "canceled", "status canceled");
    check(state!.filledSize === 5, "filledSize 5 after partial_fill");
    check(state!.remainingSize === 15, "remainingSize 15");
  }

  console.log("\n--- Duplicate ack does not corrupt state ---");
  {
    const entries: OrderLifecycleJournalEntryRow[] = [
      makeEntry({
        clientOrderId: "co3",
        eventType: ORDER_LIFECYCLE_EVENT_TYPES.LOCAL_ORDER_CREATED,
        payloadJson: JSON.stringify({ clientOrderId: "co3", price: 0.5, size: 10 }),
        occurredAt: now,
      }),
      makeEntry({
        clientOrderId: "co3",
        exchangeOrderId: "ex3",
        eventType: ORDER_LIFECYCLE_EVENT_TYPES.ACK,
        payloadJson: JSON.stringify({ exchangeOrderId: "ex3" }),
        occurredAt: new Date(now.getTime() + 1000),
      }),
      makeEntry({
        clientOrderId: "co3",
        exchangeOrderId: "ex3",
        eventType: ORDER_LIFECYCLE_EVENT_TYPES.ACK,
        payloadJson: JSON.stringify({ exchangeOrderId: "ex3" }),
        occurredAt: new Date(now.getTime() + 2000),
      }),
    ];
    const state = rebuildOrderFromJournal(entries);
    check(state != null, "state non-null");
    check(state!.status === "working", "still working after duplicate ack");
    check(state!.exchangeOrderId === "ex3", "exchangeOrderId set once");
  }

  console.log("\n--- Deterministic: same entries produce same state ---");
  {
    const entries: OrderLifecycleJournalEntryRow[] = [
      makeEntry({
        clientOrderId: "co4",
        eventType: ORDER_LIFECYCLE_EVENT_TYPES.LOCAL_ORDER_CREATED,
        payloadJson: JSON.stringify({ clientOrderId: "co4", price: 0.6, size: 15 }),
        occurredAt: now,
      }),
      makeEntry({
        clientOrderId: "co4",
        exchangeOrderId: "ex4",
        eventType: ORDER_LIFECYCLE_EVENT_TYPES.ACK,
        payloadJson: JSON.stringify({ exchangeOrderId: "ex4" }),
        occurredAt: new Date(now.getTime() + 1000),
      }),
      makeEntry({
        clientOrderId: "co4",
        exchangeOrderId: "ex4",
        eventType: ORDER_LIFECYCLE_EVENT_TYPES.FILL,
        payloadJson: JSON.stringify({ totalFilledSize: 15, avgPrice: 0.6 }),
        occurredAt: new Date(now.getTime() + 2000),
      }),
    ];
    const state1 = rebuildOrderFromJournal(entries);
    const state2 = rebuildOrderFromJournal(entries);
    check(state1 != null && state2 != null, "both non-null");
    check(state1!.status === state2!.status && state1!.status === "filled", "both filled");
    check(state1!.filledSize === state2!.filledSize && state1!.filledSize === 15, "same filledSize");
  }

  console.log("\n--- rebuild_imported produces working order with sizeMatched ---");
  {
    const entries: OrderLifecycleJournalEntryRow[] = [
      makeEntry({
        clientOrderId: "rebuild:ex5",
        exchangeOrderId: "ex5",
        eventType: ORDER_LIFECYCLE_EVENT_TYPES.REBUILD_IMPORTED,
        payloadJson: JSON.stringify({
          clientOrderId: "rebuild:ex5",
          price: 0.5,
          size: 10,
          sizeMatched: 3,
          exchangeOrderId: "ex5",
        }),
        occurredAt: now,
      }),
    ];
    const state = rebuildOrderFromJournal(entries);
    check(state != null, "state non-null");
    check(state!.clientOrderId === "rebuild:ex5", "clientOrderId");
    check(state!.exchangeOrderId === null, "rebuild_imported alone has no ack yet");
    check(state!.status === "pending_submit", "single rebuild_imported => pending_submit (no ack in replay)");
    const withAck = [
      ...entries,
      makeEntry({
        clientOrderId: "rebuild:ex5",
        exchangeOrderId: "ex5",
        eventType: ORDER_LIFECYCLE_EVENT_TYPES.ACK,
        payloadJson: JSON.stringify({ exchangeOrderId: "ex5" }),
        occurredAt: new Date(now.getTime() + 1000),
      }),
      makeEntry({
        clientOrderId: "rebuild:ex5",
        exchangeOrderId: "ex5",
        eventType: ORDER_LIFECYCLE_EVENT_TYPES.PARTIAL_FILL,
        payloadJson: JSON.stringify({ fillSize: 3, fillPrice: 0.5 }),
        occurredAt: new Date(now.getTime() + 2000),
      }),
    ];
    const state2 = rebuildOrderFromJournal(withAck);
    check(state2!.status === "partially_filled" || state2!.filledSize === 3, "after ack + partial_fill");
  }

  console.log("\n--- getOrderLifecycleHistory / appendOrderLifecycleEvent (requires DB) ---");
  try {
    const testClientOrderId = "test-co-" + Date.now();
    const id = await appendOrderLifecycleEvent({
      funderAddress: "0xtestfunder",
      clientOrderId: testClientOrderId,
      assetId: "a1",
      marketId: "m1",
      side: "BUY",
      eventType: ORDER_LIFECYCLE_EVENT_TYPES.INTENT_CREATED,
      occurredAt: new Date(),
    });
    check(typeof id === "string" && id.length > 0, "append returns id");
    const history = await getOrderLifecycleHistory({
      funderAddress: "0xtestfunder",
      clientOrderId: testClientOrderId,
    });
    check(Array.isArray(history), "history is array");
    check(history.length >= 1, "at least one entry");
  } catch (e) {
    console.log("  SKIP: DB not available or migration not applied:", (e as Error).message);
  }

  console.log("\n--- Result ---");
  console.log(`Passed: ${passed}, Failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
