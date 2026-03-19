/**
 * Regression tests for runtime readiness intent-unblock fixes:
 * - Fix A: watchdogState only "kill_switch" when kill switch is currently active
 * - Fix B: userDataHealthy true when user connection open and no open orders (even if no WS data events)
 *
 * Run: npx ts-node --project tsconfig.tests.json -r tsconfig-paths/register lib/runtime/__tests__/runtime-readiness-intent-unblock-tests.ts
 */

import assert from "assert";
import { deriveWatchdogState } from "@/lib/runtime/stream-watchdog";
import { computeUserDataHealthy } from "@/lib/runtime/runtime-health";
import type { StreamConnectionState } from "@/lib/runtime/stream-connection-state";

function ok(cond: boolean, msg: string): void {
  assert.strictEqual(cond, true, msg);
}

function run(): void {
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

  const now = Date.now();
  const thresholdMs = 90_000;

  console.log("\n--- Fix A: deriveWatchdogState (kill_switch only when currently active) ---");
  {
    check(
      deriveWatchdogState(true, true, 0) === "kill_switch",
      "triggered + active => kill_switch"
    );
    check(
      deriveWatchdogState(true, false, 1) === "degraded",
      "triggered but cleared + reasons => degraded (not sticky kill_switch)"
    );
    check(
      deriveWatchdogState(true, false, 0) === "ok",
      "triggered but cleared + no reasons => ok"
    );
    check(
      deriveWatchdogState(false, false, 1) === "degraded",
      "not triggered + reasons => degraded"
    );
    check(
      deriveWatchdogState(false, false, 0) === "ok",
      "not triggered + no reasons => ok"
    );
  }

  console.log("\n--- Fix B: computeUserDataHealthy (no open orders => may be healthy without WS data) ---");
  const openUserNoData: StreamConnectionState = {
    status: "open",
    lastOpenAt: new Date(now - 60_000),
    lastMessageAt: null,
    lastErrorAt: null,
    lastError: null,
    reconnectAttempts: 0,
    lastDataEventAt: null,
  };
  const openUserWithFreshData: StreamConnectionState = {
    ...openUserNoData,
    lastDataEventAt: new Date(now - 5_000),
  };
  const openUserWithStaleWsData: StreamConnectionState = {
    ...openUserNoData,
    lastDataEventAt: new Date(now - (thresholdMs + 15_000)),
  };
  {
    check(
      !computeUserDataHealthy(null, now, thresholdMs, 0),
      "null user => false"
    );
    check(
      computeUserDataHealthy(openUserNoData, now, thresholdMs, 0),
      "user open, no data, 0 orders => true (no orders to confirm)"
    );
    check(
      !computeUserDataHealthy(openUserNoData, now, thresholdMs, 1),
      "user open, no data, 1 order => false (stricter when orders exist)"
    );
    check(
      computeUserDataHealthy(openUserNoData, now, thresholdMs, 1, new Date(now - 5_000)),
      "user open, no WS data, 1 order, recent REST user truth => true"
    );
    check(
      computeUserDataHealthy(openUserWithFreshData, now, thresholdMs, 1),
      "user open, fresh data, 1 order => true"
    );
    check(
      computeUserDataHealthy(openUserWithStaleWsData, now, thresholdMs, 1, new Date(now - 3_000)),
      "user open, stale WS data, 1 order, fresh REST truth => true"
    );
    check(
      !computeUserDataHealthy(
        { ...openUserNoData, status: "closed" },
        now,
        thresholdMs,
        0
      ),
      "user closed => false"
    );
  }

  console.log("\n--- Result ---");
  console.log(`Passed: ${passed}, Failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

run();
