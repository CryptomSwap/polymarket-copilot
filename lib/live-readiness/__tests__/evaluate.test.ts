/**
 * Live-readiness evaluator tests: paper_only, not_ready, shadow_ready, limited_ready, ready_for_review, allowLiveTrading always false.
 */

import {
  evaluateLiveReadiness,
  buildDefaultLiveReadinessInput,
} from "../evaluate";
import { updateLiveReadinessState, getLiveReadinessState, assertLiveTradingNotPermittedUnlessReadinessPassed } from "../state";
import type { LiveReadinessInput } from "../types";

function check(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function allTechnicalTrue(): LiveReadinessInput {
  return buildDefaultLiveReadinessInput({
    runtimeSafetyState: "normal",
    exchangeCredentialValidationReady: true,
    exchangeTruthHealthy: true,
    operatorMode: "paper_only",
    manualLiveEnableRequested: false,
  });
}

function run(): void {
  console.log("\n--- 1. Default paper_only state ---");
  {
    const input: LiveReadinessInput = { operatorMode: "paper_only" };
    const r = evaluateLiveReadiness(input);
    check(r.overallState === "paper_only" || r.overallState === "not_ready", "default state paper_only or not_ready when checks missing");
    check(r.allowLiveTrading === false, "allowLiveTrading always false");
  }

  console.log("\n--- 2. Runtime safety blocked -> not_ready ---");
  {
    const input = buildDefaultLiveReadinessInput({
      runtimeSafetyState: "kill_switch",
      exchangeTruthHealthy: true,
      exchangeCredentialValidationReady: true,
      manualLiveEnableRequested: true,
    });
    const r = evaluateLiveReadiness(input);
    check(r.overallState === "not_ready", "not_ready when kill_switch");
    check(r.blockingReasons.some((x) => x.includes("runtime_safety")), "blocking reason runtime_safety");
    check(r.allowLiveTrading === false, "allowLiveTrading false");
  }

  console.log("\n--- 3. Missing execution ledger durability -> not_ready ---");
  {
    const input = buildDefaultLiveReadinessInput({
      executionLedgerReady: false,
      runtimeSafetyState: "normal",
      exchangeTruthHealthy: true,
      exchangeCredentialValidationReady: true,
      manualLiveEnableRequested: true,
    });
    const r = evaluateLiveReadiness(input);
    check(r.failedChecks.includes("executionLedgerReady"), "executionLedgerReady failed");
    check(r.overallState === "not_ready", "not_ready when ledger not ready and live requested");
  }

  console.log("\n--- 4. Missing credential validation -> not_ready ---");
  {
    const input = buildDefaultLiveReadinessInput({
      exchangeCredentialValidationReady: false,
      runtimeSafetyState: "normal",
      exchangeTruthHealthy: true,
      manualLiveEnableRequested: true,
    });
    const r = evaluateLiveReadiness(input);
    check(r.blockingReasons.some((x) => x.includes("credential")), "blocking reason credential");
    check(r.overallState === "not_ready", "not_ready");
  }

  console.log("\n--- 5. All technical checks pass but no live request -> paper_only ---");
  {
    const input = allTechnicalTrue();
    const r = evaluateLiveReadiness(input);
    check(r.overallState === "paper_only", "paper_only when all pass and no live request");
    check(r.allowLiveTrading === false, "allowLiveTrading false");
    check(r.passedChecks.length >= 10, "many passed checks");
  }

  console.log("\n--- 6. All technical checks pass with live request -> ready_for_review or limited_ready, allowLiveTrading still false ---");
  {
    const input = buildDefaultLiveReadinessInput({
      ...allTechnicalTrue(),
      manualLiveEnableRequested: true,
      operatorMode: "review_requested",
    });
    const r = evaluateLiveReadiness(input);
    check(
      r.overallState === "ready_for_review" || r.overallState === "limited_ready",
      "ready_for_review or limited_ready when all pass and live requested"
    );
    check(r.allowLiveTrading === false, "allowLiveTrading still false");
  }

  console.log("\n--- 7. Missing live placement guards -> not_ready ---");
  {
    const input = buildDefaultLiveReadinessInput({
      livePlacementGuardsPresent: false,
      runtimeSafetyState: "normal",
      exchangeTruthHealthy: true,
      exchangeCredentialValidationReady: true,
      manualLiveEnableRequested: true,
    });
    const r = evaluateLiveReadiness(input);
    check(r.blockingReasons.some((x) => x.includes("live_placement_guards")), "blocking reason live placement guards");
    check(r.overallState === "not_ready", "not_ready");
  }

  console.log("\n--- 8. Failed reconciliation/durability controls -> not_ready ---");
  {
    const input = buildDefaultLiveReadinessInput({
      reconciliationAlignmentReady: false,
      cancelReplaceDurabilityReady: false,
      runtimeSafetyState: "normal",
      exchangeTruthHealthy: true,
      exchangeCredentialValidationReady: true,
      manualLiveEnableRequested: true,
    });
    const r = evaluateLiveReadiness(input);
    check(r.failedChecks.includes("reconciliationAlignmentReady"), "reconciliation failed");
    check(r.failedChecks.includes("cancelReplaceDurabilityReady"), "cancelReplace failed");
    check(r.overallState === "not_ready", "not_ready");
  }

  console.log("\n--- 9. State store update and get ---");
  {
    const input = allTechnicalTrue();
    const result = evaluateLiveReadiness(input);
    updateLiveReadinessState(result);
    const state = getLiveReadinessState();
    check(state.overallState === result.overallState, "state matches result");
    check(state.allowLiveTrading === false, "allowLiveTrading false in state");
  }

  console.log("\n--- 10. assertLiveTradingNotPermittedUnlessReadinessPassed does not throw ---");
  {
    updateLiveReadinessState(evaluateLiveReadiness(allTechnicalTrue()));
    assertLiveTradingNotPermittedUnlessReadinessPassed();
  }

  console.log("\n--- 11. shadow_ready when some but not all mandatory pass ---");
  {
    const input = buildDefaultLiveReadinessInput({
      executionLedgerReady: true,
      executionPolicyReady: true,
      livePlacementGuardsPresent: true,
      fillReplayRecoveryReady: false,
      orderIntentDurabilityReady: false,
      runtimeSafetyState: "normal",
      exchangeTruthHealthy: true,
      exchangeCredentialValidationReady: true,
      manualLiveEnableRequested: true,
    });
    const r = evaluateLiveReadiness(input);
    check(r.overallState === "shadow_ready" || r.overallState === "not_ready", "shadow_ready or not_ready when ledger+policy+guards but other missing");
  }

  console.log("\nAll live-readiness tests passed.");
}

run();
