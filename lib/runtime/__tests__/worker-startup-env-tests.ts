/**
 * Worker startup env and StreamSyncState delegate.
 * Run with: npx ts-node --project tsconfig.tests.json -r tsconfig-paths/register lib/runtime/__tests__/worker-startup-env-tests.ts
 */

import assert from "assert";
import { prisma } from "@/lib/db";

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

  console.log("\n--- Worker startup env (same logic as worker/index.ts) ---");
  const savedUseStreamRuntime = process.env.USE_STREAM_RUNTIME;
  try {
    // Worker uses: process.env.USE_STREAM_RUNTIME === "true"
    const cases: [string | undefined, boolean][] = [
      ["true", true],
      ["TRUE", false],
      ["false", false],
      ["", false],
      [undefined, false],
    ];
    for (const [value, expected] of cases) {
      if (value === undefined) delete process.env.USE_STREAM_RUNTIME;
      else process.env.USE_STREAM_RUNTIME = value;
      const useStreamRuntime = process.env.USE_STREAM_RUNTIME === "true";
      check(useStreamRuntime === expected, `USE_STREAM_RUNTIME=${String(value)} -> ${expected}`);
    }
  } finally {
    if (savedUseStreamRuntime !== undefined) process.env.USE_STREAM_RUNTIME = savedUseStreamRuntime;
    else delete process.env.USE_STREAM_RUNTIME;
  }

  console.log("\n--- StreamSyncState delegate (streaming-sync uses prisma.stream_sync_state) ---");
  {
    // Prisma schema model is stream_sync_state; client exposes prisma.stream_sync_state
    const delegate = (prisma as unknown as { stream_sync_state?: unknown }).stream_sync_state;
    check(typeof delegate === "object" && delegate !== null, "prisma.stream_sync_state is defined");
    check(
      typeof (delegate as { findUnique?: unknown }).findUnique === "function",
      "prisma.stream_sync_state.findUnique exists"
    );
  }

  console.log("\n--- Summary ---");
  console.log(`  Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
