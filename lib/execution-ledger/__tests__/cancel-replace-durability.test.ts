/**
 * Cancel/replace durability tests: CancelRequest, ReplaceRequest, ExecutedOrderEvent lifecycle, timeline.
 * Requires DATABASE_URL and applied migrations.
 *
 * Run with (from repo root):
 *   npx ts-node --project tsconfig.tests.json -r tsconfig-paths/register lib/execution-ledger/__tests__/cancel-replace-durability.test.ts
 */

import {
  createIntentWithEvent,
  createExecutedOrderForIntent,
  appendExecutedOrderEventForOrder,
  createCancelRequestForOrder,
  markCancelRequestStatus,
  createReplaceRequestForOrder,
  markReplaceRequestStatus,
  getExecutedOrderByVenueOrderId,
  getIntentTimeline,
  markExecutedOrderStatus,
} from "../service";
import type { CreateOrderIntentInput } from "../types";

const funder = "0xcancel-replace-test";
const uniq = () => `cr_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

function check(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

async function run(): Promise<void> {
  try {
    const input: CreateOrderIntentInput = {
      funderAddress: funder,
      marketId: "m1",
      assetId: "a1",
      outcome: "YES",
      side: "BUY",
      orderType: "LIMIT",
      limitPrice: "0.5",
      requestedSize: "10",
      status: "created",
      idempotencyKey: uniq(),
      source: "runtime_automated",
    };
    await createIntentWithEvent(input, { eventType: "CREATED", payloadJson: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("does not exist") || msg.includes("P2021") || msg.includes("connect") || msg.includes("Unknown arg")) {
      console.log("[SKIP] DB not available. Run: npx prisma migrate deploy");
      return;
    }
    throw e;
  }

  console.log("\n--- 1. Cancel request persists and links to executed order ---");
  {
    const venId = `paper_${uniq()}`;
    const { intent } = await createIntentWithEvent(
      {
        funderAddress: funder,
        marketId: "m2",
        assetId: "a2",
        outcome: "YES",
        side: "BUY",
        orderType: "LIMIT",
        limitPrice: "0.5",
        requestedSize: "5",
        status: "created",
        idempotencyKey: uniq(),
        source: "runtime_automated",
      },
      { eventType: "CREATED", payloadJson: null }
    );
    const { executedOrderId } = await createExecutedOrderForIntent(
      {
        funderAddress: funder,
        marketId: "m2",
        assetId: "a2",
        side: "BUY",
        orderType: "LIMIT",
        price: "0.5",
        size: "5",
        status: "open",
        venue: "paper",
        polymarketOrderId: venId,
        venueOrderId: venId,
      },
      { linkToIntentId: intent.id }
    );
    const cancelRequestId = await createCancelRequestForOrder({
      executedOrderId,
      status: "pending",
      reason: "test_cancel",
    });
    check(!!cancelRequestId, "cancel request created");
    const exec = await getExecutedOrderByVenueOrderId(venId);
    check(exec != null && exec.id === executedOrderId, "executed order found by venue order id");
  }

  console.log("\n--- 2. Replace request persists and links to executed order ---");
  {
    const venId = `paper_${uniq()}`;
    const { intent } = await createIntentWithEvent(
      {
        funderAddress: funder,
        marketId: "m3",
        assetId: "a3",
        outcome: "YES",
        side: "BUY",
        orderType: "LIMIT",
        limitPrice: "0.5",
        requestedSize: "8",
        status: "created",
        idempotencyKey: uniq(),
        source: "runtime_automated",
      },
      { eventType: "CREATED", payloadJson: null }
    );
    const { executedOrderId } = await createExecutedOrderForIntent(
      {
        funderAddress: funder,
        marketId: "m3",
        assetId: "a3",
        side: "BUY",
        orderType: "LIMIT",
        price: "0.5",
        size: "8",
        status: "open",
        venue: "paper",
        polymarketOrderId: venId,
        venueOrderId: venId,
      },
      { linkToIntentId: intent.id }
    );
    const replaceRequestId = await createReplaceRequestForOrder({
      executedOrderId,
      newPrice: "0.55",
      newSize: "10",
      status: "pending",
      reason: "test_replace",
    });
    check(!!replaceRequestId, "replace request created");
  }

  console.log("\n--- 3. Cancel lifecycle appends expected executed-order events ---");
  {
    const venId = `paper_${uniq()}`;
    const { intent } = await createIntentWithEvent(
      {
        funderAddress: funder,
        marketId: "m4",
        assetId: "a4",
        outcome: "YES",
        side: "BUY",
        orderType: "LIMIT",
        limitPrice: "0.5",
        requestedSize: "6",
        status: "created",
        idempotencyKey: uniq(),
        source: "runtime_automated",
      },
      { eventType: "CREATED", payloadJson: null }
    );
    const { executedOrderId } = await createExecutedOrderForIntent(
      {
        funderAddress: funder,
        marketId: "m4",
        assetId: "a4",
        side: "BUY",
        orderType: "LIMIT",
        price: "0.5",
        size: "6",
        status: "open",
        venue: "paper",
        polymarketOrderId: venId,
        venueOrderId: venId,
      },
      { linkToIntentId: intent.id }
    );
    const cancelRequestId = await createCancelRequestForOrder({
      executedOrderId,
      status: "pending",
      reason: "test",
    });
    await appendExecutedOrderEventForOrder({
      executedOrderId,
      eventType: "CANCEL_REQUESTED",
      payloadJson: JSON.stringify({ cancelRequestId }),
    });
    await appendExecutedOrderEventForOrder({
      executedOrderId,
      eventType: "CANCELED",
      payloadJson: JSON.stringify({ cancelRequestId }),
    });
    await markCancelRequestStatus(cancelRequestId, "completed");
    await markExecutedOrderStatus(executedOrderId, "canceled");
    const timeline = await getIntentTimeline(intent.id, 30);
    const orderEvents = timeline.filter((r) => r.kind === "order_event").map((r) => r.eventType);
    check(orderEvents.includes("CANCEL_REQUESTED"), "CANCEL_REQUESTED in timeline");
    check(orderEvents.includes("CANCELED"), "CANCELED in timeline");
    const cancelRequests = timeline.filter((r) => r.kind === "cancel_request");
    check(cancelRequests.length >= 1, "timeline includes cancel_request");
  }

  console.log("\n--- 4. Replace lifecycle appends expected executed-order events ---");
  {
    const venId = `paper_${uniq()}`;
    const { intent } = await createIntentWithEvent(
      {
        funderAddress: funder,
        marketId: "m5",
        assetId: "a5",
        outcome: "YES",
        side: "BUY",
        orderType: "LIMIT",
        limitPrice: "0.5",
        requestedSize: "7",
        status: "created",
        idempotencyKey: uniq(),
        source: "runtime_automated",
      },
      { eventType: "CREATED", payloadJson: null }
    );
    const { executedOrderId } = await createExecutedOrderForIntent(
      {
        funderAddress: funder,
        marketId: "m5",
        assetId: "a5",
        side: "BUY",
        orderType: "LIMIT",
        price: "0.5",
        size: "7",
        status: "open",
        venue: "paper",
        polymarketOrderId: venId,
        venueOrderId: venId,
      },
      { linkToIntentId: intent.id }
    );
    const replaceRequestId = await createReplaceRequestForOrder({
      executedOrderId,
      status: "pending",
      reason: "test",
    });
    await appendExecutedOrderEventForOrder({
      executedOrderId,
      eventType: "REPLACE_REQUESTED",
      payloadJson: JSON.stringify({ replaceRequestId }),
    });
    await appendExecutedOrderEventForOrder({
      executedOrderId,
      eventType: "REPLACED",
      payloadJson: JSON.stringify({ replaceRequestId, newExecutedOrderId: "new-id" }),
    });
    await markReplaceRequestStatus(replaceRequestId, "completed");
    const timeline = await getIntentTimeline(intent.id, 30);
    const orderEvents = timeline.filter((r) => r.kind === "order_event").map((r) => r.eventType);
    check(orderEvents.includes("REPLACE_REQUESTED"), "REPLACE_REQUESTED in timeline");
    check(orderEvents.includes("REPLACED"), "REPLACED in timeline");
    const replaceRequests = timeline.filter((r) => r.kind === "replace_request");
    check(replaceRequests.length >= 1, "timeline includes replace_request");
  }

  console.log("\n--- 5. Timeline includes cancel/replace artifacts in coherent order ---");
  {
    const venId = `paper_${uniq()}`;
    const { intent } = await createIntentWithEvent(
      {
        funderAddress: funder,
        marketId: "m6",
        assetId: "a6",
        outcome: "YES",
        side: "BUY",
        orderType: "LIMIT",
        limitPrice: "0.5",
        requestedSize: "4",
        status: "created",
        idempotencyKey: uniq(),
        source: "runtime_automated",
      },
      { eventType: "CREATED", payloadJson: null }
    );
    const { executedOrderId } = await createExecutedOrderForIntent(
      {
        funderAddress: funder,
        marketId: "m6",
        assetId: "a6",
        side: "BUY",
        orderType: "LIMIT",
        price: "0.5",
        size: "4",
        status: "open",
        venue: "paper",
        polymarketOrderId: venId,
        venueOrderId: venId,
      },
      { linkToIntentId: intent.id }
    );
    await appendExecutedOrderEventForOrder({ executedOrderId, eventType: "SUBMITTED", payloadJson: null });
    const cancelRequestId = await createCancelRequestForOrder({ executedOrderId, status: "pending", reason: "e2e" });
    await appendExecutedOrderEventForOrder({
      executedOrderId,
      eventType: "CANCEL_REQUESTED",
      payloadJson: JSON.stringify({ cancelRequestId }),
    });
    await appendExecutedOrderEventForOrder({
      executedOrderId,
      eventType: "CANCELED",
      payloadJson: JSON.stringify({ cancelRequestId }),
    });
    const timeline = await getIntentTimeline(intent.id, 50);
    const kinds = timeline.map((r) => r.kind);
    check(kinds.includes("intent"), "timeline has intent");
    check(kinds.includes("executed_order"), "timeline has executed_order");
    check(kinds.some((k) => k === "order_event"), "timeline has order_event");
    check(kinds.includes("cancel_request"), "timeline has cancel_request");
    let prev = 0;
    for (let i = 0; i < timeline.length; i++) {
      const t = timeline[i].occurredAt.getTime();
      check(t >= prev, `timeline ordered by occurredAt at index ${i}`);
      prev = t;
    }
  }

  console.log("\nAll cancel/replace durability tests passed.");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
