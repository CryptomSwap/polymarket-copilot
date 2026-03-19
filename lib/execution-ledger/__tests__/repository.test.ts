/**
 * Execution ledger repository tests: idempotency, dedupe, single-apply, timeline, cancel/replace.
 * Requires DATABASE_URL and applied migrations (OrderIntent, ExecutedOrder, FillLedgerEntry, etc.).
 *
 * Run with (from repo root):
 *   npx ts-node --project tsconfig.tests.json -r tsconfig-paths/register lib/execution-ledger/__tests__/repository.test.ts
 */

import assert from "assert";
import {
  createOrderIntent,
  createOrderIntentIdempotent,
  getOrderIntentById,
  getOrderIntentByIdempotencyKey,
  appendOrderIntentEvent,
  createExecutedOrder,
  getExecutedOrderById,
  getExecutedOrderByVenueOrderId,
  linkExecutedOrderToIntent,
  appendExecutedOrderEvent,
  recordFillLedgerEntry,
  getFillLedgerEntryByVenueTradeId,
  getFillLedgerEntryByFunderAndExchangeFillId,
  getAppliedFillsForRebuild,
  getUnappliedFills,
  markFillApplied,
  createCancelRequest,
  createReplaceRequest,
  getExecutionTimelineForIntent,
} from "../repository";
import type { CreateOrderIntentInput, RecordFillLedgerEntryInput } from "../types";

function check(cond: boolean, msg: string): void {
  if (cond) {
    console.log("  OK:", msg);
  } else {
    throw new Error(`FAIL: ${msg}`);
  }
}

