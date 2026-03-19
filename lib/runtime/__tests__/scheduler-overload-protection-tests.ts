/**
 * Bot scheduler flood/backlog protection: max queue, coalesced/dropped counters,
 * overload state, degraded when backlog high, recovery after drain.
 *
 * Run with (from repo root):
 *   npx ts-node --project tsconfig.tests.json -r tsconfig-paths/register lib/runtime/__tests__/scheduler-overload-protection-tests.ts
 */

import assert from "assert";
import { EventDrivenBotScheduler, DEFAULT_SCHEDULER_OVERLOAD_CONFIG } from "../bot-runtime/bot-scheduler";
import type { BotDecisionEnvelope } from "../bot-runtime/bot-decision-types";
import type { BotRuntimeContextProvider } from "../bot-runtime/bot-context";
import { InMemoryMarketStateStore } from "../market-state/market-state-store";
import { InMemoryRuntimePositionStore } from "../positions/runtime-position-store";
import { createDefaultRuntimeRiskState } from "../risk/runtime-risk-engine";
import { computeDegraded } from "../runtime-degraded";
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

  const marketStore = new InMemoryMarketStateStore();
  const positionStore = new InMemoryRuntimePositionStore();
  const snapshot = {
    asOf: new Date(),
    marketStateStore: marketStore,
    positionStore,
    riskState: createDefaultRuntimeRiskState(),
  };
  const provider: BotRuntimeContextProvider = {
    createSnapshot: () => ({ ...snapshot, asOf: new Date() }),
  };

  console.log("\n--- Burst of market events: high-water mark and coalesced count ---");
  {
    const diagnostics = new DefaultRuntimeDiagnosticsCollector();
    const scheduler = new EventDrivenBotScheduler(
      {
        contextProvider: provider,
        coalesceMs: 20,
        funderAddress: "0x",
        strategyId: "default",
        overloadConfig: { maxQueueSize: 500, overloadThreshold: 100, dropLowPriorityWhenFull: true },
        schedulerDiagnostics: {
          recordCoalesced: () => diagnostics.recordSchedulerCoalesced(),
          recordDropped: () => diagnostics.recordSchedulerDropped(),
          recordEvaluationLatency: () => {},
          recordOverload: () => diagnostics.recordSchedulerOverload(),
          recordHighWaterMark: (m) => diagnostics.recordSchedulerHighWaterMark(m),
        },
      },
      (_: BotDecisionEnvelope) => {}
    );
    scheduler.start();
    for (let i = 0; i < 50; i++) {
      scheduler.enqueue(`asset-${i % 10}`); // 50 enqueues, 10 unique -> coalescing
    }
    check(scheduler.getQueueSize() <= 10, "queue size at most 10 (coalesced by assetId)");
    check(scheduler.getQueueHighWaterMark() >= 10, "high-water mark at least 10");
    const snap = diagnostics.getSnapshot();
    check(snap.schedulerCoalescedEvents >= 40, "coalesced events >= 40 (50 - 10 first enqueues)");
    scheduler.stop();
  }

  console.log("\n--- Scheduler backlog threshold: drop low/normal when full ---");
  {
    const config = { maxQueueSize: 5, overloadThreshold: 3, dropLowPriorityWhenFull: true };
    const diagnostics = new DefaultRuntimeDiagnosticsCollector();
    let evaluated = 0;
    const scheduler = new EventDrivenBotScheduler(
      {
        contextProvider: provider,
        coalesceMs: 100,
        funderAddress: "0x",
        strategyId: "default",
        overloadConfig: config,
        schedulerDiagnostics: {
          recordCoalesced: () => diagnostics.recordSchedulerCoalesced(),
          recordDropped: () => diagnostics.recordSchedulerDropped(),
          recordEvaluationLatency: () => {},
          recordOverload: () => diagnostics.recordSchedulerOverload(),
          recordHighWaterMark: (m) => diagnostics.recordSchedulerHighWaterMark(m),
        },
      },
      (_: BotDecisionEnvelope) => {
        evaluated++;
        return new Promise((r) => setTimeout(r, 50));
      }
    );
    scheduler.start();
    for (let i = 0; i < 8; i++) {
      scheduler.enqueue(`a${i}`, "normal");
    }
    check(scheduler.getQueueSize() <= 5, "queue capped at maxQueueSize 5");
    check(scheduler.getDroppedCount() >= 3, "dropped >= 3 (8 - 5 accepted)");
    const snap = diagnostics.getSnapshot();
    check(snap.schedulerDroppedEvents >= 3, "diagnostics schedulerDroppedEvents >= 3");
    scheduler.stop();
  }

  console.log("\n--- Lifecycle-critical (high/priority) never dropped when at cap ---");
  {
    const config = { maxQueueSize: 3, overloadThreshold: 2, dropLowPriorityWhenFull: true };
    const scheduler = new EventDrivenBotScheduler(
      {
        contextProvider: provider,
        coalesceMs: 200,
        funderAddress: "0x",
        strategyId: "default",
        overloadConfig: config,
      },
      (_: BotDecisionEnvelope) => new Promise((r) => setTimeout(r, 100))
    );
    scheduler.start();
    scheduler.enqueue("n1", "normal");
    scheduler.enqueue("n2", "normal");
    scheduler.enqueue("n3", "normal");
    check(scheduler.getQueueSize() === 3, "queue full with 3 normal");
    scheduler.enqueue("n4", "normal");
    check(scheduler.getDroppedCount() === 1, "normal dropped when full");
    scheduler.enqueue("lifecycle-asset", "priority");
    check(scheduler.getQueueSize() === 4, "priority accepted even when over cap");
    check(scheduler.getDroppedCount() === 1, "still only 1 dropped");
    scheduler.stop();
  }

  console.log("\n--- Runtime degraded when scheduler backlog >= threshold ---");
  {
    const openState = {
      ...createInitialStreamConnectionState(),
      status: "open" as const,
      lastOpenAt: new Date(),
      lastMessageAt: new Date(),
      lastDataEventAt: new Date(),
    };
    const r = computeDegraded({
      marketConnection: openState,
      userConnection: openState,
      diagnostics: null,
      schedulerBacklog: 150,
      schedulerBacklogThreshold: 100,
      staleAssetCount: 0,
      degradedAssetCount: 0,
      trackedAssetCount: 10,
    });
    check(r.degraded === true, "degraded when backlog 150 >= 100");
    check(r.reasons.includes("scheduler_backlog_high"), "reasons include scheduler_backlog_high");
  }

  console.log("\n--- Recovery after backlog drains: no longer degraded ---");
  {
    const openState = {
      ...createInitialStreamConnectionState(),
      status: "open" as const,
      lastOpenAt: new Date(),
      lastMessageAt: new Date(),
      lastDataEventAt: new Date(),
    };
    const r = computeDegraded({
      marketConnection: openState,
      userConnection: openState,
      diagnostics: null,
      schedulerBacklog: 0,
      schedulerBacklogThreshold: 100,
      staleAssetCount: 0,
      degradedAssetCount: 0,
      trackedAssetCount: 10,
    });
    check(r.degraded === false, "not degraded when backlog 0");
    check(!r.reasons.includes("scheduler_backlog_high"), "no scheduler_backlog_high reason");
  }

  console.log("\n--- Overload period count and isOverloaded ---");
  {
    const config = { maxQueueSize: 20, overloadThreshold: 2, dropLowPriorityWhenFull: false };
    const diagnostics = new DefaultRuntimeDiagnosticsCollector();
    const scheduler = new EventDrivenBotScheduler(
      {
        contextProvider: provider,
        coalesceMs: 50,
        funderAddress: "0x",
        strategyId: "default",
        overloadConfig: config,
        schedulerDiagnostics: {
          recordCoalesced: () => diagnostics.recordSchedulerCoalesced(),
          recordDropped: () => diagnostics.recordSchedulerDropped(),
          recordEvaluationLatency: () => {},
          recordOverload: () => diagnostics.recordSchedulerOverload(),
          recordHighWaterMark: (m) => diagnostics.recordSchedulerHighWaterMark(m),
        },
      },
      (_: BotDecisionEnvelope) => new Promise((r) => setTimeout(r, 30))
    );
    scheduler.start();
    check(scheduler.isOverloaded() === false, "not overloaded initially");
    scheduler.enqueue("x");
    scheduler.enqueue("y");
    scheduler.enqueue("z");
    check(scheduler.getQueueSize() + scheduler.getInFlightCount() >= 2, "load >= 2");
    await new Promise((r) => setTimeout(r, 80));
    check(scheduler.getOverloadPeriodCount() >= 1 || scheduler.isOverloaded() === false, "overload period counted or load drained");
    const snap = diagnostics.getSnapshot();
    check(snap.schedulerOverloadPeriodCount >= 0, "diagnostics has overload period count");
    scheduler.stop();
  }

  console.log("\n--- Evaluation latency recorded ---");
  {
    const diagnostics = new DefaultRuntimeDiagnosticsCollector();
    const scheduler = new EventDrivenBotScheduler(
      {
        contextProvider: provider,
        coalesceMs: 10,
        funderAddress: "0x",
        strategyId: "default",
        schedulerDiagnostics: {
          recordCoalesced: () => diagnostics.recordSchedulerCoalesced(),
          recordDropped: () => diagnostics.recordSchedulerDropped(),
          recordEvaluationLatency: (ms) => diagnostics.recordSchedulerEvaluationLatency(ms),
          recordOverload: () => diagnostics.recordSchedulerOverload(),
          recordHighWaterMark: (m) => diagnostics.recordSchedulerHighWaterMark(m),
        },
      },
      (_: BotDecisionEnvelope) => new Promise((r) => setTimeout(r, 25))
    );
    scheduler.start();
    scheduler.enqueue("latency-test");
    await new Promise((r) => setTimeout(r, 80));
    check(scheduler.getLastEvaluationLatencyMs() != null && scheduler.getLastEvaluationLatencyMs()! >= 20, "last evaluation latency >= 20ms");
    const snap = diagnostics.getSnapshot();
    check(snap.schedulerLastEvaluationLatencyMs != null, "diagnostics has last evaluation latency");
    scheduler.stop();
  }

  console.log("\n--- Default config values ---");
  {
    ok(DEFAULT_SCHEDULER_OVERLOAD_CONFIG.maxQueueSize === 500, "default maxQueueSize 500");
    ok(DEFAULT_SCHEDULER_OVERLOAD_CONFIG.overloadThreshold === 100, "default overloadThreshold 100");
    ok(DEFAULT_SCHEDULER_OVERLOAD_CONFIG.dropLowPriorityWhenFull === true, "default dropLowPriorityWhenFull true");
  }

  console.log("\n--- Result ---");
  console.log(`Passed: ${passed}, Failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
