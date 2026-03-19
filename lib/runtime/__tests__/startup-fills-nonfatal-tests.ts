/**
 * Startup fills snapshot non-fatal and health dataFlowHealthy when streams closed.
 * Tests buildOperatorHealth semantics: dataFlowHealthy/bothHealthy false when stream not open.
 * (Startup flow: stream-runtime wraps fills snapshot in try/catch so startup continues; verified by implementation.)
 *
 * Run with (from repo root):
 *   npx ts-node --project tsconfig.tests.json -r tsconfig-paths/register lib/runtime/__tests__/startup-fills-nonfatal-tests.ts
 */

import assert from "assert";
import { buildOperatorHealth } from "../runtime-health";
import { createInitialStreamConnectionState } from "../stream-connection-state";
import { getTradingExecutionPolicy } from "../trading-execution-policy";

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

  const policy = getTradingExecutionPolicy();

  console.log("\n--- dataFreshness.bothHealthy false when market stream closed (marketDataHealthy false) ---");
  {
    const op = buildOperatorHealth({
      marketConnection: { ...createInitialStreamConnectionState(), status: "closed" },
      userConnection: { ...createInitialStreamConnectionState(), status: "open", lastDataEventAt: new Date() },
      marketDataHealthy: false,
      userDataHealthy: true,
      operationalReadiness: false,
      runtimePhase: "ready",
      globalAutomationEnabled: false,
      watchdogReasons: [],
      reconciliationLastAt: null,
      reconciliationStatus: null,
      reconciliationDriftDetected: false,
      reconciliationDurationMs: 0,
      executionPolicy: policy,
    });
    check(op.dataFreshness.market.dataFlowHealthy === false, "market dataFlowHealthy false when closed");
    check(op.dataFreshness.bothHealthy === false, "dataFreshness.bothHealthy false when market closed");
  }

  console.log("\n--- dataFreshness.bothHealthy false when user stream closed (userDataHealthy false) ---");
  {
    const op = buildOperatorHealth({
      marketConnection: { ...createInitialStreamConnectionState(), status: "open", lastDataEventAt: new Date() },
      userConnection: { ...createInitialStreamConnectionState(), status: "closed" },
      marketDataHealthy: true,
      userDataHealthy: false,
      operationalReadiness: false,
      runtimePhase: "ready",
      globalAutomationEnabled: false,
      watchdogReasons: [],
      reconciliationLastAt: null,
      reconciliationStatus: null,
      reconciliationDriftDetected: false,
      reconciliationDurationMs: 0,
      executionPolicy: policy,
    });
    check(op.dataFreshness.user.dataFlowHealthy === false, "user dataFlowHealthy false when closed");
    check(op.dataFreshness.bothHealthy === false, "dataFreshness.bothHealthy false when user closed");
  }

  console.log("\n--- dataFreshness.bothHealthy false when both connections null (streams not started) ---");
  {
    const op = buildOperatorHealth({
      marketConnection: null,
      userConnection: null,
      marketDataHealthy: false,
      userDataHealthy: false,
      operationalReadiness: false,
      runtimePhase: "ready",
      globalAutomationEnabled: false,
      watchdogReasons: [],
      reconciliationLastAt: null,
      reconciliationStatus: null,
      reconciliationDriftDetected: false,
      reconciliationDurationMs: 0,
      executionPolicy: policy,
    });
    check(op.dataFreshness.bothHealthy === false, "bothHealthy false when both null");
  }

  console.log("\n--- Result ---");
  console.log(`Passed: ${passed}, Failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
