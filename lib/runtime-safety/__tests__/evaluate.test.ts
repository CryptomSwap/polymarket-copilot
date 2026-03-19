/**
 * Runtime safety evaluator tests: deterministic state transitions.
 *
 * Run with (from repo root):
 *   npx ts-node --project tsconfig.tests.json -r tsconfig-paths/register lib/runtime-safety/__tests__/evaluate.test.ts
 */

import assert from "assert";
import { evaluateRuntimeSafety } from "../evaluate";
import type { RuntimeSafetyInput } from "../types";

function check(cond: boolean, msg: string): void {
  assert.strictEqual(cond, true, msg);
}

function run(): void {
  console.log("\n--- 1. Kill switch triggers kill_switch state ---");
  {
    const input: RuntimeSafetyInput = {
      killSwitchActive: true,
      exchangeTruthAvailable: true,
      reconciliationLastOkAt: new Date(),
      marketFeedFreshnessMs: 10_000,
      userFeedFreshnessMs: 10_000,
      runtimePhase: "ready",
    };
    const r = evaluateRuntimeSafety(input);
    check(r.state === "kill_switch", "state is kill_switch");
    check(r.blockingReasons.includes("kill_switch_active"), "blocking reason");
  }

  console.log("\n--- 2. Exchange truth unavailable triggers blocked ---");
  {
    const input: RuntimeSafetyInput = {
      killSwitchActive: false,
      exchangeTruthAvailable: false,
      reconciliationLastOkAt: new Date(),
      marketFeedFreshnessMs: 10_000,
      userFeedFreshnessMs: 10_000,
      runtimePhase: "ready",
    };
    const r = evaluateRuntimeSafety(input);
    check(r.state === "blocked", "state is blocked");
    check(r.blockingReasons.includes("exchange_truth_unavailable"), "blocking reason");
  }

  console.log("\n--- 3. Reconciliation drift triggers blocked ---");
  {
    const input: RuntimeSafetyInput = {
      killSwitchActive: false,
      exchangeTruthAvailable: true,
      reconciliationDrift: true,
      marketFeedFreshnessMs: 10_000,
      userFeedFreshnessMs: 10_000,
      runtimePhase: "ready",
    };
    const r = evaluateRuntimeSafety(input);
    check(r.state === "blocked", "state is blocked");
    check(r.blockingReasons.includes("reconciliation_drift"), "blocking reason");
  }

  console.log("\n--- 4. Stale feeds produce degraded ---");
  {
    const input: RuntimeSafetyInput = {
      killSwitchActive: false,
      exchangeTruthAvailable: true,
      marketFeedFreshnessMs: 90_000,
      userFeedFreshnessMs: 50_000,
      marketFeedMaxStalenessMs: 60_000,
      userFeedMaxStalenessMs: 90_000,
      marketFeedBlockStalenessMs: 300_000,
      userFeedBlockStalenessMs: 300_000,
      runtimePhase: "ready",
    };
    const r = evaluateRuntimeSafety(input);
    check(r.state === "degraded", "state is degraded");
    check(r.warnings.some((w) => w.includes("market_feed_stale")), "market_feed_stale warning");
  }

  console.log("\n--- 5. Extreme stale feeds produce blocked ---");
  {
    const input: RuntimeSafetyInput = {
      killSwitchActive: false,
      exchangeTruthAvailable: true,
      marketFeedFreshnessMs: 400_000,
      userFeedFreshnessMs: 10_000,
      marketFeedMaxStalenessMs: 60_000,
      marketFeedBlockStalenessMs: 300_000,
      runtimePhase: "ready",
    };
    const r = evaluateRuntimeSafety(input);
    check(r.state === "blocked", "state is blocked");
    check(r.blockingReasons.includes("market_feed_extremely_stale"), "blocking reason");
  }

  console.log("\n--- 6. Runtime phase rebuilding produces blocked ---");
  {
    const input: RuntimeSafetyInput = {
      killSwitchActive: false,
      exchangeTruthAvailable: true,
      marketFeedFreshnessMs: 10_000,
      userFeedFreshnessMs: 10_000,
      runtimePhase: "rebuilding",
    };
    const r = evaluateRuntimeSafety(input);
    check(r.state === "blocked", "state is blocked");
    check(r.blockingReasons.includes("runtime_not_ready"), "blocking reason");
  }

  console.log("\n--- 7. Manual override works (dev) ---");
  {
    const input: RuntimeSafetyInput = {
      killSwitchActive: true,
      exchangeTruthAvailable: false,
      manualOverride: "normal",
    };
    const r = evaluateRuntimeSafety(input);
    check(r.state === "normal", "state is normal with manual override");
    check(r.warnings.includes("manual_override_active"), "warning");
    check(r.blockingReasons.length === 0, "no blocking reasons when override normal");
  }

  console.log("\n--- 8. All pass => normal ---");
  {
    const input: RuntimeSafetyInput = {
      killSwitchActive: false,
      exchangeTruthAvailable: true,
      marketFeedFreshnessMs: 10_000,
      userFeedFreshnessMs: 10_000,
      runtimePhase: "ready",
    };
    const r = evaluateRuntimeSafety(input);
    check(r.state === "normal", "state is normal");
    check(r.blockingReasons.length === 0, "no blocking reasons");
  }

  console.log("\n--- 9. Repeated runtime errors => blocked ---");
  {
    const input: RuntimeSafetyInput = {
      killSwitchActive: false,
      exchangeTruthAvailable: true,
      marketFeedFreshnessMs: 10_000,
      userFeedFreshnessMs: 10_000,
      runtimePhase: "ready",
      repeatedRuntimeErrors: 10,
      repeatedRuntimeErrorsThreshold: 5,
    };
    const r = evaluateRuntimeSafety(input);
    check(r.state === "blocked", "state is blocked");
    check(r.blockingReasons.includes("repeated_runtime_errors"), "blocking reason");
  }

  console.log("\nAll runtime safety evaluate tests passed.");
}

run();
