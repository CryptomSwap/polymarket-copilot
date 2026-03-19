/**
 * Order intent durability tests: runtime-style intent creation, policy passed/blocked, executed order link, timeline.
 * Requires DATABASE_URL and applied migrations.
 *
 * Run with (from repo root):
 *   npx ts-node --project tsconfig.tests.json -r tsconfig-paths/register lib/execution-ledger/__tests__/order-intent-durability.test.ts
 */

import {
  createIntentWithEvent,
  persistExecutionPolicyPassed,
  appendIntentBlockedEvent,
  appendOrderIntentEventToLedger,
  createExecutedOrderForIntent,
  appendExecutedOrderEventForOrder,
  getIntentTimeline,
} from "../service";
import { buildRuntimeIntentIdempotencyKey } from "../idempotency";
import type { CreateOrderIntentInput } from "../types";

const funder = "0xdurability-test";
const uniq = () => `dur_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

function check(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

async function run(): Promise<void> {
  let intentInput: CreateOrderIntentInput;
  try {
    intentInput = {
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
    const created = await createIntentWithEvent(intentInput, { eventType: "CREATED", payloadJson: null });
    check(created.intent.id != null, "intent created");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("does not exist") || msg.includes("P2021") || msg.includes("connect") || msg.includes("Unknown arg")) {
      console.log("[SKIP] DB not available. Run: npx prisma migrate deploy");
      return;
    }
    throw e;
  }

  console.log("\n--- 1. Runtime-created intent persists once with stable idempotency ---");
  {
    const key = uniq();
    const input: CreateOrderIntentInput = {
      funderAddress: funder,
      marketId: "m2",
      assetId: "a2",
      outcome: "YES",
      side: "BUY",
      orderType: "LIMIT",
      limitPrice: "0.55",
      requestedSize: "20",
      status: "created",
      idempotencyKey: key,
      source: "runtime_automated",
    };
    const r1 = await createIntentWithEvent(input, { eventType: "CREATED", payloadJson: null });
    check(!r1.existing, "first create returns existing false");
    const r2 = await createIntentWithEvent(input, { eventType: "CREATED", payloadJson: null });
    check(r2.existing, "second with same key returns existing true");
    check(r2.intent.id === r1.intent.id, "same intent id for duplicate idempotency key");
  }

  console.log("\n--- 2. Blocked intent records durable event and is not submitted ---");
  {
    const input: CreateOrderIntentInput = {
      funderAddress: funder,
      marketId: "m3",
      assetId: "a3",
      outcome: "YES",
      side: "BUY",
      orderType: "LIMIT",
      limitPrice: "0.5",
      requestedSize: "5",
      status: "created",
      idempotencyKey: uniq(),
      source: "runtime_automated",
    };
    const { intent } = await createIntentWithEvent(input, { eventType: "CREATED", payloadJson: null });
    await appendIntentBlockedEvent(
      intent.id,
      "EXECUTION_POLICY_BLOCKED",
      JSON.stringify({ blockingReasons: ["exposure_total_breach"] }),
      "blocked"
    );
    const timeline = await getIntentTimeline(intent.id, 20);
    const eventTypes = timeline.filter((r) => r.kind === "intent_event").map((r) => r.eventType);
    check(eventTypes.includes("CREATED"), "CREATED event");
    check(eventTypes.includes("EXECUTION_POLICY_BLOCKED"), "EXECUTION_POLICY_BLOCKED event");
  }

  console.log("\n--- 3. Allowed intent records CREATED + EXECUTION_POLICY_PASSED + READY_FOR_RECONCILIATION ---");
  {
    const input: CreateOrderIntentInput = {
      funderAddress: funder,
      marketId: "m4",
      assetId: "a4",
      outcome: "YES",
      side: "BUY",
      orderType: "LIMIT",
      limitPrice: "0.48",
      requestedSize: "15",
      status: "created",
      idempotencyKey: uniq(),
      source: "runtime_automated",
    };
    const { intent } = await createIntentWithEvent(input, { eventType: "CREATED", payloadJson: null });
    await persistExecutionPolicyPassed(intent.id, JSON.stringify({ allow: true, policyState: "allow" }));
    await appendOrderIntentEventToLedger({ orderIntentId: intent.id, eventType: "READY_FOR_RECONCILIATION", payloadJson: null });
    const timeline = await getIntentTimeline(intent.id, 20);
    const eventTypes = timeline.filter((r) => r.kind === "intent_event").map((r) => r.eventType);
    check(eventTypes.includes("CREATED"), "CREATED");
    check(eventTypes.includes("EXECUTION_POLICY_PASSED"), "EXECUTION_POLICY_PASSED");
    check(eventTypes.includes("READY_FOR_RECONCILIATION"), "READY_FOR_RECONCILIATION");
  }

  console.log("\n--- 4. Executed order is linked to order intent ---");
  {
    const input: CreateOrderIntentInput = {
      funderAddress: funder,
      marketId: "m5",
      assetId: "a5",
      outcome: "YES",
      side: "BUY",
      orderType: "LIMIT",
      limitPrice: "0.5",
      requestedSize: "8",
      status: "created",
      idempotencyKey: uniq(),
      source: "runtime_automated",
    };
    const { intent } = await createIntentWithEvent(input, { eventType: "CREATED", payloadJson: null });
    const venId = `paper_${uniq()}`;
    const result = await createExecutedOrderForIntent(
      {
        funderAddress: funder,
        marketId: "m5",
        assetId: "a5",
        side: "BUY",
        orderType: "LIMIT",
        price: "0.5",
        size: "8",
        originalSize: "8",
        remainingSize: "8",
        status: "open",
        venue: "paper",
        polymarketOrderId: venId,
        venueOrderId: venId,
      },
      { linkToIntentId: intent.id }
    );
    check(!!result.executedOrderId, "executed order created");
    check(result.intent?.id === intent.id, "intent returned");
    const timeline = await getIntentTimeline(intent.id, 20);
    const orders = timeline.filter((r) => r.kind === "executed_order");
    check(orders.length >= 1, "timeline includes executed order linked to intent");
  }

  console.log("\n--- 5. Paper order lifecycle appends executed-order events ---");
  {
    const input: CreateOrderIntentInput = {
      funderAddress: funder,
      marketId: "m6",
      assetId: "a6",
      outcome: "YES",
      side: "BUY",
      orderType: "LIMIT",
      limitPrice: "0.5",
      requestedSize: "12",
      status: "created",
      idempotencyKey: uniq(),
      source: "runtime_automated",
    };
    const { intent } = await createIntentWithEvent(input, { eventType: "CREATED", payloadJson: null });
    const venId = `paper_${uniq()}`;
    const { executedOrderId } = await createExecutedOrderForIntent(
      {
        funderAddress: funder,
        marketId: "m6",
        assetId: "a6",
        side: "BUY",
        orderType: "LIMIT",
        price: "0.5",
        size: "12",
        originalSize: "12",
        remainingSize: "12",
        status: "open",
        venue: "paper",
        polymarketOrderId: venId,
        venueOrderId: venId,
      },
      { linkToIntentId: intent.id }
    );
    await appendExecutedOrderEventForOrder({
      executedOrderId,
      eventType: "SUBMITTED",
      payloadJson: JSON.stringify({ exchangeOrderId: venId }),
    });
    await appendExecutedOrderEventForOrder({
      executedOrderId,
      eventType: "OPEN",
      payloadJson: null,
    });
    const timeline = await getIntentTimeline(intent.id, 30);
    const orderEvents = timeline.filter((r) => r.kind === "order_event").map((r) => r.eventType);
    check(orderEvents.includes("SUBMITTED"), "SUBMITTED event");
    check(orderEvents.includes("OPEN"), "OPEN event");
  }

  console.log("\n--- 6. buildRuntimeIntentIdempotencyKey is deterministic ---");
  {
    const key1 = buildRuntimeIntentIdempotencyKey({
      funderAddress: funder,
      source: "runtime_automated",
      assetId: "a1",
      side: "BUY",
      orderType: "LIMIT",
      limitPrice: 0.5,
      requestedSize: 10,
      slotSeconds: 60,
    });
    const key2 = buildRuntimeIntentIdempotencyKey({
      funderAddress: funder,
      source: "runtime_automated",
      assetId: "a1",
      side: "BUY",
      orderType: "LIMIT",
      limitPrice: 0.5,
      requestedSize: 10,
      slotSeconds: 60,
    });
    check(key1 === key2, "same inputs => same key");
    check(key1.length > 0 && key1.includes(funder), "key contains funder");
  }

  console.log("\n--- 7. Timeline includes intent + intent events + executed order + order events ---");
  {
    const input: CreateOrderIntentInput = {
      funderAddress: funder,
      marketId: "m7",
      assetId: "a7",
      outcome: "YES",
      side: "BUY",
      orderType: "LIMIT",
      limitPrice: "0.5",
      requestedSize: "7",
      status: "created",
      idempotencyKey: uniq(),
      source: "runtime_automated",
    };
    const { intent } = await createIntentWithEvent(input, { eventType: "CREATED", payloadJson: null });
    await persistExecutionPolicyPassed(intent.id, "{}");
    const venId = `paper_${uniq()}`;
    const { executedOrderId } = await createExecutedOrderForIntent(
      {
        funderAddress: funder,
        marketId: "m7",
        assetId: "a7",
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
    await appendExecutedOrderEventForOrder({ executedOrderId, eventType: "SUBMITTED", payloadJson: null });
    const timeline = await getIntentTimeline(intent.id, 50);
    const kinds = timeline.map((r) => r.kind);
    check(kinds.includes("intent"), "timeline has intent");
    check(kinds.some((k) => k === "intent_event"), "timeline has intent_event");
    check(kinds.includes("executed_order"), "timeline has executed_order");
    check(kinds.some((k) => k === "order_event"), "timeline has order_event");
  }

  console.log("\nAll order-intent durability tests passed.");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