const funder = "0xexec-ledger-test";
const uniq = () => `test_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

async function run(): Promise<void> {
  let passed = 0;

  try {
    await createOrderIntent({
      funderAddress: funder,
      marketId: "m1",
      assetId: "a1",
      outcome: "Yes",
      side: "BUY",
      orderType: "GTC",
      limitPrice: "0.5",
      requestedSize: "10",
      status: "pending",
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("does not exist") || msg.includes("P2021") || msg.includes("connect") || msg.includes("Unknown arg")) {
      console.log("[SKIP] Execution ledger DB tests: migrations not applied or DATABASE_URL not set. Run: npx prisma migrate deploy");
      return;
    }
    throw e;
  }

  console.log("\n--- 1. Duplicate idempotency key: createOrderIntentIdempotent returns existing ---");
  {
    const key = uniq();
    const input: CreateOrderIntentInput = {
      funderAddress: funder,
      marketId: "m1",
      assetId: "a1",
      outcome: "Yes",
      side: "BUY",
      orderType: "GTC",
      limitPrice: "0.55",
      requestedSize: "20",
      status: "pending",
      idempotencyKey: key,
    };
    const r1 = await createOrderIntentIdempotent(input);
    check(r1.existing === false, "first create returns existing false");
    const r2 = await createOrderIntentIdempotent(input);
    check(r2.existing === true, "second create with same key returns existing true");
    check(r2.record.id === r1.record.id, "same intent id returned for duplicate key");
    passed++;
  }

  console.log("\n--- 2. Duplicate venueTradeId cannot create second fill record ---");
  {
    const venueTradeId = uniq();
    const base: RecordFillLedgerEntryInput = {
      funderAddress: funder,
      exchangeFillId: uniq(),
      assetId: "a1",
      marketId: "m1",
      side: "BUY",
      fillSize: 5,
      fillPrice: 0.5,
      filledAt: new Date(),
      source: "execution_ledger",
      venueTradeId,
    };
    const f1 = await recordFillLedgerEntry(base);
    check(f1.duplicate === false, "first fill recorded");
    const f2 = await recordFillLedgerEntry({ ...base, exchangeFillId: uniq() });
    check(f2.duplicate === true, "second fill with same venueTradeId returns duplicate true");
    check(f2.record.id === f1.record.id, "same fill id for duplicate venueTradeId");
    passed++;
  }

  console.log("\n--- 3. markFillApplied can only transition once ---");
  {
    const fillId = uniq();
    const { record } = await recordFillLedgerEntry({
      funderAddress: funder,
      exchangeFillId: fillId,
      assetId: "a1",
      marketId: "m1",
      side: "BUY",
      fillSize: 1,
      fillPrice: 0.5,
      filledAt: new Date(),
      source: "execution_ledger",
    });
    const ok1 = await markFillApplied({ id: record.id });
    check(ok1 === true, "first markFillApplied returns true");
    const ok2 = await markFillApplied({ id: record.id });
    check(ok2 === false, "second markFillApplied returns false (already applied)");
    passed++;
  }

  console.log("\n--- 4. Order intent event appends correctly ---");
  {
    const intent = await createOrderIntent({
      funderAddress: funder,
      marketId: "m1",
      assetId: "a1",
      outcome: "Yes",
      side: "BUY",
      orderType: "GTC",
      limitPrice: "0.5",
      requestedSize: "10",
      status: "pending",
    });
    const eventId1 = await appendOrderIntentEvent({
      orderIntentId: intent.id,
      eventType: "created",
      payloadJson: JSON.stringify({ at: Date.now() }),
    });
    check(!!eventId1, "appendOrderIntentEvent returns id");
    const timeline = await getExecutionTimelineForIntent({ orderIntentId: intent.id });
    const intentEvents = timeline.filter((r) => r.kind === "intent_event");
    check(intentEvents.length >= 1, "timeline includes intent event");
    passed++;
  }

  console.log("\n--- 5. Executed order can be linked to intent after creation ---");
  {
    const intent = await createOrderIntent({
      funderAddress: funder,
      marketId: "m1",
      assetId: "a1",
      outcome: "Yes",
      side: "BUY",
      orderType: "GTC",
      limitPrice: "0.5",
      requestedSize: "10",
      status: "pending",
    });
    const order = await createExecutedOrder({
      funderAddress: funder,
      polymarketOrderId: uniq(),
      venueOrderId: uniq(),
      marketId: "m1",
      assetId: "a1",
      side: "BUY",
      price: "0.5",
      size: "10",
      status: "working",
    });
    check(order.orderIntentId == null, "order not linked initially");
    await linkExecutedOrderToIntent(order.id, intent.id);
    const linked = await getExecutedOrderById(order.id);
    check(linked != null && linked.orderIntentId === intent.id, "order linked to intent after linkExecutedOrderToIntent");
    passed++;
  }

  console.log("\n--- 6. Timeline query returns intent + events + executed order + order events + fills in order ---");
  {
    const intent = await createOrderIntent({
      funderAddress: funder,
      marketId: "m1",
      assetId: "a1",
      outcome: "Yes",
      side: "BUY",
      orderType: "GTC",
      limitPrice: "0.5",
      requestedSize: "10",
      status: "placed",
    });
    await appendOrderIntentEvent({ orderIntentId: intent.id, eventType: "submitted", payloadJson: null });
    const order = await createExecutedOrder({
      funderAddress: funder,
      orderIntentId: intent.id,
      polymarketOrderId: uniq(),
      venueOrderId: uniq(),
      marketId: "m1",
      assetId: "a1",
      side: "BUY",
      price: "0.5",
      size: "10",
      status: "working",
    });
    await appendExecutedOrderEvent({ executedOrderId: order.id, eventType: "ack", payloadJson: "{}" });
    const timeline = await getExecutionTimelineForIntent({ orderIntentId: intent.id, limit: 50 });
    check(timeline.length >= 4, "timeline has intent + intent_event + executed_order + order_event");
    const kinds = timeline.map((r) => r.kind);
    check(kinds.includes("intent"), "timeline has intent");
    check(kinds.includes("intent_event"), "timeline has intent_event");
    check(kinds.includes("executed_order"), "timeline has executed_order");
    check(kinds.includes("order_event"), "timeline has order_event");
    for (let i = 1; i < timeline.length; i++) {
      check(
        timeline[i].occurredAt.getTime() >= timeline[i - 1].occurredAt.getTime(),
        "timeline sorted by occurredAt"
      );
    }
    passed++;
  }

  console.log("\n--- 7a. getFillLedgerEntryByFunderAndExchangeFillId and applied state ---");
  {
    const exFillId = uniq();
    const { record } = await recordFillLedgerEntry({
      funderAddress: funder,
      exchangeFillId: exFillId,
      assetId: "a1",
      marketId: "m1",
      side: "BUY",
      fillSize: 2,
      fillPrice: 0.5,
      filledAt: new Date(),
      source: "execution_ledger",
    });
    const row = await getFillLedgerEntryByFunderAndExchangeFillId(funder, exFillId);
    check(row != null && row.id === record.id, "get by funder+exchangeFillId returns same record");
    check(row!.appliedToRuntimePosition === false, "initially unapplied");
    await markFillApplied({ id: record.id });
    const row2 = await getFillLedgerEntryByFunderAndExchangeFillId(funder, exFillId);
    check(row2 != null && row2.appliedToRuntimePosition === true, "after mark applied, row is applied");
    passed++;
  }

  console.log("\n--- 7b. getAppliedFillsForRebuild vs getUnappliedFills ---");
  {
    const ex1 = uniq();
    const ex2 = uniq();
    const { record: r1 } = await recordFillLedgerEntry({
      funderAddress: funder,
      exchangeFillId: ex1,
      assetId: "a1",
      marketId: "m1",
      side: "BUY",
      fillSize: 1,
      fillPrice: 0.5,
      filledAt: new Date(Date.now() - 1000),
      source: "execution_ledger",
    });
    await recordFillLedgerEntry({
      funderAddress: funder,
      exchangeFillId: ex2,
      assetId: "a1",
      marketId: "m1",
      side: "BUY",
      fillSize: 1,
      fillPrice: 0.52,
      filledAt: new Date(),
      source: "execution_ledger",
    });
    const unappliedBefore = await getUnappliedFills(funder);
    const appliedBefore = await getAppliedFillsForRebuild(funder);
    const hasEx1 = unappliedBefore.some((u) => u.exchangeFillId === ex1);
    const hasEx2 = unappliedBefore.some((u) => u.exchangeFillId === ex2);
    check(hasEx1 && hasEx2, "both new fills in unapplied");
    await markFillApplied({ id: r1.id });
    const unappliedAfter = await getUnappliedFills(funder);
    const appliedAfter = await getAppliedFillsForRebuild(funder);
    check(!unappliedAfter.some((u) => u.exchangeFillId === ex1), "ex1 no longer in unapplied");
    check(unappliedAfter.some((u) => u.exchangeFillId === ex2), "ex2 still unapplied");
    check(appliedAfter.some((a) => a.exchangeFillId === ex1), "ex1 in applied for rebuild");
    passed++;
  }

  console.log("\n--- 8. Cancel and replace requests persist correctly ---");
  {
    const order = await createExecutedOrder({
      funderAddress: funder,
      polymarketOrderId: uniq(),
      venueOrderId: uniq(),
      marketId: "m1",
      assetId: "a1",
      side: "BUY",
      price: "0.5",
      size: "10",
      status: "working",
    });
    const cancelId = await createCancelRequest({
      executedOrderId: order.id,
      status: "pending",
      reason: "test",
    });
    check(!!cancelId, "createCancelRequest returns id");
    const replaceId = await createReplaceRequest({
      executedOrderId: order.id,
      newPrice: "0.55",
      newSize: "15",
      status: "pending",
    });
    check(!!replaceId, "createReplaceRequest returns id");
    passed++;
  }

  console.log("\nPassed:", passed, "suites");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
