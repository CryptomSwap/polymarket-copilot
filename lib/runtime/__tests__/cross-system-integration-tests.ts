/**
 * Cross-system integration: exchange truth, lifecycle journal, execution containment, latency/integrity.
 * Verifies the four systems interact coherently and no contradictory health states occur.
 *
 * Run with (from repo root):
 *   npx ts-node --project tsconfig.tests.json -r tsconfig-paths/register lib/runtime/__tests__/cross-system-integration-tests.ts
 */

import assert from "assert";
import { computeDegraded } from "../runtime-degraded";
import { buildTruthModelStatus } from "../truth/runtime-truth-model";
import { DefaultRuntimeGuardrails } from "../risk/runtime-guardrails";
import { GUARDRAIL_REASON_CODES, type GuardrailFreshnessInput } from "../risk/runtime-guardrails";
import { createDefaultRuntimeRiskState } from "../risk/runtime-risk-engine";
import { FailureContainmentStateManager } from "../execution/execution-failure-containment";
import { RuntimeLatencyMonitor } from "../telemetry/runtime-latency-monitor";
import { InMemoryOrderLifecycleStore } from "../order-manager/order-lifecycle-store";
import { PaperOrderManager } from "../order-manager/paper-order-manager";
import { DefaultOrderIntentReconciler } from "../order-manager/order-intent-reconciler";
import { PaperExchangeAdapter } from "../order-manager/order-exchange-adapter";
import type { SubmitOrderRequest } from "../order-manager/order-exchange-adapter";
import { ORDER_LIFECYCLE_EVENT_TYPES, rebuildOrderFromJournal } from "../journal/order-lifecycle-journal";
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

  const funder = "0xfunder";
  const assetId = "asset_1";
  const marketId = "market_1";

  console.log("\n--- Stale exchange truth + ambiguous cancel + scheduler overload => degraded ---");
  {
    const containment = new FailureContainmentStateManager({ frozenAssetsForceModeThreshold: 1 });
    containment.recordCancelAmbiguous(assetId);
    const latencyMonitor = new RuntimeLatencyMonitor({
      marketLatencyThresholdMs: 100,
      reconcileLatencyThresholdMs: 50,
    });
    latencyMonitor.recordMarketStreamToEngineMs(200);
    latencyMonitor.recordReconcileDurationMs(100);
    const latencyReasons = latencyMonitor.getDegradedReasons();
    const degradedResult = computeDegraded({
      marketConnection: { status: "open", lastMessageAt: new Date(), lastDataEventAt: new Date() } as import("../stream-connection-state").StreamConnectionState,
      userConnection: { status: "open", lastMessageAt: new Date(), lastDataEventAt: new Date() } as import("../stream-connection-state").StreamConnectionState,
      diagnostics: null,
      schedulerBacklog: 150,
      schedulerBacklogThreshold: 100,
      staleAssetCount: 0,
      degradedAssetCount: 0,
      trackedAssetCount: 1,
      executionFrozenAssetCount: containment.getState().frozenAssetIds.size,
      executionFrozenAssetCountThreshold: 1,
      latencyDegradedReasons: latencyReasons,
    });
    check(degradedResult.degraded === true, "degraded when multiple systems bad");
    check(degradedResult.reasons.includes("execution_frozen_assets"), "execution_frozen_assets in reasons");
    check(
      degradedResult.reasons.some((r) => r.includes("latency") || r === "market_processing_latency_high" || r === "reconcile_latency_high"),
      "latency reason present"
    );
    check(degradedResult.reasons.includes("scheduler_backlog_high"), "scheduler_backlog_high");
  }

  console.log("\n--- Stream healthy but exchange truth stale => automation blocked when open orders ---");
  {
    const guardrails = new DefaultRuntimeGuardrails();
    const truthStatus = buildTruthModelStatus({
      lastExchangeOrdersSnapshotAt: null,
      lastExchangeFillsSnapshotAt: null,
      exchangeTruthUnavailable: false,
      ordersStaleThresholdMs: 120_000,
      fillsStaleThresholdMs: 180_000,
    });
    const freshness: GuardrailFreshnessInput = {
      runtimePhase: "ready",
      marketDataFresh: true,
      userDataFresh: true,
      reconciliationFresh: true,
      openOrderCount: 2,
      exchangeTruthHealthy: false,
      exchangeTruthUnavailable: false,
      blockOnStaleExchangeTruthWithWorkingOrders: true,
    };
    const riskState = createDefaultRuntimeRiskState({
      globalAutomationEnabled: true,
      exchangeHealth: "healthy",
      grossExposure: 0,
      netExposure: 0,
      workingOrderCount: 2,
    });
    const result = guardrails.evaluate(
      { funderAddress: funder, strategyId: "s1", asOf: new Date(), assetId },
      riskState,
      { action: "PLACE_ENTRY", assetId, marketId, side: "BUY", size: 10, limitPrice: 0.5 },
      { freshness }
    );
    check(result.verdict !== "allowed", "PLACE_ENTRY blocked when exchange truth stale and open orders");
    check(
      result.reasonCodes.some((c) => String(c).toLowerCase().includes("exchange_truth")),
      "exchange truth reason code present"
    );
  }

  console.log("\n--- Data fresh but execution ambiguity => asset frozen, guardrails block ---");
  {
    const guardrails = new DefaultRuntimeGuardrails();
    const frozenAssets = new Set<string>([assetId]);
    const freshness: GuardrailFreshnessInput = {
      runtimePhase: "ready",
      marketDataFresh: true,
      userDataFresh: true,
      reconciliationFresh: true,
      openOrderCount: 0,
      executionFrozenAssetIds: frozenAssets,
      executionContainmentForceCancelOnlyOrFrozen: false,
    };
    const riskState = createDefaultRuntimeRiskState({
      globalAutomationEnabled: true,
      exchangeHealth: "healthy",
      grossExposure: 0,
      netExposure: 0,
      workingOrderCount: 0,
    });
    const result = guardrails.evaluate(
      { funderAddress: funder, strategyId: "s1", asOf: new Date(), assetId },
      riskState,
      { action: "PLACE_ENTRY", assetId, marketId, side: "BUY", size: 10, limitPrice: 0.5 },
      { freshness }
    );
    check(result.reasonCodes.includes(GUARDRAIL_REASON_CODES.ASSET_EXECUTION_FROZEN) || result.verdict !== "allowed", "asset frozen blocks or reason present");
    check(result.verdict !== "allowed", "PLACE_ENTRY blocked for frozen asset");
  }

  console.log("\n--- Journal records ambiguity: submit_ambiguous event type and replay ---");
  {
    const entries = [
      {
        id: "1",
        funderAddress: funder,
        clientOrderId: "co1",
        exchangeOrderId: null,
        intentId: null,
        assetId,
        marketId,
        side: "BUY",
        eventType: ORDER_LIFECYCLE_EVENT_TYPES.LOCAL_ORDER_CREATED,
        eventSequence: 0,
        payloadJson: JSON.stringify({ clientOrderId: "co1", price: 0.5, size: 10 }),
        metadataJson: null,
        occurredAt: new Date(),
        createdAt: new Date(),
      },
      {
        id: "2",
        funderAddress: funder,
        clientOrderId: "co1",
        exchangeOrderId: null,
        intentId: null,
        assetId,
        marketId,
        side: "BUY",
        eventType: ORDER_LIFECYCLE_EVENT_TYPES.SUBMIT_AMBIGUOUS,
        eventSequence: 1,
        payloadJson: null,
        metadataJson: null,
        occurredAt: new Date(),
        createdAt: new Date(),
      },
    ];
    const state = rebuildOrderFromJournal(entries);
    check(state != null, "replay produces state");
    check(state!.status === "submit_ambiguous", "replayed status is submit_ambiguous");
    check(state!.clientOrderId === "co1", "clientOrderId preserved");
  }

  console.log("\n--- No contradictory health: exchange truth stale implies safeToAutomate false when orders ---");
  {
    const truthStatus = buildTruthModelStatus({
      lastExchangeOrdersSnapshotAt: null,
      lastExchangeFillsSnapshotAt: new Date(),
      exchangeTruthUnavailable: false,
      ordersStaleThresholdMs: 120_000,
      fillsStaleThresholdMs: 180_000,
    });
    check(truthStatus.exchangeTruthHealthy === false, "exchange truth unhealthy when orders snapshot missing");
    const guardrails = new DefaultRuntimeGuardrails();
    const result = guardrails.evaluate(
      { funderAddress: funder, strategyId: "s1", asOf: new Date(), assetId },
      createDefaultRuntimeRiskState({ globalAutomationEnabled: true, exchangeHealth: "healthy", grossExposure: 0, netExposure: 0, workingOrderCount: 1 }),
      { action: "PLACE_ENTRY", assetId, marketId, side: "BUY", size: 10, limitPrice: 0.5 },
      {
        freshness: {
          runtimePhase: "ready",
          marketDataFresh: true,
          userDataFresh: true,
          reconciliationFresh: true,
          openOrderCount: 1,
          exchangeTruthHealthy: false,
          blockOnStaleExchangeTruthWithWorkingOrders: true,
        },
      }
    );
    check(result.verdict !== "allowed", "automation blocked when truth stale and orders exist");
  }

  console.log("\n--- Ambiguous submit => containment + diagnostics + journal event type ---");
  {
    const store = new InMemoryOrderLifecycleStore();
    const adapter = new PaperExchangeAdapter({ submitTimeoutOrAmbiguous: (_: SubmitOrderRequest) => true });
    const containment = new FailureContainmentStateManager();
    const diagnostics = new DefaultRuntimeDiagnosticsCollector();
    const journaled: Array<{ eventType: string }> = [];
    const journalAppend = (p: { eventType: string }) => {
      journaled.push({ eventType: p.eventType });
    };
    const reconciler = new DefaultOrderIntentReconciler();
    const orderManager = new PaperOrderManager({
      store,
      reconciler,
      adapter,
      diagnostics,
      failureContainment: containment,
      journalAppend,
    });
    await orderManager.reconcileIntents([
      { funderAddress: funder, strategyId: "s1", assetId, marketId, side: "BUY", size: 5, limitPrice: 0.5, intentId: "i1" },
    ]);
    check(store.getAll().length === 1 && store.getAll()[0].status === "submit_ambiguous", "order in submit_ambiguous");
    check(containment.isAssetExecutionFrozen(assetId), "containment frozen asset");
    check(diagnostics.getSnapshot().submitAmbiguousCount === 1, "diagnostics submitAmbiguousCount");
    check(journaled.some((e) => e.eventType === ORDER_LIFECYCLE_EVENT_TYPES.SUBMIT_AMBIGUOUS), "journal received submit_ambiguous");
  }

  console.log("\n--- Summary ---");
  console.log(`  Passed: ${passed}, Failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
