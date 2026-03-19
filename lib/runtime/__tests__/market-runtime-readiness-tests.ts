/**
 * Market runtime readiness: startup fallback and refresh behavior so desiredTrackedAssetIds
 * stays in sync with trackedAssetCount and market WS becomes operational.
 *
 * Run with (from repo root):
 *   npx ts-node --project tsconfig.tests.json -r tsconfig-paths/register lib/runtime/__tests__/market-runtime-readiness-tests.ts
 */

import assert from "assert";
import { shouldRetryTrackedAssetsWithNoFunder } from "@/lib/live/streaming-sync";

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

  console.log("\n--- shouldRetryTrackedAssetsWithNoFunder: do not retry when we have assets ---");
  {
    check(!shouldRetryTrackedAssetsWithNoFunder(["a1", "a2"], 300), "has assets => no retry");
    check(!shouldRetryTrackedAssetsWithNoFunder(["a1"], 0), "has one asset => no retry");
    check(!shouldRetryTrackedAssetsWithNoFunder(["a1"], null), "has assets and null count => no retry");
  }

  console.log("\n--- shouldRetryTrackedAssetsWithNoFunder: retry when empty but DB says we have count ---");
  {
    check(shouldRetryTrackedAssetsWithNoFunder([], 300), "empty ids and count 300 => retry");
    check(shouldRetryTrackedAssetsWithNoFunder([], 1), "empty ids and count 1 => retry");
    check(!shouldRetryTrackedAssetsWithNoFunder([], 0), "empty ids and count 0 => no retry");
    check(!shouldRetryTrackedAssetsWithNoFunder([], null), "empty ids and null count => no retry");
    check(!shouldRetryTrackedAssetsWithNoFunder([], undefined), "empty ids and undefined count => no retry");
  }

  console.log("\n--- Result ---");
  console.log(`Passed: ${passed}, Failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
