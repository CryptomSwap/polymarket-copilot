/**
 * Execution ambiguity: paper adapter timeout/ambiguous leads to ambiguous order state,
 * frozen asset, and automation blocked for that asset. Cancel-replace interrupted path.
 *
 * Run with (from repo root):
 *   npx ts-node --project tsconfig.tests.json -r tsconfig-paths/register lib/runtime/__tests__/execution-ambiguity-paper-tests.ts
 */

import assert from "assert";
import { InMemoryOrderLifecycleStore } from "../order-manager/order-lifecycle-store";
import { PaperOrderManager } from "../order-manager/paper-order-manager";
import { DefaultOrderIntentReconciler } from "../order-manager/order-intent-reconciler";
import {
  PaperExchangeAdapter,
  type SubmitOrderRequest,
  type CancelOrderRequest,
} from "../order-manager/order-exchange-adapter";
import { FailureContainmentStateManager } from "../execution/execution-failure-containment";
import { DefaultRuntimeDiagnosticsCollector } from "../telemetry/runtime-diagnostics";
import { DefaultRuntimeGuardrails } from "../risk/runtime-guardrails";
import {
  GUARDRAIL_REASON_CODES,
  type GuardrailFreshnessInput,
} from "../risk/runtime-guardrails";
import { createDefaultRuntimeRiskState } from "../risk/runtime-risk-engine";

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

  console.log("\n--- Submit timeout => ambiguous state and frozen asset ---");
  {
    const store = new InMemoryOrderLifecycleStore();
    const adapter = new PaperExchangeAdapter({
      submitTimeoutOrAmbiguous: (_req: SubmitOrderRequest) => true,
    });
    const containment = new FailureContainmentStateManager();
    const diagnostics = new DefaultRuntimeDiagnosticsCollector();
    const reconciler = new DefaultOrderIntentReconciler();
    const orderManager = new PaperOrderManager({
      store,
      reconciler,
      adapter,
      lifecycleHandler: undefined,
      diagnostics,
      failureContainment: containment,
    });
    await orderManager.reconcileIntents([
      {
        funderAddress: funder,
        strategyId: "s1",
        assetId,
        marketId,
        side: "BUY",
        size: 10,
        limitPrice: 0.5,
        intentId: "i1",
      },
    ]);
    const orders = store.getAll();
    check(orders.length === 1, "one order created");
    check(orders[0].status === "submit_ambiguous", "order status is submit_ambiguous");
    check(containment.isAssetExecutionFrozen(assetId), "asset is execution frozen");
    const snap = diagnostics.getSnapshot();
    check(snap.submitAmbiguousCount === 1, "diagnostics submitAmbiguousCount === 1");
  }

  console.log("\n--- Cancel timeout => cancel_ambiguous and frozen asset ---");
  {
    const store = new InMemoryOrderLifecycleStore();
    store.create({
      clientOrderId: "co1",
      funderAddress: funder,
      assetId,
      marketId,
      side: "BUY",
      price: 0.5,
      size: 10,
    });
    store.applyAck("co1", "ex1");
    const adapter = new PaperExchangeAdapter({
      cancelTimeoutOrAmbiguous: (_req: CancelOrderRequest) => true,
    });
    const containment = new FailureContainmentStateManager();
    const diagnostics = new DefaultRuntimeDiagnosticsCollector();
    const reconciler = new DefaultOrderIntentReconciler();
    const orderManager = new PaperOrderManager({
      store,
      reconciler,
      adapter,
      lifecycleHandler: undefined,
      diagnostics,
      failureContainment: containment,
    });
    await orderManager.reconcileIntents([
      {
        funderAddress: funder,
        strategyId: "s1",
        assetId,
        marketId,
        side: "BUY",
        size: 5,
        limitPrice: 0.48,
        intentId: "i2",
      },
    ]);
    const orders = store.getAll();
    const canceledOrder = orders.find((o) => o.clientOrderId === "co1");
    check(!!canceledOrder, "order co1 exists");
    check(canceledOrder!.status === "cancel_ambiguous", "order status is cancel_ambiguous");
    check(containment.isAssetExecutionFrozen(assetId), "asset frozen after cancel ambiguous");
    check(diagnostics.getSnapshot().cancelAmbiguousCount === 1, "cancelAmbiguousCount === 1");
  }

  console.log("\n--- Guardrails: asset_execution_frozen blocks PLACE_ENTRY for that asset ---");
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
      {
        funderAddress: funder,
        strategyId: "s1",
        asOf: new Date(),
        assetId,
      },
      riskState,
      { action: "PLACE_ENTRY", assetId, marketId, side: "BUY", size: 10, limitPrice: 0.5 },
      { freshness }
    );
    check(
      result.reasonCodes.includes(GUARDRAIL_REASON_CODES.ASSET_EXECUTION_FROZEN),
      "ASSET_EXECUTION_FROZEN in reason codes"
    );
    check(result.verdict !== "allowed", "verdict not allowed when asset frozen");
  }

  console.log("\n--- Guardrails: executionContainmentForceCancelOnlyOrFrozen => frozen verdict ---");
  {
    const guardrails = new DefaultRuntimeGuardrails();
    const freshness: GuardrailFreshnessInput = {
      runtimePhase: "ready",
      marketDataFresh: true,
      userDataFresh: true,
      reconciliationFresh: true,
      openOrderCount: 0,
      executionFrozenAssetIds: new Set(),
      executionContainmentForceCancelOnlyOrFrozen: true,
    };
    const riskState = createDefaultRuntimeRiskState({
      globalAutomationEnabled: true,
      exchangeHealth: "healthy",
      grossExposure: 0,
      netExposure: 0,
      workingOrderCount: 0,
    });
    const result = guardrails.evaluate(
      {
        funderAddress: funder,
        strategyId: "s1",
        asOf: new Date(),
        assetId,
      },
      riskState,
      { action: "PLACE_ENTRY", assetId, marketId, side: "BUY", size: 10, limitPrice: 0.5 },
      { freshness }
    );
    check(result.verdict === "frozen", "verdict frozen when containment force cancel_only/frozen");
  }

  console.log("\n--- Cancel-replace interrupted: cancel ambiguous => replace_ambiguous, no new order ---");
  {
    const store = new InMemoryOrderLifecycleStore();
    store.create({
      clientOrderId: "old_order",
      funderAddress: funder,
      assetId,
      marketId,
      side: "BUY",
      price: 0.5,
      size: 10,
      intentId: "i_replace",
    });
    store.applyAck("old_order", "ex_old");
    const adapter = new PaperExchangeAdapter({
      cancelTimeoutOrAmbiguous: (req) => req.clientOrderId === "old_order",
    });
    const containment = new FailureContainmentStateManager();
    const diagnostics = new DefaultRuntimeDiagnosticsCollector();
    const reconciler = new DefaultOrderIntentReconciler();
    const orderManager = new PaperOrderManager({
      store,
      reconciler,
      adapter,
      lifecycleHandler: undefined,
      diagnostics,
      failureContainment: containment,
    });
    await orderManager.reconcileIntents([
      {
        funderAddress: funder,
        strategyId: "s1",
        assetId,
        marketId,
        side: "BUY",
        size: 8,
        limitPrice: 0.48,
        intentId: "i_replace",
      },
    ]);
    const orders = store.getAll();
    check(orders.length === 1, "only one order (replace flow did not create new order)");
    check(orders[0].status === "replace_ambiguous", "old order is replace_ambiguous");
    check(containment.isAssetExecutionFrozen(assetId), "asset frozen after replace ambiguous");
    check(diagnostics.getSnapshot().replaceAmbiguousCount === 1, "replaceAmbiguousCount === 1");
  }

  console.log("\n--- Health/diagnostics surface ambiguity ---");
  {
    const containment = new FailureContainmentStateManager();
    containment.recordSubmitAmbiguous("a1");
    containment.recordCancelAmbiguous("a2");
    const state = containment.getState();
    check(state.frozenAssetIds.size === 2, "health: 2 frozen assets");
    check(state.submitAmbiguousCount === 1, "health: submitAmbiguousCount");
    check(state.cancelAmbiguousCount === 1, "health: cancelAmbiguousCount");
  }

  console.log("\n--- Summary ---");
  console.log(`  Passed: ${passed}, Failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
