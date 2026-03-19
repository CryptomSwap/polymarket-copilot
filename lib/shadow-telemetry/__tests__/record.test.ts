/**
 * Shadow telemetry record tests: blocked and allowed candidate persistence.
 * Uses DB; skip if ShadowCandidate table not present.
 */

import { recordShadowCandidate } from "../record";
import { prisma } from "@/lib/db";

function check(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

async function run(): Promise<void> {
  let canRun = false;
  try {
    await prisma.shadowCandidate.findFirst();
    canRun = true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("does not exist") || msg.includes("P2021") || msg.includes("ShadowCandidate")) {
      console.log("[SKIP] ShadowCandidate table not present; run migrations.");
      return;
    }
    throw e;
  }
  if (!canRun) return;

  const funder = "0xshadow_test_" + Date.now();
  const assetId = "asset_shadow_test";
  const marketId = "market_shadow_test";

  console.log("\n--- 1. Blocked candidate telemetry persists ---");
  const r1 = await recordShadowCandidate({
    funderAddress: funder,
    assetId,
    marketId,
    side: "BUY",
    intendedPrice: 0.5,
    intendedSize: 10,
    wasBlocked: true,
    blockingReasons: ["guardrail_blocked", "market_data_stale"],
    wasSubmitted: false,
  });
  check(r1.ok === true && r1.id != null, "blocked candidate recorded");
  const row1 = await prisma.shadowCandidate.findUnique({ where: { id: r1.id! } });
  check(row1 != null && row1.wasBlocked === true, "row persisted and wasBlocked true");
  check(Array.isArray(row1!.blockingReasons) && (row1!.blockingReasons as string[]).length >= 1, "blockingReasons stored");

  console.log("\n--- 2. Allowed candidate telemetry persists ---");
  const r2 = await recordShadowCandidate({
    funderAddress: funder,
    orderIntentId: "intent_123",
    assetId,
    marketId,
    side: "SELL",
    intendedPrice: 0.6,
    intendedSize: 5,
    wasBlocked: false,
    wasSubmitted: true,
    executionPolicySnapshotJson: '{"allow":true}',
  });
  check(r2.ok === true && r2.id != null, "allowed candidate recorded");
  const row2 = await prisma.shadowCandidate.findUnique({ where: { id: r2.id! } });
  check(row2 != null && row2.wasBlocked === false && row2.wasSubmitted === true, "allowed row persisted");

  console.log("\nAll shadow-telemetry record tests passed.");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
