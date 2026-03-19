/**
 * Operator health payload: connection, heartbeat, dataFreshness, reconciliation, readiness, killSwitch.
 *
 * Run with (from repo root):
 *   npx ts-node --project tsconfig.tests.json -r tsconfig-paths/register lib/runtime/__tests__/operator-health-tests.ts
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

  console.log("\n--- buildOperatorHealth shape: connection, heartbeat, dataFreshness, reconciliation, readiness, killSwitch ---");
  {
    const closed = createInitialStreamConnectionState();
    const op = buildOperatorHealth({
      marketConnection: closed,
      userConnection: closed,
      marketDataHealthy: false,
      userDataHealthy: false,
      operationalReadiness: false,
      runtimePhase: "stopped",
      globalAutomationEnabled: false,
      watchdogReasons: [],
      reconciliationLastAt: null,
      reconciliationStatus: null,
      reconciliationDriftDetected: false,
      reconciliationDurationMs: 0,
      executionPolicy: policy,
    });
    check(op.connection.market.socketStatus === "closed", "market socketStatus closed");
    check(op.connection.user.socketStatus === "closed", "user socketStatus closed");
    check(op.connection.bothConnected === false, "bothConnected false");
    check(op.heartbeat.market.lastHeartbeatAt === null, "market lastHeartbeatAt null");
    check(op.heartbeat.bothHealthy === false, "heartbeat bothHealthy false");
    check(op.dataFreshness.market.lastDataEventAt === null, "market lastDataEventAt null");
    check(op.dataFreshness.bothHealthy === false, "dataFreshness bothHealthy false");
    check(op.reconciliation.lastRunAt === null, "reconciliation lastRunAt null");
    check(op.reconciliation.healthy === false, "reconciliation healthy false");
    check(op.readiness.runtimePhase === "stopped", "readiness runtimePhase stopped");
    check(op.readiness.automationPermitted === false, "automationPermitted false");
    check(op.readiness.safeToAutomate === false, "safeToAutomate false");
    check(op.killSwitch.tripped === true, "killSwitch tripped when not enabled");
  }

  console.log("\n--- safeToAutomate true only when operationalReadiness, globalAutomationEnabled, reconciliationHealthy ---");
  {
    const openState = {
      ...createInitialStreamConnectionState(),
      status: "open" as const,
      lastOpenAt: new Date(),
      lastMessageAt: new Date(),
      lastHeartbeatAt: new Date(),
      lastDataEventAt: new Date(),
    };
    const opReady = buildOperatorHealth({
      marketConnection: openState,
      userConnection: openState,
      marketDataHealthy: true,
      userDataHealthy: true,
      operationalReadiness: true,
      runtimePhase: "ready",
      globalAutomationEnabled: true,
      watchdogReasons: [],
      reconciliationLastAt: new Date().toISOString(),
      reconciliationStatus: "ok",
      reconciliationDriftDetected: false,
      reconciliationDurationMs: 50,
      executionPolicy: policy,
    });
    check(opReady.readiness.safeToAutomate === true, "safeToAutomate true when all conditions met");
    check(opReady.reconciliation.healthy === true, "reconciliation healthy when recent success");
  }

  console.log("\n--- dataFlowHealthy / bothHealthy false when stream not open ---");
  {
    const closedMarket = { ...createInitialStreamConnectionState(), status: "closed" as const };
    const op = buildOperatorHealth({
      marketConnection: closedMarket,
      userConnection: { ...createInitialStreamConnectionState(), status: "open" as const, lastDataEventAt: new Date() },
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
    check(op.dataFreshness.market.dataFlowHealthy === false, "market dataFlowHealthy false when socket not open");
    check(op.dataFreshness.bothHealthy === false, "dataFreshness.bothHealthy false when market stream closed");
  }

  console.log("\n--- safeToAutomate false when reconciliation stale ---");
  {
    const openState = {
      ...createInitialStreamConnectionState(),
      status: "open" as const,
      lastOpenAt: new Date(),
      lastMessageAt: new Date(),
      lastHeartbeatAt: new Date(),
      lastDataEventAt: new Date(),
    };
    const opStaleRec = buildOperatorHealth({
      marketConnection: openState,
      userConnection: openState,
      marketDataHealthy: true,
      userDataHealthy: true,
      operationalReadiness: true,
      runtimePhase: "ready",
      globalAutomationEnabled: true,
      watchdogReasons: [],
      reconciliationLastAt: null,
      reconciliationStatus: "failure",
      reconciliationDriftDetected: false,
      reconciliationDurationMs: 0,
      executionPolicy: policy,
    });
    check(opStaleRec.readiness.safeToAutomate === false, "safeToAutomate false when reconciliation not healthy");
  }

  console.log("\n--- Result ---");
  console.log(`Passed: ${passed}, Failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
