/**
 * API order path ledger tests: idempotency key, durable intent, duplicate same key returns existing.
 * Requires DATABASE_URL and applied migrations.
 *
 * Run with (from repo root):
 *   npx ts-node --project tsconfig.tests.json -r tsconfig-paths/register lib/execution-ledger/__tests__/api-order-ledger.test.ts
 */

import {
  createIntentWithEvent,
  appendOrderIntentEventToLedger,
  markOrderIntentStatusInLedger,
  createExecutedOrderForIntent,
  appendExecutedOrderEventForOrder,
  getIntentTimeline,
  getExecutedOrder,
} from "../service";
import { buildApiOrderIdempotencyKey } from "../idempotency";
import type { CreateOrderIntentInput } from "../types";

const funder = "0xapi-order-test";
const uniq = () => `api_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

function check(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

async function run(): Promise<void> {
  const key = buildApiOrderIdempotencyKey({
    funderAddress: funder,
    assetId: "a1",
    side: "BUY",
    orderType: "GTC",
    limitPrice: 0.5,
    requestedSize: 10,
  });
  check(key.length > 0 && key.includes("api"), "api idempotency key contains source");

  try {
    await createIntentWithEvent(
      {
        funderAddress: funder,
        marketId: "m0",
        assetId: "a0",
        outcome: "YES",
        side: "BUY",
        orderType: "GTC",
        limitPrice: "0.5",
        requestedSize: "1",
        status: "pending",
        idempotencyKey: uniq(),
        source: "api",
      },
      { eventType: "CREATED", payloadJson: null }
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("does not exist") || msg.includes("P2021") || msg.includes("P2022") || msg.includes("connect") || msg.includes("Unknown arg")) {
      console.log("[SKIP] DB not available. Run: npx prisma migrate deploy");
      return;
    }
    throw e;
  }

  console.log("\n--- 1. API path creates durable OrderIntent once ---");
  {
    const key = uniq();
    const input: CreateOrderIntentInput = {
      funderAddress: funder,
      marketId: "m1",
      assetId: "a1",
      outcome: "YES",
      side: "BUY",
      orderType: "GTC",
      limitPrice: "0.5",
      requestedSize: "10",
      status: "pending",
      idempotencyKey: key,
      source: "api",
    };
    const r = await createIntentWithEvent(input, { eventType: "CREATED", payloadJson: null });
    check(r.intent.id != null, "intent created");
    check(r.intent.source === "api", "source is api");
    await appendOrderIntentEventToLedger({
      orderIntentId: r.intent.id,
      eventType: "API_REQUESTED",
      payloadJson: null,
    });
  }

  console.log("\n--- 2. Duplicate request with same idempotency key does not create duplicate intent ---");
  {
    const key = uniq();
    const input: CreateOrderIntentInput = {
      funderAddress: funder,
      marketId: "m2",
      assetId: "a2",
      outcome: "YES",
      side: "BUY",
      orderType: "GTC",
      limitPrice: "0.55",
      requestedSize: "20",
      status: "pending",
      idempotencyKey: key,
      source: "api",
    };
    const r1 = await createIntentWithEvent(input, { eventType: "CREATED", payloadJson: null });
    check(!r1.existing, "first create returns existing false");
    const r2 = await createIntentWithEvent(input, { eventType: "CREATED", payloadJson: null });
    check(r2.existing, "second with same key returns existing true");
    check(r2.intent.id === r1.intent.id, "same intent id for duplicate key");
  }

  console.log("\n--- 3. ExecutedOrder is linked to OrderIntent ---");
  {
    const key = uniq();
    const input: CreateOrderIntentInput = {
      funderAddress: funder,
      marketId: "m3",
      assetId: "a3",
      outcome: "YES",
      side: "BUY",
      orderType: "GTC",
      limitPrice: "0.5",
      requestedSize: "5",
      status: "pending",
      idempotencyKey: key,
      source: "api",
    };
    const { intent } = await createIntentWithEvent(input, { eventType: "CREATED", payloadJson: null });
    const venId = `poly_${uniq()}`;
    const { executedOrderId } = await createExecutedOrderForIntent(
      {
        funderAddress: funder,
        marketId: "m3",
        assetId: "a3",
        side: "BUY",
        orderType: "GTC",
        price: "0.5",
        size: "5",
        status: "submitted",
        venue: "polymarket",
        polymarketOrderId: venId,
        venueOrderId: venId,
      },
      { linkToIntentId: intent.id }
    );
    const timeline = await getIntentTimeline(intent.id, 20);
    const orderRow = timeline.find((r) => r.kind === "executed_order");
    check(orderRow != null && orderRow.id === executedOrderId, "timeline includes executed order linked to intent");
    const exec = await getExecutedOrder(executedOrderId);
    check(exec?.orderIntentId === intent.id, "executed order has orderIntentId");
  }

  console.log("\n--- 4. Expected intent/order events are written ---");
  {
    const key = uniq();
    const input: CreateOrderIntentInput = {
      funderAddress: funder,
      marketId: "m4",
      assetId: "a4",
      outcome: "YES",
      side: "BUY",
      orderType: "GTC",
      limitPrice: "0.5",
      requestedSize: "8",
      status: "pending",
      idempotencyKey: key,
      source: "api",
    };
    const { intent } = await createIntentWithEvent(input, { eventType: "CREATED", payloadJson: null });
    await appendOrderIntentEventToLedger({ orderIntentId: intent.id, eventType: "API_REQUESTED", payloadJson: null });
    await markOrderIntentStatusInLedger(intent.id, "placed");
    await appendOrderIntentEventToLedger({
      orderIntentId: intent.id,
      eventType: "READY_FOR_SUBMISSION",
      payloadJson: JSON.stringify({ polymarketOrderId: "poly-123" }),
    });
    const { executedOrderId } = await createExecutedOrderForIntent(
      {
        funderAddress: funder,
        marketId: "m4",
        assetId: "a4",
        side: "BUY",
        orderType: "GTC",
        price: "0.5",
        size: "8",
        status: "submitted",
        venue: "polymarket",
        polymarketOrderId: "poly-123",
        venueOrderId: "poly-123",
      },
      { linkToIntentId: intent.id }
    );
    await appendExecutedOrderEventForOrder({
      executedOrderId,
      eventType: "SUBMITTED",
      payloadJson: JSON.stringify({ polymarketOrderId: "poly-123" }),
    });
    const timeline = await getIntentTimeline(intent.id, 30);
    const eventTypes = timeline.filter((r) => r.kind === "intent_event").map((r) => r.eventType);
    const orderEventTypes = timeline.filter((r) => r.kind === "order_event").map((r) => r.eventType);
    check(eventTypes.includes("CREATED"), "CREATED event");
    check(eventTypes.includes("API_REQUESTED"), "API_REQUESTED event");
    check(eventTypes.includes("READY_FOR_SUBMISSION"), "READY_FOR_SUBMISSION event");
    check(orderEventTypes.includes("SUBMITTED"), "SUBMITTED order event");
  }

  console.log("\n--- 5. buildApiOrderIdempotencyKey is deterministic ---");
  {
    const k1 = buildApiOrderIdempotencyKey({
      funderAddress: funder,
      assetId: "a",
      side: "BUY",
      orderType: "GTC",
      limitPrice: 0.5,
      requestedSize: 10,
      recommendationId: "rec1",
    });
    const k2 = buildApiOrderIdempotencyKey({
      funderAddress: funder,
      assetId: "a",
      side: "BUY",
      orderType: "GTC",
      limitPrice: 0.5,
      requestedSize: 10,
      recommendationId: "rec1",
    });
    check(k1 === k2, "same inputs => same key");
  }

  console.log("\nAll API order ledger tests passed.");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
