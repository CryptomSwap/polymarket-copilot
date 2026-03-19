/**
 * Runtime truth model: exchange-truth authority, freshness, guardrail gating, operator health.
 *
 * Run with (from repo root):
 *   npx ts-node --project tsconfig.tests.json -r tsconfig-paths/register lib/runtime/truth/__tests__/runtime-truth-model-tests.ts
 */

import assert from "assert";
import {
  computeExchangeTruthFreshness,
  buildTruthModelStatus,
  getTruthSourceBySubsystem,
  EXCHANGE_TRUTH_STALE_REASONS,
  DEFAULT_ORDERS_TRUTH_STALE_MS,
  DEFAULT_FILLS_TRUTH_STALE_MS,
} from "../runtime-truth-model";
import { computeDegraded } from "../../runtime-degraded";
import { buildOperatorHealth } from "../../runtime-health";
import { createInitialStreamConnectionState } from "../../stream-connection-state";
import { getTradingExecutionPolicy } from "../../trading-execution-policy";
import {
  DefaultRuntimeGuardrails,
  GUARDRAIL_REASON_CODES,
  type GuardrailFreshnessInput,
} from "../../risk/runtime-guardrails";
import { createDefaultRuntimeRiskState } from "../../risk/runtime-risk-engine";

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

  console.log("\n--- Exchange truth available and fresh ---");
  {
    const now = new Date();
    const status = buildTruthModelStatus({
      lastExchangeOrdersSnapshotAt: now,
      lastExchangeFillsSnapshotAt: now,
    });
    check(status.exchangeTruthHealthy === true, "exchangeTruthHealthy true when both snapshots recent");
    check(status.staleReasonCodes.length === 0, "no stale reason codes when fresh");
    check(
      status.truthSourceBySubsystem.orders === "exchange_pull",
      "orders source is exchange_pull when fresh"
    );
    check(
      status.truthSourceBySubsystem.fills === "exchange_pull",
      "fills source is exchange_pull when fresh"
    );
    check(status.lastExchangeOrdersSnapshotAt != null, "lastExchangeOrdersSnapshotAt set");
    check(status.lastExchangeFillsSnapshotAt != null, "lastExchangeFillsSnapshotAt set");
  }

  console.log("\n--- Exchange truth stale while streams still active ---");
  {
    const old = new Date(Date.now() - DEFAULT_ORDERS_TRUTH_STALE_MS - 10_000);
    const freshness = computeExchangeTruthFreshness({
      lastExchangeOrdersSnapshotAt: old,
      lastExchangeFillsSnapshotAt: new Date(),
    });
    check(freshness.exchangeTruthHealthy === false, "exchangeTruthHealthy false when orders snapshot old");
    check(
      freshness.exchangeTruthStaleReasonCodes.includes(EXCHANGE_TRUTH_STALE_REASONS.EXCHANGE_TRUTH_ORDERS_STALE),
      "exchange_truth_orders_stale in reason codes"
    );
    check(
      freshness.exchangeTruthStaleReasonCodes.includes(EXCHANGE_TRUTH_STALE_REASONS.EXCHANGE_TRUTH_STALE),
      "exchange_truth_stale in reason codes"
    );

    const bothOld = new Date(Date.now() - DEFAULT_FILLS_TRUTH_STALE_MS - 10_000);
    const freshness2 = computeExchangeTruthFreshness({
      lastExchangeOrdersSnapshotAt: bothOld,
      lastExchangeFillsSnapshotAt: bothOld,
    });
    check(
      freshness2.exchangeTruthStaleReasonCodes.includes(EXCHANGE_TRUTH_STALE_REASONS.EXCHANGE_TRUTH_FILLS_STALE),
      "exchange_truth_fills_stale when fills snapshot old"
    );
  }

  console.log("\n--- Working orders + stale exchange truth => blocked ---");
  {
    const guardrails = new DefaultRuntimeGuardrails();
    const riskState = createDefaultRuntimeRiskState({
      globalAutomationEnabled: true,
      exchangeHealth: "healthy",
      grossExposure: 0,
      netExposure: 0,
      workingOrderCount: 1,
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
    const result = guardrails.evaluate(
      {
        funderAddress: "0xf",
        strategyId: "s1",
        asOf: new Date(),
        assetId: "a1",
      },
      riskState,
      { action: "PLACE_ENTRY", assetId: "a1", marketId: "m1", side: "BUY", size: 10, limitPrice: 0.5 },
      { freshness }
    );
    check(
      result.reasonCodes.includes(GUARDRAIL_REASON_CODES.EXCHANGE_TRUTH_STALE),
      "EXCHANGE_TRUTH_STALE in reasonCodes when stale and working orders"
    );
    check(result.verdict !== "allowed", "verdict not allowed when exchange truth stale and working orders");
  }

  console.log("\n--- Working orders + exchange truth unavailable => blocked ---");
  {
    const guardrails = new DefaultRuntimeGuardrails();
    const riskState = createDefaultRuntimeRiskState({
      globalAutomationEnabled: true,
      exchangeHealth: "healthy",
      grossExposure: 0,
      netExposure: 0,
      workingOrderCount: 1,
    });
    const freshness: GuardrailFreshnessInput = {
      runtimePhase: "ready",
      marketDataFresh: true,
      userDataFresh: true,
      reconciliationFresh: true,
      openOrderCount: 1,
      exchangeTruthHealthy: false,
      exchangeTruthUnavailable: true,
      blockOnStaleExchangeTruthWithWorkingOrders: true,
    };
    const result = guardrails.evaluate(
      {
        funderAddress: "0xf",
        strategyId: "s1",
        asOf: new Date(),
        assetId: "a1",
      },
      riskState,
      { action: "PLACE_ENTRY", assetId: "a1", marketId: "m1", side: "BUY", size: 10, limitPrice: 0.5 },
      { freshness }
    );
    check(
      result.reasonCodes.includes(GUARDRAIL_REASON_CODES.EXCHANGE_TRUTH_UNAVAILABLE),
      "EXCHANGE_TRUTH_UNAVAILABLE in reasonCodes"
    );
    check(result.verdict !== "allowed", "verdict not allowed when exchange truth unavailable and working orders");
  }

  console.log("\n--- Healthy exchange truth clears degraded status ---");
  {
    const openState = {
      ...createInitialStreamConnectionState(),
      status: "open" as const,
      lastOpenAt: new Date(),
      lastMessageAt: new Date(),
      lastHeartbeatAt: new Date(),
      lastDataEventAt: new Date(),
    };
    const now = new Date();
    const degradedResult = computeDegraded({
      marketConnection: openState,
      userConnection: openState,
      openOrderCount: 0,
      diagnostics: null,
      schedulerBacklog: 0,
      staleAssetCount: 0,
      degradedAssetCount: 0,
      trackedAssetCount: 5,
      lastExchangeOrdersSnapshotAt: now,
      lastExchangeFillsSnapshotAt: now,
      exchangeTruthUnavailable: false,
    });
    const hasExchangeTruthReasons = degradedResult.reasons.some(
      (r) =>
        r === "exchange_truth_stale" ||
        r === "exchange_truth_unavailable" ||
        r === "exchange_truth_orders_stale" ||
        r === "exchange_truth_fills_stale"
    );
    check(!hasExchangeTruthReasons, "no exchange_truth degraded reasons when snapshots fresh");
  }

  console.log("\n--- Stale exchange truth adds degraded reasons ---");
  {
    const openState = {
      ...createInitialStreamConnectionState(),
      status: "open" as const,
      lastOpenAt: new Date(),
      lastMessageAt: new Date(),
      lastHeartbeatAt: new Date(),
      lastDataEventAt: new Date(),
    };
    const old = new Date(Date.now() - DEFAULT_ORDERS_TRUTH_STALE_MS - 5_000);
    const degradedResult = computeDegraded({
      marketConnection: openState,
      userConnection: openState,
      openOrderCount: 0,
      diagnostics: null,
      schedulerBacklog: 0,
      staleAssetCount: 0,
      degradedAssetCount: 0,
      trackedAssetCount: 5,
      lastExchangeOrdersSnapshotAt: old,
      lastExchangeFillsSnapshotAt: old,
      exchangeTruthUnavailable: false,
    });
    check(
      degradedResult.reasons.includes("exchange_truth_stale"),
      "exchange_truth_stale in degraded reasons when snapshots old"
    );
    check(degradedResult.degraded === true, "degraded true when exchange truth stale");
  }

  console.log("\n--- Exchange truth unavailable adds exchange_truth_unavailable ---");
  {
    const openState = {
      ...createInitialStreamConnectionState(),
      status: "open" as const,
      lastOpenAt: new Date(),
      lastMessageAt: new Date(),
      lastHeartbeatAt: new Date(),
      lastDataEventAt: new Date(),
    };
    const degradedResult = computeDegraded({
      marketConnection: openState,
      userConnection: openState,
      openOrderCount: 0,
      diagnostics: null,
      schedulerBacklog: 0,
      staleAssetCount: 0,
      degradedAssetCount: 0,
      trackedAssetCount: 5,
      lastExchangeOrdersSnapshotAt: null,
      lastExchangeFillsSnapshotAt: null,
      exchangeTruthUnavailable: true,
    });
    check(
      degradedResult.reasons.includes("exchange_truth_unavailable"),
      "exchange_truth_unavailable in reasons"
    );
    check(degradedResult.reasons.includes("exchange_truth_stale"), "exchange_truth_stale when unavailable");
  }

  console.log("\n--- Operator health reflects truth authority ---");
  {
    const now = new Date();
    const truthStatus = buildTruthModelStatus({
      lastExchangeOrdersSnapshotAt: now,
      lastExchangeFillsSnapshotAt: now,
    });
    const op = buildOperatorHealth({
      marketConnection: createInitialStreamConnectionState(),
      userConnection: createInitialStreamConnectionState(),
      marketDataHealthy: false,
      userDataHealthy: false,
      operationalReadiness: false,
      runtimePhase: "ready",
      globalAutomationEnabled: true,
      watchdogReasons: [],
      reconciliationLastAt: null,
      reconciliationStatus: null,
      reconciliationDriftDetected: false,
      reconciliationDurationMs: 0,
      executionPolicy: getTradingExecutionPolicy(),
      truthModelStatus: truthStatus,
    });
    check(op.truthModel != null, "operatorHealth.truthModel present");
    check(op.truthModel!.exchangeTruthHealthy === true, "truthModel.exchangeTruthHealthy true");
    check(op.truthModel!.lastExchangeOrdersSnapshotAt != null, "truthModel.lastExchangeOrdersSnapshotAt set");
    check(op.truthModel!.lastExchangeFillsSnapshotAt != null, "truthModel.lastExchangeFillsSnapshotAt set");
    check(
      op.truthModel!.truthSourceBySubsystem.orders === "exchange_pull",
      "truthModel.truthSourceBySubsystem.orders is exchange_pull"
    );
    check(
      op.truthModel!.truthSourceBySubsystem.fills === "exchange_pull",
      "truthModel.truthSourceBySubsystem.fills is exchange_pull"
    );
  }

  console.log("\n--- getTruthSourceBySubsystem: runtime_memory when not healthy ---");
  {
    const freshness = computeExchangeTruthFreshness({
      lastExchangeOrdersSnapshotAt: null,
      lastExchangeFillsSnapshotAt: null,
      exchangeTruthUnavailable: true,
    });
    const source = getTruthSourceBySubsystem(freshness);
    check(source.orders === "runtime_memory", "orders source runtime_memory when unhealthy");
    check(source.fills === "durable_ledger", "fills source durable_ledger when unhealthy");
  }

  console.log("\n--- Result ---");
  console.log(`Passed: ${passed}, Failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
