/**
 * Runtime latency monitor: latency samples, integrity counters, degraded reasons.
 *
 * Run with (from repo root):
 *   npx ts-node --project tsconfig.tests.json -r tsconfig-paths/register lib/runtime/telemetry/__tests__/runtime-latency-monitor-tests.ts
 */

import assert from "assert";
import {
  RuntimeLatencyMonitor,
  LATENCY_DEGRADED_REASONS,
} from "../runtime-latency-monitor";

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

  console.log("\n--- Latency samples recorded ---");
  {
    const m = new RuntimeLatencyMonitor({ rollingSize: 10 });
    m.recordMarketStreamToEngineMs(5);
    m.recordMarketStreamToEngineMs(15);
    m.recordMarketStreamToEngineMs(25);
    const snap = m.getSnapshot();
    check(snap.latency.marketStreamToEngine.lastMs === 25, "last ms");
    check(snap.latency.marketStreamToEngine.sampleCount === 3, "sample count");
    check(snap.latency.marketStreamToEngine.p50Ms != null, "p50 present");
    check(snap.latency.marketStreamToEngine.p95Ms != null, "p95 present");
    check(snap.latency.marketStreamToEngine.maxRecentMs === 25, "max recent");
  }

  console.log("\n--- Malformed payload increments counter ---");
  {
    const m = new RuntimeLatencyMonitor();
    check(m.getSnapshot().integrity.malformedMarketPayloads === 0, "initial 0");
    m.recordMalformedMarketPayload();
    m.recordMalformedMarketPayload();
    check(m.getSnapshot().integrity.malformedMarketPayloads === 2, "count 2");
    m.recordMalformedUserPayload();
    check(m.getSnapshot().integrity.malformedUserPayloads === 1, "user malformed 1");
  }

  console.log("\n--- Severe latency adds degraded reason ---");
  {
    const m = new RuntimeLatencyMonitor({
      marketLatencyThresholdMs: 100,
      userLatencyThresholdMs: 100,
      reconcileLatencyThresholdMs: 200,
    });
    check(m.getDegradedReasons().length === 0, "no reasons initially");
    m.recordMarketStreamToEngineMs(50);
    check(m.getDegradedReasons().length === 0, "below threshold no reason");
    m.recordMarketStreamToEngineMs(150);
    check(
      m.getDegradedReasons().includes(LATENCY_DEGRADED_REASONS.MARKET_PROCESSING_LATENCY_HIGH),
      "market_processing_latency_high"
    );
    m.recordUserStreamToEngineMs(200);
    check(
      m.getDegradedReasons().includes(LATENCY_DEGRADED_REASONS.USER_PROCESSING_LATENCY_HIGH),
      "user_processing_latency_high"
    );
    m.recordReconcileDurationMs(300);
    check(
      m.getDegradedReasons().includes(LATENCY_DEGRADED_REASONS.RECONCILE_LATENCY_HIGH),
      "reconcile_latency_high"
    );
  }

  console.log("\n--- Malformed rate high adds degraded reason ---");
  {
    const m = new RuntimeLatencyMonitor({
      malformedRateThreshold: 2,
      rateWindowMs: 60_000,
    });
    m.recordMalformedMarketPayload();
    m.recordMalformedUserPayload();
    check(
      m.getDegradedReasons().includes(LATENCY_DEGRADED_REASONS.MALFORMED_PAYLOAD_RATE_HIGH),
      "malformed_payload_rate_high"
    );
  }

  console.log("\n--- Out-of-order rate high adds degraded reason ---");
  {
    const m = new RuntimeLatencyMonitor({
      outOfOrderRateThreshold: 2,
      rateWindowMs: 60_000,
    });
    m.recordOutOfOrderFill();
    m.recordOutOfOrderFill();
    check(
      m.getDegradedReasons().includes(LATENCY_DEGRADED_REASONS.OUT_OF_ORDER_EVENT_RATE_HIGH),
      "out_of_order_event_rate_high"
    );
  }

  console.log("\n--- Snapshot includes latency summary and integrity ---");
  {
    const m = new RuntimeLatencyMonitor();
    m.recordBotEvaluationMs(3);
    m.recordGuardrailEvaluationMs(1);
    m.recordUnmatchedExchangeOrderId();
    m.recordDuplicateLifecycleEvent();
    m.recordDroppedSchedulerEvent();
    m.recordCoalescedSchedulerEvent();
    m.recordStreamSilencePeriod();
    const snap = m.getSnapshot();
    check(snap.latency.botEvaluation.lastMs === 3, "bot eval last");
    check(snap.latency.guardrailEvaluation.lastMs === 1, "guardrail last");
    check(snap.integrity.unmatchedExchangeOrderIds === 1, "unmatched count");
    check(snap.integrity.duplicateLifecycleEvents === 1, "duplicate count");
    check(snap.integrity.droppedSchedulerEvents === 1, "dropped count");
    check(snap.integrity.coalescedSchedulerEvents === 1, "coalesced count");
    check(snap.integrity.streamSilencePeriods === 1, "silence periods");
  }

  console.log("\n--- Integrity counters visible after simulated bad input ---");
  {
    const m = new RuntimeLatencyMonitor();
    m.recordMalformedMarketPayload();
    m.recordMalformedUserPayload();
    m.recordOutOfOrderFill();
    m.recordUnmatchedExchangeOrderId();
    m.recordDuplicateLifecycleEvent();
    const snap = m.getSnapshot();
    check(snap.integrity.malformedMarketPayloads === 1, "malformed market");
    check(snap.integrity.malformedUserPayloads === 1, "malformed user");
    check(snap.integrity.outOfOrderFills === 1, "out of order fills");
    check(snap.integrity.unmatchedExchangeOrderIds === 1, "unmatched ids");
    check(snap.integrity.duplicateLifecycleEvents === 1, "duplicate events");
  }

  console.log("\n--- Reset clears all ---");
  {
    const m = new RuntimeLatencyMonitor();
    m.recordMarketStreamToEngineMs(10);
    m.recordMalformedMarketPayload();
    m.reset();
    const snap = m.getSnapshot();
    check(snap.latency.marketStreamToEngine.sampleCount === 0, "latency cleared");
    check(snap.integrity.malformedMarketPayloads === 0, "integrity cleared");
    check(m.getDegradedReasons().length === 0, "no degraded after reset");
  }

  console.log("\n--- Operator health/dashboard latency summary shape ---");
  {
    const m = new RuntimeLatencyMonitor();
    m.recordMarketStreamToEngineMs(20);
    m.recordReconcileDurationMs(100);
    const snapshot = m.getSnapshot();
    const healthLike = { latencyAndIntegrity: snapshot };
    const lat = (healthLike.latencyAndIntegrity as typeof snapshot).latency;
    const integrity = (healthLike.latencyAndIntegrity as typeof snapshot).integrity;
    check(lat.marketStreamToEngine.lastMs === 20, "health latency last");
    check(lat.reconcileDuration.lastMs === 100, "health reconcile last");
    check(typeof integrity.malformedMarketPayloads === "number", "health integrity counts");
    check(typeof lat.asOf === "string", "health latency asOf");
  }

  console.log("\n--- Summary ---");
  console.log(`  Passed: ${passed}, Failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
