/**
 * Runtime reconciliation: compare runtime vs exchange, degraded reason, health exposure.
 *
 * Run with (from repo root):
 *   npx ts-node --project tsconfig.tests.json -r tsconfig-paths/register lib/runtime/__tests__/runtime-reconciliation-tests.ts
 */

import assert from "assert";
import { InMemoryOrderLifecycleStore } from "../order-manager/order-lifecycle-store";
import { compareRuntimeWithExchange } from "../reconciliation/runtime-reconciliation";
import { computeDegraded } from "../runtime-degraded";
import { createRuntimeHealth } from "../runtime-health";
import { DefaultRuntimeDiagnosticsCollector } from "../telemetry/runtime-diagnostics";
import { createInitialStreamConnectionState } from "../stream-connection-state";

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

  console.log("\n--- compareRuntimeWithExchange: local working order missing on exchange ---");
  {
    const store = new InMemoryOrderLifecycleStore();
    store.create({
      clientOrderId: "local-1",
      funderAddress: "0xfunder",
      assetId: "asset1",
      marketId: "market1",
      side: "BUY",
      price: 0.5,
      size: 10,
    });
    store.applyAck("local-1", "ex-1");

    const localOpen = store.getAll().filter((o) =>
      ["working", "partially_filled", "pending_cancel", "pending_submit"].includes(o.status)
    );
    const exchangeIds = new Set<string>([]);
    const { missingLocalOrders, missingExchangeOrders, staleWorkingOrders } = compareRuntimeWithExchange(
      exchangeIds,
      localOpen
    );
    check(missingLocalOrders.length === 0, "no missing local when exchange empty");
    check(missingExchangeOrders.length === 1, "one local order missing on exchange");
    check(staleWorkingOrders.length === 1, "one stale working order");
    check(missingExchangeOrders[0].clientOrderId === "local-1", "missing exchange order is local-1");
  }

  console.log("\n--- compareRuntimeWithExchange: exchange order missing locally ---");
  {
    const store = new InMemoryOrderLifecycleStore();
    const localOpen = store.getAll();
    const exchangeIds = new Set(["ex-a", "ex-b"]);
    const { missingLocalOrders, missingExchangeOrders, staleWorkingOrders } = compareRuntimeWithExchange(
      exchangeIds,
      localOpen
    );
    check(missingLocalOrders.length === 2, "two exchange orders missing locally");
    check(missingLocalOrders.includes("ex-a") && missingLocalOrders.includes("ex-b"), "missing local are ex-a, ex-b");
    check(missingExchangeOrders.length === 0, "no missing exchange when local empty");
    check(staleWorkingOrders.length === 0, "no stale working");
  }

  console.log("\n--- computeDegraded: runtime_reconciliation_repeated_failure ---");
  {
    const openState = {
      ...createInitialStreamConnectionState(),
      status: "open" as const,
      lastOpenAt: new Date(),
      lastMessageAt: new Date(),
      lastDataEventAt: new Date(),
    };
    const diag = new DefaultRuntimeDiagnosticsCollector();
    diag.recordRuntimeReconciliationRun();
    diag.recordRuntimeReconciliationFailure();
    diag.recordRuntimeReconciliationFailure();
    diag.recordRuntimeReconciliationFailure();
    const snap = diag.getSnapshot();
    const r = computeDegraded({
      marketConnection: openState,
      userConnection: openState,
      diagnostics: snap,
      schedulerBacklog: 0,
      staleAssetCount: 0,
      degradedAssetCount: 0,
      trackedAssetCount: 0,
      runtimeReconciliationFailureThreshold: 3,
    });
    check(r.degraded === true, "degraded when runtime reconciliation failures >= 3");
    check(
      r.reasons.includes("runtime_reconciliation_repeated_failure"),
      "reason runtime_reconciliation_repeated_failure"
    );
  }

  console.log("\n--- computeDegraded: not degraded when runtime reconcile failures below threshold ---");
  {
    const openState = {
      ...createInitialStreamConnectionState(),
      status: "open" as const,
      lastOpenAt: new Date(),
      lastMessageAt: new Date(),
      lastDataEventAt: new Date(),
    };
    const diag = new DefaultRuntimeDiagnosticsCollector();
    diag.recordRuntimeReconciliationRun();
    diag.recordRuntimeReconciliationFailure();
    diag.recordRuntimeReconciliationFailure();
    const r = computeDegraded({
      marketConnection: openState,
      userConnection: openState,
      diagnostics: diag.getSnapshot(),
      schedulerBacklog: 0,
      staleAssetCount: 0,
      degradedAssetCount: 0,
      trackedAssetCount: 0,
      runtimeReconciliationFailureThreshold: 3,
    });
    check(r.degraded === false || !r.reasons.includes("runtime_reconciliation_repeated_failure"), "not degraded when failures < 3");
  }

  console.log("\n--- successful reconcile: no repeated_failure reason when no failures ---");
  {
    const openState = {
      ...createInitialStreamConnectionState(),
      status: "open" as const,
      lastOpenAt: new Date(),
      lastMessageAt: new Date(),
      lastDataEventAt: new Date(),
    };
    const diag = new DefaultRuntimeDiagnosticsCollector();
    diag.recordRuntimeReconciliationRun();
    diag.recordRuntimeReconciliationRun();
    const r = computeDegraded({
      marketConnection: openState,
      userConnection: openState,
      diagnostics: diag.getSnapshot(),
      schedulerBacklog: 0,
      staleAssetCount: 0,
      degradedAssetCount: 0,
      trackedAssetCount: 0,
      runtimeReconciliationFailureThreshold: 3,
    });
    check(!r.reasons.includes("runtime_reconciliation_repeated_failure"), "successful reconcile does not add repeated_failure");
  }

  console.log("\n--- Health: reconciliation freshness and drift ---");
  {
    const health = createRuntimeHealth({
      reconciliation: {
        lastAt: new Date().toISOString(),
        status: "ok",
        freshness: "ok",
        driftDetected: true,
        reconcileDurationMs: 120,
      },
    });
    check(health.reconciliation != null, "reconciliation present");
    check(health.reconciliation!.driftDetected === true, "drift surfaces in health");
    check(health.reconciliation!.freshness === "ok", "freshness ok when recent");
    check(health.reconciliation!.reconcileDurationMs === 120, "duration in health");
  }

  console.log("\n--- Diagnostics: reconciliation run and drift counters ---");
  {
    const diag = new DefaultRuntimeDiagnosticsCollector();
    check(diag.getSnapshot().runtimeReconciliationRuns === 0, "initial runs 0");
    check(diag.getSnapshot().driftDetectionsCount === 0, "initial drift 0");
    diag.recordRuntimeReconciliationRun();
    diag.recordDriftDetected();
    diag.recordDriftDetected();
    check(diag.getSnapshot().runtimeReconciliationRuns === 1, "runs 1 after record");
    check(diag.getSnapshot().lastRuntimeReconciliationStatus === "ok", "last status ok");
    check(diag.getSnapshot().driftDetectionsCount === 2, "drift 2 after two records");
    diag.recordRuntimeReconciliationFailure();
    check(diag.getSnapshot().runtimeReconciliationFailures === 1, "failures 1");
    check(diag.getSnapshot().lastRuntimeReconciliationStatus === "failure", "last status failure");
  }

  console.log("\n--- Result ---");
  console.log(`Passed: ${passed}, Failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
