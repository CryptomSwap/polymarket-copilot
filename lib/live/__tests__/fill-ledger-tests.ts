/**
 * Fill ledger tests: duplicate detection, replay, and double-apply prevention.
 * Requires DATABASE_URL and applied migration (FillLedgerEntry table).
 * Run migration: npx prisma migrate deploy (or migrate dev).
 *
 * Run with (from repo root):
 *   npx ts-node --project tsconfig.tests.json -r tsconfig-paths/register lib/live/__tests__/fill-ledger-tests.ts
 */

import assert from "assert";
import {
  recordFill,
  markFillAppliedToPosition,
  isFillAppliedToPosition,
  getUnappliedFills,
  ledgerEntryToPositionFill,
  type RecordFillParams,
  type UnappliedFillEntry,
} from "../fill-ledger";
import { InMemoryRuntimePositionStore } from "@/lib/runtime/positions/runtime-position-store";
import { DefaultRuntimePositionUpdater } from "@/lib/runtime/positions/runtime-position-updater";
import { InMemoryRuntimeEventBus } from "@/lib/runtime/events/runtime-event-bus";

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

  const funder = "0xf1";
  const baseParams: Omit<RecordFillParams, "source"> = {
    funderAddress: funder,
    exchangeFillId: "trade-1",
    clientOrderId: "ord-1",
    exchangeOrderId: "ex-1",
    assetId: "a1",
    marketId: "m1",
    side: "BUY",
    size: 5,
    price: 0.55,
    filledAt: new Date(),
  };

  console.log("\n--- ledgerEntryToPositionFill produces valid shape for position updater (no DB) ---");
  {
    const entry: UnappliedFillEntry = {
      id: "ledger-id",
      funderAddress: funder,
      exchangeFillId: "ex-1",
      assetId: "a1",
      marketId: "m1",
      side: "BUY",
      size: 3,
      price: 0.5,
      filledAt: new Date(),
      outcome: "Yes",
    };
    const fill = ledgerEntryToPositionFill(entry);
    check(fill.funderAddress === funder && fill.assetId === "a1" && fill.size === 3, "ledger entry maps to position fill");
    const store = new InMemoryRuntimePositionStore();
    const bus = new InMemoryRuntimeEventBus();
    const updater = new DefaultRuntimePositionUpdater({ store, eventBus: bus, eventSource: "order_manager" });
    updater.applyFill(fill);
    const pos = store.getPosition(funder, "a1");
    check(pos != null && pos.netShares === 3, "unapplied fill replay applies to position correctly");
  }

  try {
    await recordFill({ ...baseParams, exchangeFillId: "probe-" + Date.now(), source: "user_feed" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("does not exist") || msg.includes("P2021") || msg.includes("connect")) {
      console.log("\n[SKIP] Fill ledger DB tests: migration not applied or DATABASE_URL not set. Run: npx prisma migrate deploy");
      console.log("Passed:", passed, "Failed:", failed);
      return;
    }
    throw e;
  }

  console.log("\n--- Duplicate fill same process: recordFill returns recorded false on second call ---");
  {
    const r1 = await recordFill({ ...baseParams, exchangeFillId: "dup-1", source: "user_feed" });
    check(r1.recorded === true, "first record returns recorded true");
    const r2 = await recordFill({ ...baseParams, exchangeFillId: "dup-1", source: "user_feed" });
    check(r2.recorded === false, "second record (same exchangeFillId) returns recorded false");
    check(r2.id === r1.id, "same id returned for duplicate");
  }

  console.log("\n--- isFillAppliedToPosition and markFillAppliedToPosition ---");
  {
    const fillId = "fill-applied-1";
    await recordFill({ ...baseParams, exchangeFillId: fillId, source: "user_feed" });
    let applied = await isFillAppliedToPosition(funder, fillId);
    check(applied === false, "initially not applied");
    await markFillAppliedToPosition({ funderAddress: funder, exchangeFillId: fillId });
    applied = await isFillAppliedToPosition(funder, fillId);
    check(applied === true, "after markFillAppliedToPosition, is applied");
  }

  console.log("\n--- getUnappliedFills returns only unapplied; replay order by filledAt ---");
  {
    const id1 = "replay-1";
    const id2 = "replay-2";
    await recordFill({
      ...baseParams,
      exchangeFillId: id1,
      filledAt: new Date(Date.now() - 10000),
      source: "user_feed",
    });
    await recordFill({
      ...baseParams,
      exchangeFillId: id2,
      filledAt: new Date(Date.now() - 5000),
      source: "user_feed",
    });
    const unapplied = await getUnappliedFills(funder);
    const ids = unapplied.map((u) => u.exchangeFillId);
    check(ids.includes(id1) && ids.includes(id2), "both fills in unapplied list");
    check(unapplied[0].filledAt.getTime() <= unapplied[1].filledAt.getTime(), "ordered by filledAt ascending");
    await markFillAppliedToPosition({ funderAddress: funder, exchangeFillId: id1 });
    await markFillAppliedToPosition({ funderAddress: funder, exchangeFillId: id2 });
    const after = await getUnappliedFills(funder);
    check(after.filter((u) => u.exchangeFillId === id1 || u.exchangeFillId === id2).length === 0, "after mark applied, not in unapplied");
  }

  console.log("\n--- Durable ledger prevents double-count: apply same fill twice via ledger check ---");
  {
    const store = new InMemoryRuntimePositionStore();
    const bus = new InMemoryRuntimeEventBus();
    const updater = new DefaultRuntimePositionUpdater({ store, eventBus: bus, eventSource: "order_manager" });
    const noDoubleId = "no-double-1";
    await recordFill({ ...baseParams, exchangeFillId: noDoubleId, size: 4, source: "user_feed" });
    const entry = (await getUnappliedFills(funder)).find((u) => u.exchangeFillId === noDoubleId);
    ok(!!entry, "entry exists");
    updater.applyFill(ledgerEntryToPositionFill(entry!));
    await markFillAppliedToPosition({ funderAddress: funder, exchangeFillId: noDoubleId });
    const applied = await isFillAppliedToPosition(funder, noDoubleId);
    check(applied === true, "marked applied after first apply");
    const posAfterFirst = store.getPosition(funder, baseParams.assetId);
    check(posAfterFirst?.netShares === 4, "position 4 after first apply");
    const wouldApplyAgain = await isFillAppliedToPosition(funder, noDoubleId);
    check(wouldApplyAgain === true, "second apply would be skipped (already applied)");
    if (!wouldApplyAgain) {
      updater.applyFill(ledgerEntryToPositionFill(entry!));
    }
    const posAfterSecond = store.getPosition(funder, baseParams.assetId);
    check(posAfterSecond?.netShares === 4, "position still 4 (no double-count)");
  }

  console.log("\n--- Summary ---");
  console.log("Passed:", passed, "Failed:", failed);
  if (failed > 0) process.exit(1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
