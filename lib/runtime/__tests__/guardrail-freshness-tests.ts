/**
 * Guardrails freshness: order admission depends on market/user/reconciliation freshness and runtime phase.
 *
 * Run with (from repo root):
 *   npx ts-node --project tsconfig.tests.json -r tsconfig-paths/register lib/runtime/__tests__/guardrail-freshness-tests.ts
 */

import assert from "assert";
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

  const guardrails = new DefaultRuntimeGuardrails();
  const baseContext = {
    funderAddress: "0xfunder",
    strategyId: "s1",
    asOf: new Date(),
    assetId: "a1",
  };
  const healthyRiskState = createDefaultRuntimeRiskState({
    globalAutomationEnabled: true,
    exchangeHealth: "healthy",
    grossExposure: 0,
    netExposure: 0,
    workingOrderCount: 0,
  });

  console.log("\n--- Stale market data blocks PLACE_ENTRY ---");
  {
    const freshness: GuardrailFreshnessInput = {
      runtimePhase: "ready",
      marketDataFresh: false,
      userDataFresh: true,
      reconciliationFresh: true,
      openOrderCount: 0,
    };
    const result = guardrails.evaluate(
      baseContext,
      healthyRiskState,
      { action: "PLACE_ENTRY", assetId: "a1", marketId: "m1", side: "BUY", size: 10, limitPrice: 0.5 },
      { freshness }
    );
    check(result.reasonCodes.includes(GUARDRAIL_REASON_CODES.MARKET_DATA_STALE), "market_data_stale in codes");
    check(result.verdict !== "allowed", "verdict not allowed");
    check(
      result.verdict === "requires_reduction" || result.verdict === "blocked",
      "PLACE_ENTRY blocked when market data stale"
    );
  }

  console.log("\n--- Stale user data blocks new orders when working orders exist ---");
  {
    const freshness: GuardrailFreshnessInput = {
      runtimePhase: "ready",
      marketDataFresh: true,
      userDataFresh: false,
      reconciliationFresh: true,
      openOrderCount: 2,
    };
    const result = guardrails.evaluate(
      baseContext,
      healthyRiskState,
      { action: "UPDATE_QUOTES", assetId: "a1", marketId: "m1", side: "BUY", size: 5, limitPrice: 0.5 },
      { freshness }
    );
    check(result.reasonCodes.includes(GUARDRAIL_REASON_CODES.USER_DATA_STALE), "user_data_stale in codes");
    check(result.verdict !== "allowed", "verdict not allowed when user stale and open orders");
  }

  console.log("\n--- Stale user data does not add user_data_stale when no open orders ---");
  {
    const freshness: GuardrailFreshnessInput = {
      runtimePhase: "ready",
      marketDataFresh: true,
      userDataFresh: false,
      reconciliationFresh: true,
      openOrderCount: 0,
    };
    const result = guardrails.evaluate(
      baseContext,
      healthyRiskState,
      { action: "UPDATE_QUOTES", assetId: "a1", marketId: "m1", side: "BUY", size: 5, limitPrice: 0.5 },
      { freshness }
    );
    check(!result.reasonCodes.includes(GUARDRAIL_REASON_CODES.USER_DATA_STALE), "no user_data_stale when openOrderCount 0");
  }

  console.log("\n--- Reconciling state blocks automation (frozen) ---");
  {
    const freshness: GuardrailFreshnessInput = {
      runtimePhase: "reconciling",
      marketDataFresh: true,
      userDataFresh: true,
      reconciliationFresh: true,
      openOrderCount: 0,
    };
    const result = guardrails.evaluate(
      baseContext,
      healthyRiskState,
      { action: "PLACE_ENTRY", assetId: "a1", marketId: "m1", side: "BUY", size: 10, limitPrice: 0.5 },
      { freshness }
    );
    check(result.reasonCodes.includes(GUARDRAIL_REASON_CODES.RUNTIME_RECONCILING), "runtime_reconciling in codes");
    check(result.reasonCodes.includes(GUARDRAIL_REASON_CODES.EXCHANGE_TRUTH_UNVERIFIED), "exchange_truth_unverified in codes");
    check(result.verdict === "frozen", "verdict frozen when reconciling");
  }

  console.log("\n--- Rebuilding state blocks (frozen) ---");
  {
    const freshness: GuardrailFreshnessInput = {
      runtimePhase: "rebuilding",
      marketDataFresh: true,
      userDataFresh: true,
      reconciliationFresh: true,
      openOrderCount: 0,
    };
    const result = guardrails.evaluate(
      baseContext,
      healthyRiskState,
      { action: "UPDATE_QUOTES", assetId: "a1", marketId: "m1", side: "BUY", size: 5, limitPrice: 0.5 },
      { freshness }
    );
    check(result.reasonCodes.includes(GUARDRAIL_REASON_CODES.RUNTIME_REBUILDING), "runtime_rebuilding in codes");
    check(result.verdict === "frozen", "verdict frozen when rebuilding");
  }

  console.log("\n--- Reduce-only: requires_reduction allows REDUCE_RISK / CANCEL_ORDERS / PLACE_EXIT ---");
  {
    const freshness: GuardrailFreshnessInput = {
      runtimePhase: "ready",
      marketDataFresh: false,
      userDataFresh: true,
      reconciliationFresh: true,
      openOrderCount: 0,
    };
    const placeResult = guardrails.evaluate(
      baseContext,
      healthyRiskState,
      { action: "PLACE_ENTRY", assetId: "a1", marketId: "m1", side: "BUY", size: 10, limitPrice: 0.5 },
      { freshness }
    );
    check(placeResult.verdict === "requires_reduction", "PLACE_ENTRY gets requires_reduction when market stale");
    const cancelResult = guardrails.evaluate(
      baseContext,
      healthyRiskState,
      { action: "CANCEL_ORDERS", assetId: "a1", marketId: "m1" },
      { freshness }
    );
    check(cancelResult.reasonCodes.includes(GUARDRAIL_REASON_CODES.MARKET_DATA_STALE) === false, "CANCEL_ORDERS does not add market_data_stale (no new-entry check)");
    check(cancelResult.verdict === "allowed" || cancelResult.reasonCodes.length === 0, "CANCEL_ORDERS allowed when only market stale (no new entry)");
  }

  console.log("\n--- No freshness input: existing behavior unchanged ---");
  {
    const result = guardrails.evaluate(
      baseContext,
      healthyRiskState,
      { action: "UPDATE_QUOTES", assetId: "a1", marketId: "m1", side: "BUY", size: 5, limitPrice: 0.5 }
    );
    check(result.verdict === "allowed", "allowed when no freshness and healthy");
    check(result.reasonCodes.length === 0, "no reason codes");
  }

  console.log("\n--- Result ---");
  console.log(`Passed: ${passed}, Failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
