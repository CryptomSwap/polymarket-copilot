/**
 * User-feed duplicate fill: second delivery of same fill does not apply lifecycle (durable-first).
 * Requires DATABASE_URL and execution-ledger migrations.
 *
 * Run with (from repo root):
 *   npx ts-node --project tsconfig.tests.json -r tsconfig-paths/register lib/live/__tests__/user-feed-duplicate-fill.test.ts
 */

import assert from "assert";
import { InMemoryOrderLifecycleStore } from "@/lib/runtime/order-manager/order-lifecycle-store";
import { feedUserFeedResultToRuntime, type UserFeedRuntimeTelemetry } from "@/lib/live/user-feed-to-runtime";
import type { NormalizedUserFeedResult } from "../user-feed-normalizer";

function check(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

async function run(): Promise<void> {
  const funder = "0xuser-feed-dup-test";
  const clientOrderId = "client-1";
  const exchangeOrderId = "ex-order-1";
  const exchangeFillId = `trade:${exchangeOrderId}:${Date.now()}`;
  const at = new Date();

  const orderStore = new InMemoryOrderLifecycleStore();
  orderStore.create({
    clientOrderId,
    funderAddress: funder,
    assetId: "a1",
    marketId: "m1",
    side: "BUY",
    price: 0.5,
    size: 10,
  });
  orderStore.applyAck(clientOrderId, exchangeOrderId);

  const result: NormalizedUserFeedResult = {
    funderAddress: funder,
    lifecycle: {
      kind: "partial_fill",
      exchangeOrderId,
      at,
      fillSize: 3,
      fillPrice: 0.5,
    },
    positionFill: null,
    exchangeFillId,
  };

  const telemetry: UserFeedRuntimeTelemetry = {
    lifecycleApplied: 0,
    unmatchedOrderEvents: 0,
    lifecycleMismatch: 0,
    fillLedgerDuplicatesSkipped: 0,
  };

  try {
    await feedUserFeedResultToRuntime(result, {
      orderStore,
      lifecycleHandler: null,
      fillLedgerEnabled: true,
      telemetry,
    });
    check(telemetry.lifecycleApplied === 1, "first feed applies lifecycle once");
    check(telemetry.fillLedgerDuplicatesSkipped === 0, "first feed not duplicate");

    await feedUserFeedResultToRuntime(result, {
      orderStore,
      lifecycleHandler: null,
      fillLedgerEnabled: true,
      telemetry,
    });
    check(telemetry.fillLedgerDuplicatesSkipped === 1, "second feed counted as duplicate");
    check(telemetry.lifecycleApplied === 1, "lifecycle still only applied once (no double-apply)");
    console.log("  OK: duplicate fill event does not double-apply");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("does not exist") || msg.includes("P2021") || msg.includes("connect") || msg.includes("Unknown arg")) {
      console.log("[SKIP] User-feed duplicate fill test: DB not available. Run: npx prisma migrate deploy");
      return;
    }
    throw e;
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
