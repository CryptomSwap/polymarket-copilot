/**
 * Runtime readiness, stream state, degraded rules, scheduler backlog, reconciliation failure.
 *
 * Run with (from repo root):
 *   npx ts-node --project tsconfig.tests.json -r tsconfig-paths/register lib/runtime/__tests__/runtime-readiness-degraded-tests.ts
 */

import assert from "assert";
import {
  createInitialStreamConnectionState,
  isStreamOpen,
  type StreamConnectionState,
} from "../stream-connection-state";
import { computeDegraded } from "../runtime-degraded";
import { createRuntimeHealth, DEFAULT_RUNTIME_HEALTH } from "../runtime-health";
import { EventDrivenBotScheduler } from "../bot-runtime/bot-scheduler";
import type { BotRuntimeContextProvider, BotRuntimeContextSnapshot } from "../bot-runtime/bot-context";
import type { BotDecisionEnvelope } from "../bot-runtime/bot-decision-types";
import { createDefaultRuntimeRiskState } from "../risk/runtime-risk-engine";
import { InMemoryMarketStateStore } from "../market-state/market-state-store";
import { InMemoryRuntimePositionStore } from "../positions/runtime-position-store";
import { DefaultRuntimeDiagnosticsCollector } from "../telemetry/runtime-diagnostics";

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

  console.log("\n--- Stream connection state ---");
  {
    const initial = createInitialStreamConnectionState();
    check(initial.status === "closed", "initial status closed");
    check(initial.lastOpenAt === null && initial.lastMessageAt === null, "initial timestamps null");
    check(initial.reconnectAttempts === 0, "initial reconnectAttempts 0");
    check(!isStreamOpen(initial), "isStreamOpen(closed) false");

    const openState: StreamConnectionState = {
      ...initial,
      status: "open",
      lastOpenAt: new Date(),
      lastMessageAt: new Date(),
    };
    check(isStreamOpen(openState), "isStreamOpen(open) true");
    check(!isStreamOpen({ ...initial, status: "connecting" }), "isStreamOpen(connecting) false");
    check(!isStreamOpen({ ...initial, status: "reconnecting" }), "isStreamOpen(reconnecting) false");
  }

  console.log("\n--- computeDegraded rules ---");
  {
    const openState: StreamConnectionState = {
      ...createInitialStreamConnectionState(),
      status: "open",
      lastOpenAt: new Date(),
      lastMessageAt: new Date(),
    };
    const closedState: StreamConnectionState = {
      ...createInitialStreamConnectionState(),
      status: "closed",
    };

    const r1 = computeDegraded({
      marketConnection: closedState,
      userConnection: openState,
      diagnostics: null,
      schedulerBacklog: 0,
      staleAssetCount: 0,
      degradedAssetCount: 0,
      trackedAssetCount: 10,
    });
    check(r1.degraded === true, "degraded when market not open");
    check(r1.reasons.includes("market_ws_not_open"), "reason market_ws_not_open");

    const r2 = computeDegraded({
      marketConnection: openState,
      userConnection: closedState,
      diagnostics: null,
      schedulerBacklog: 0,
      staleAssetCount: 0,
      degradedAssetCount: 0,
      trackedAssetCount: 10,
    });
    check(r2.degraded === true, "degraded when user not open");
    check(r2.reasons.includes("user_ws_not_open"), "reason user_ws_not_open");

    const diagForReconcile = new DefaultRuntimeDiagnosticsCollector();
    for (let i = 0; i < 5; i++) diagForReconcile.recordReconcileFailure("test", undefined);
    const r3 = computeDegraded({
      marketConnection: openState,
      userConnection: openState,
      diagnostics: diagForReconcile.getSnapshot(),
      reconcileFailureThreshold: 3,
      schedulerBacklog: 0,
      staleAssetCount: 0,
      degradedAssetCount: 0,
      trackedAssetCount: 10,
    });
    check(r3.degraded === true, "degraded when reconcile failures above threshold");
    check(r3.reasons.includes("reconcile_failures"), "reason reconcile_failures");

    const r4 = computeDegraded({
      marketConnection: openState,
      userConnection: openState,
      diagnostics: null,
      schedulerBacklog: 150,
      schedulerBacklogThreshold: 100,
      staleAssetCount: 0,
      degradedAssetCount: 0,
      trackedAssetCount: 10,
    });
    check(r4.degraded === true, "degraded when scheduler backlog above threshold");
    check(r4.reasons.includes("scheduler_backlog_high"), "reason scheduler_backlog_high");

    const r5 = computeDegraded({
      marketConnection: openState,
      userConnection: openState,
      diagnostics: null,
      schedulerBacklog: 0,
      staleAssetCount: 6,
      degradedAssetCount: 0,
      trackedAssetCount: 10,
      staleRatioThreshold: 0.5,
    });
    check(r5.degraded === true, "degraded when stale asset ratio high");
    check(r5.reasons.includes("stale_asset_ratio_high"), "reason stale_asset_ratio_high");

    const openStateWithData: StreamConnectionState = {
      ...createInitialStreamConnectionState(),
      status: "open",
      lastOpenAt: new Date(),
      lastMessageAt: new Date(),
      lastDataEventAt: new Date(),
    };
    const r6 = computeDegraded({
      marketConnection: openStateWithData,
      userConnection: openStateWithData,
      diagnostics: null,
      schedulerBacklog: 0,
      staleAssetCount: 0,
      degradedAssetCount: 0,
      trackedAssetCount: 10,
    });
    check(r6.degraded === false, "not degraded when all healthy (real data flowing)");
    check(r6.reasons.length === 0, "no reasons when healthy");
  }

  console.log("\n--- Scheduler backlog (getQueueSize / getInFlightCount) ---");
  {
    const marketStore = new InMemoryMarketStateStore();
    const positionStore = new InMemoryRuntimePositionStore();
    const snapshot: BotRuntimeContextSnapshot = {
      asOf: new Date(),
      marketStateStore: marketStore,
      positionStore,
      riskState: createDefaultRuntimeRiskState(),
    };
    const provider: BotRuntimeContextProvider = {
      createSnapshot: () => ({ ...snapshot, asOf: new Date() }),
    };
    let evaluated = 0;
    const scheduler = new EventDrivenBotScheduler(
      {
        contextProvider: provider,
        coalesceMs: 50,
        funderAddress: "0x",
        strategyId: "default",
      },
      (_: BotDecisionEnvelope) => {
        evaluated++;
      }
    );
    check(scheduler.getQueueSize() === 0, "initial queue size 0");
    check(scheduler.getInFlightCount() === 0, "initial inFlight 0");
    scheduler.start();
    scheduler.enqueue("a1");
    scheduler.enqueue("a2");
    scheduler.enqueue("a1"); // coalesced, same asset
    check(scheduler.getQueueSize() >= 1 && scheduler.getQueueSize() <= 2, "queue size after enqueue");
    await new Promise((r) => setTimeout(r, 100));
    check(scheduler.getInFlightCount() === 0, "inFlight 0 after drain");
    check(scheduler.getQueueSize() === 0, "queue size 0 after drain");
    check(evaluated >= 1, "at least one evaluation");
    scheduler.stop();
    check(scheduler.getQueueSize() === 0, "queue 0 after stop");
  }

  console.log("\n--- Diagnostics recordReconcileFailure ---");
  {
    const diag = new DefaultRuntimeDiagnosticsCollector();
    const snap0 = diag.getSnapshot();
    check(snap0.reconcileFailureCount === 0, "initial reconcileFailureCount 0");
    check(snap0.lastReconcileFailureAt === null, "initial lastReconcileFailureAt null");

    diag.recordReconcileFailure("Test error", "intent-1");
    const snap1 = diag.getSnapshot();
    check(snap1.reconcileFailureCount === 1, "reconcileFailureCount 1 after record");
    check(snap1.lastReconcileFailureReason === "Test error", "lastReconcileFailureReason set");
    check(snap1.lastReconcileFailureIntentId === "intent-1", "lastReconcileFailureIntentId set");
    check(snap1.lastReconcileFailureAt !== null, "lastReconcileFailureAt set");

    diag.recordReconcileFailure("Second", null);
    const snap2 = diag.getSnapshot();
    check(snap2.reconcileFailureCount === 2, "reconcileFailureCount 2");
    check(snap2.lastReconcileFailureIntentId === null, "intentId null when not provided");
  }

  console.log("\n--- Health shape: lifecycleStatus, operationalReadiness, degradedReasons ---");
  {
    ok(DEFAULT_RUNTIME_HEALTH.lifecycleStatus === "stopped", "default lifecycleStatus stopped");
    ok(DEFAULT_RUNTIME_HEALTH.streams.operationalReadiness === false, "default operationalReadiness false");
    ok(Array.isArray(DEFAULT_RUNTIME_HEALTH.degradedReasons) && DEFAULT_RUNTIME_HEALTH.degradedReasons.length === 0, "default degradedReasons []");
    ok(DEFAULT_RUNTIME_HEALTH.streams.marketConnection === null, "default marketConnection null");
    ok(DEFAULT_RUNTIME_HEALTH.streams.userConnection === null, "default userConnection null");

    const health = createRuntimeHealth({
      status: "degraded",
      lifecycleStatus: "degraded",
      degradedReasons: ["market_ws_not_open", "scheduler_backlog_high"],
      streams: {
        ...DEFAULT_RUNTIME_HEALTH.streams,
        operationalReadiness: false,
        marketConnection: { ...createInitialStreamConnectionState(), status: "closed" },
        userConnection: { ...createInitialStreamConnectionState(), status: "open", lastOpenAt: new Date(), lastMessageAt: new Date() },
      },
      counts: { ...DEFAULT_RUNTIME_HEALTH.counts, schedulerBacklog: 42 },
    });
    ok(health.status === "degraded", "health status degraded");
    ok(health.degradedReasons.length === 2 && health.degradedReasons.includes("market_ws_not_open"), "degradedReasons set");
    ok(health.counts.schedulerBacklog === 42, "schedulerBacklog from input");
    ok(health.streams.marketConnection?.status === "closed", "marketConnection status closed");
    ok(health.streams.userConnection?.status === "open", "userConnection status open");
  }

  console.log("\n--- Summary ---");
  console.log("Passed:", passed, "Failed:", failed);
  if (failed > 0) process.exit(1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
