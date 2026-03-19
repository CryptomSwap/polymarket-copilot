/**
 * Execution policy evaluator tests: block/allow/warn, deterministic, no hidden weighting.
 *
 * Run with (from repo root):
 *   npx ts-node --project tsconfig.tests.json -r tsconfig-paths/register lib/execution-policy/__tests__/evaluate.test.ts
 */

import assert from "assert";
import { evaluateExecutionPolicy } from "../evaluate";
import type { ExecutionPolicyInput } from "../types";

const baseOrder = {
  funderAddress: "0xtest",
  assetId: "a1",
  marketId: "m1",
  side: "BUY" as const,
  size: 10,
  limitPrice: 0.5,
};

function check(cond: boolean, msg: string): void {
  assert.strictEqual(cond, true, msg);
}

function run(): void {
  console.log("\n--- 1. Valid happy path allows ---");
  {
    const input: ExecutionPolicyInput = {
      order: baseOrder,
      freshness: { marketDataFresh: true, userDataFresh: true, reconciliationFresh: true, runtimePhase: "ready" },
      exposure: { grossExposure: 0, maxTotalExposure: 100_000, workingOrderCount: 0, maxWorkingOrders: 20 },
      operational: { killSwitchActive: false },
    };
    const r = evaluateExecutionPolicy(input);
    check(r.allow === true, "allow true");
    check(r.policyState === "allow", "policyState allow");
    check(r.blockingReasons.length === 0, "no blocking reasons");
    check(r.checks.pricing.pass === true, "pricing pass");
    check(r.checks.operationalSafety.pass === true, "operational pass");
    check(r.snapshotJson.length > 0 && JSON.parse(r.snapshotJson).allow === true, "snapshot serializable");
  }

  console.log("\n--- 2. Missing market freshness blocks ---");
  {
    const input: ExecutionPolicyInput = {
      order: baseOrder,
      freshness: { marketDataFresh: false, userDataFresh: true, reconciliationFresh: true, runtimePhase: "ready" },
      operational: { killSwitchActive: false },
    };
    const r = evaluateExecutionPolicy(input);
    check(r.allow === false, "allow false");
    check(r.blockingReasons.some((x) => x.includes("market_data_stale")), "blocking reason mentions market_data_stale");
    check(r.checks.freshness.pass === false, "freshness fail");
  }

  console.log("\n--- 3. Kill switch active blocks ---");
  {
    const input: ExecutionPolicyInput = {
      order: baseOrder,
      freshness: { marketDataFresh: true, userDataFresh: true, reconciliationFresh: true, runtimePhase: "ready" },
      operational: { killSwitchActive: true },
    };
    const r = evaluateExecutionPolicy(input);
    check(r.allow === false, "allow false");
    check(r.blockingReasons.some((x) => x.includes("kill_switch_active")), "blocking reason kill_switch");
    check(r.checks.operationalSafety.pass === false, "operationalSafety fail");
  }

  console.log("\n--- 4. Invalid price/size blocks ---");
  {
    const inputBadSize: ExecutionPolicyInput = {
      order: { ...baseOrder, size: -1 },
      operational: { killSwitchActive: false },
    };
    const r1 = evaluateExecutionPolicy(inputBadSize);
    check(r1.allow === false, "negative size blocks");
    check(r1.checks.pricing.pass === false, "pricing fail");

    const inputBadPrice: ExecutionPolicyInput = {
      order: { ...baseOrder, limitPrice: 1.5 },
      priceBand: { min: 0, max: 1 },
      operational: { killSwitchActive: false },
    };
    const r2 = evaluateExecutionPolicy(inputBadPrice);
    check(r2.allow === false, "price out of band blocks");
    check(r2.checks.pricing.priceOutOfBand === true, "priceOutOfBand set");

    const inputNaN: ExecutionPolicyInput = {
      order: { ...baseOrder, limitPrice: Number.NaN },
      operational: { killSwitchActive: false },
    };
    const r3 = evaluateExecutionPolicy(inputNaN);
    check(r3.allow === false, "NaN price blocks");
  }

  console.log("\n--- 5. Recommendation blockedReason blocks ---");
  {
    const input: ExecutionPolicyInput = {
      order: baseOrder,
      operational: { killSwitchActive: false },
      recommendation: { blocked: true, blockedReason: "risk_limit_exceeded" },
    };
    const r = evaluateExecutionPolicy(input);
    check(r.allow === false, "allow false");
    check(r.blockingReasons.some((x) => x.includes("recommendation_blocked") || x.includes("blocked_reason")), "block reason");
    check(r.checks.recommendationQuality.pass === false, "recommendationQuality fail");
  }

  console.log("\n--- 6. Stale decision snapshot blocks ---");
  {
    const oldDate = new Date(Date.now() - 400_000);
    const input: ExecutionPolicyInput = {
      order: baseOrder,
      freshness: { marketDataFresh: true, userDataFresh: true, reconciliationFresh: true, runtimePhase: "ready", decisionSnapshotAt: oldDate, decisionSnapshotMaxAgeMs: 300_000 },
      operational: { killSwitchActive: false },
    };
    const r = evaluateExecutionPolicy(input);
    check(r.allow === false, "allow false");
    check(r.blockingReasons.some((x) => x.includes("decision_snapshot_stale")), "stale decision blocks");
    check(r.checks.freshness.pass === false, "freshness fail");
  }

  console.log("\n--- 7. Concentration / exposure threshold breach blocks ---");
  {
    const input: ExecutionPolicyInput = {
      order: baseOrder,
      freshness: { marketDataFresh: true, userDataFresh: true, reconciliationFresh: true, runtimePhase: "ready" },
      exposure: { grossExposure: 150_000, maxTotalExposure: 100_000, workingOrderCount: 5, maxWorkingOrders: 20 },
      operational: { killSwitchActive: false },
    };
    const r = evaluateExecutionPolicy(input);
    check(r.allow === false, "allow false");
    check(r.blockingReasons.some((x) => x.includes("exposure_total_breach")), "exposure breach");
    check(r.checks.exposure.pass === false, "exposure fail");
  }

  console.log("\n--- 8. Warning-only scenario allows with warnings ---");
  {
    const input: ExecutionPolicyInput = {
      order: baseOrder,
      freshness: { marketDataFresh: true, userDataFresh: true, reconciliationFresh: true, runtimePhase: "ready" },
      operational: { killSwitchActive: false },
    };
    const r = evaluateExecutionPolicy(input);
    check(r.allow === true, "allow true");
    check(r.policyState === "allow" || r.policyState === "warn", "allow or warn");
    check(r.blockingReasons.length === 0, "no block reasons");
  }

  console.log("\n--- 9. Invalid side blocks ---");
  {
    const input: ExecutionPolicyInput = {
      order: { ...baseOrder, side: "INVALID" },
      operational: { killSwitchActive: false },
    };
    const r = evaluateExecutionPolicy(input);
    check(r.allow === false, "allow false");
    check(r.checks.pricing.invalidSide === true, "invalidSide set");
  }

  console.log("\n--- 10. Runtime phase rebuilding blocks ---");
  {
    const input: ExecutionPolicyInput = {
      order: baseOrder,
      freshness: { marketDataFresh: true, userDataFresh: true, reconciliationFresh: true, runtimePhase: "rebuilding" },
      operational: { killSwitchActive: false },
    };
    const r = evaluateExecutionPolicy(input);
    check(r.allow === false, "allow false");
    check(r.blockingReasons.some((x) => x.includes("runtime_not_ready")), "runtime_not_ready");
  }

  console.log("\n--- 11. Single-market / single-theme concentration breach (portfolio risk) ---");
  {
    const input: ExecutionPolicyInput = {
      order: baseOrder,
      freshness: { marketDataFresh: true, userDataFresh: true, reconciliationFresh: true, runtimePhase: "ready" },
      exposure: {
        grossExposure: 1000,
        maxTotalExposure: 10_000,
        currentSingleMarketConcentrationPct: 55,
        maxSingleMarketConcentrationPct: 50,
      },
      operational: { killSwitchActive: false },
    };
    const r = evaluateExecutionPolicy(input);
    check(r.allow === false, "block when market concentration exceeds limit");
    check(r.checks.exposure.singleMarketConcentrationVsLimit?.current === 55, "current 55");
    check(r.checks.exposure.singleMarketConcentrationVsLimit?.limit === 50, "limit 50");
  }
  {
    const input: ExecutionPolicyInput = {
      order: baseOrder,
      freshness: { marketDataFresh: true, userDataFresh: true, reconciliationFresh: true, runtimePhase: "ready" },
      exposure: {
        grossExposure: 1000,
        maxTotalExposure: 10_000,
        currentSingleThemeConcentrationPct: 60,
        maxSingleThemeConcentrationPct: 50,
      },
      operational: { killSwitchActive: false },
    };
    const r = evaluateExecutionPolicy(input);
    check(r.allow === false, "block when theme concentration exceeds limit");
    check(r.checks.exposure.singleThemeConcentrationVsLimit?.current === 60, "current 60");
  }

  console.log("\n--- Execution quality integration blocks when execution quality is unsafe ---");
  {
    const input: ExecutionPolicyInput = {
      order: { assetId: "a1", marketId: "m1", funderAddress: "0x", side: "BUY", size: 10, limitPrice: 0.5 },
      freshness: { marketDataFresh: true, userDataFresh: true, reconciliationFresh: true, runtimePhase: "running" },
      exposure: {},
      operational: {},
      priceBand: { min: 0, max: 1 },
      executionQuality: {
        qualityState: "block",
        blockingReasons: ["quote_stale", "insufficient_depth"],
        warnings: [],
      },
    };
    const r = evaluateExecutionPolicy(input);
    check(r.allow === false, "block when execution quality is block");
    check(r.checks.liquidity.executionQualityBlock === true, "liquidity check reflects execution quality block");
    check(
      r.blockingReasons.some((x) => x.includes("execution_quality")),
      "blockingReasons include execution_quality"
    );
  }

  console.log("\nAll execution policy tests passed.");
}

run();
