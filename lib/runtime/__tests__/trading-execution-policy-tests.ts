/**
 * Trading execution policy unit tests.
 * Run with: npx ts-node --project tsconfig.tests.json -r tsconfig-paths/register lib/runtime/__tests__/trading-execution-policy-tests.ts
 */

import assert from "assert";
import {
  getTradingExecutionPolicy,
  isExecutionAllowed,
  getExecutionBlockedReasons,
  assertExecutionAllowed,
  type ExecutionSurface,
} from "../trading-execution-policy";
import type { RuntimeConfig } from "../runtime-config";

function check(cond: boolean, msg: string): void {
  assert.strictEqual(cond, true, msg);
}

async function run(): Promise<void> {
  let passed = 0;
  let failed = 0;

  function pass(msg: string): void {
    passed++;
    console.log("  OK:", msg);
  }
  function fail(msg: string): void {
    failed++;
    console.error("  FAIL:", msg);
  }

  // ---------- Policy with mode paper ----------
  console.log("\nTrading execution policy — mode paper");
  {
    const config: RuntimeConfig = {
      mode: "paper",
      allowedModes: ["disabled", "observe_only", "paper"],
      source: "test",
    };
    const policy = getTradingExecutionPolicy(config);
    check(policy.effectiveRuntimeMode === "paper", "effective mode paper");
    check(policy.automatedExecutionAllowed === true, "automated execution allowed in paper");
    check(policy.liveOrManualExecutionAllowed === false, "live/manual not allowed (fail-closed)");
    check(
      policy.allowedSurfaces.includes("runtime_automated"),
      "runtime_automated in allowed surfaces"
    );
    check(
      !policy.allowedSurfaces.includes("manual_api"),
      "manual_api not in allowed surfaces"
    );
    if (policy.automatedExecutionAllowed) pass("paper: automated allowed");
    else fail("paper: automated should be allowed");

    check(isExecutionAllowed("runtime_automated", config) === true, "isExecutionAllowed(runtime_automated) true in paper");
    check(isExecutionAllowed("manual_api", config) === false, "isExecutionAllowed(manual_api) false");
    check(isExecutionAllowed("approval_queue", config) === false, "isExecutionAllowed(approval_queue) false");
    check(isExecutionAllowed("position_exit", config) === false, "isExecutionAllowed(position_exit) false");

    const blockedReasons = getExecutionBlockedReasons("runtime_automated", config);
    check(blockedReasons.length === 0, "no blocked reasons for runtime_automated in paper");

    const manualReasons = getExecutionBlockedReasons("manual_api", config);
    check(manualReasons.length > 0, "manual_api has blocked reasons");
    check(
      manualReasons.includes("live_manual_not_authorized"),
      "manual_api blocked by live_manual_not_authorized"
    );

    assertExecutionAllowed("runtime_automated", config); // no throw
    try {
      assertExecutionAllowed("manual_api", config);
      fail("assertExecutionAllowed(manual_api) should throw");
    } catch (e) {
      check(
        String(e).includes("[trading-execution-policy]"),
        "assert throws with policy prefix"
      );
      pass("assertExecutionAllowed(manual_api) throws as expected");
    }
  }

  // ---------- Policy with mode observe_only ----------
  console.log("\nTrading execution policy — mode observe_only");
  {
    const config: RuntimeConfig = {
      mode: "observe_only",
      allowedModes: ["disabled", "observe_only", "paper"],
      source: "test",
    };
    const policy = getTradingExecutionPolicy(config);
    check(policy.effectiveRuntimeMode === "observe_only", "effective mode observe_only");
    check(policy.automatedExecutionAllowed === false, "automated execution not allowed in observe_only");
    check(policy.liveOrManualExecutionAllowed === false, "live/manual not allowed");

    check(isExecutionAllowed("runtime_automated", config) === false, "runtime_automated blocked in observe_only");
    const reasons = getExecutionBlockedReasons("runtime_automated", config);
    check(reasons.length > 0, "runtime_automated has blocked reasons in observe_only");
    check(
      reasons.includes("runtime_mode_observe_only"),
      "blocked by runtime_mode_observe_only"
    );

    try {
      assertExecutionAllowed("runtime_automated", config);
      fail("assertExecutionAllowed(runtime_automated) should throw in observe_only");
    } catch {
      pass("assertExecutionAllowed(runtime_automated) throws in observe_only");
    }
  }

  // ---------- Policy with mode disabled ----------
  console.log("\nTrading execution policy — mode disabled");
  {
    const config: RuntimeConfig = {
      mode: "disabled",
      allowedModes: ["disabled", "observe_only", "paper"],
      source: "test",
    };
    const policy = getTradingExecutionPolicy(config);
    check(policy.automatedExecutionAllowed === false, "automated not allowed in disabled");
    check(isExecutionAllowed("runtime_automated", config) === false, "runtime_automated blocked in disabled");
    const reasons = getExecutionBlockedReasons("runtime_automated", config);
    check(reasons.includes("runtime_mode_disabled"), "blocked by runtime_mode_disabled");
    pass("disabled: automated blocked");
  }

  // ---------- Dashboard/health reflect policy state ----------
  console.log("\nPolicy state for dashboard/health");
  {
    const policyPaper = getTradingExecutionPolicy({
      mode: "paper",
      allowedModes: ["disabled", "observe_only", "paper"],
      source: "test",
    });
    check(
      !policyPaper.liveOrManualExecutionAllowed === true,
      "liveTradingBlocked true when liveOrManual false"
    );
    check(
      policyPaper.automatedExecutionAllowed === true,
      "automatedExecutionAllowed true in paper"
    );

    const policyObserve = getTradingExecutionPolicy({
      mode: "observe_only",
      allowedModes: ["disabled", "observe_only", "paper"],
      source: "test",
    });
    check(
      !policyObserve.liveOrManualExecutionAllowed === true,
      "liveTradingBlocked true in observe_only"
    );
    check(
      policyObserve.automatedExecutionAllowed === false,
      "automatedExecutionAllowed false in observe_only"
    );
    pass("dashboard/health can derive liveTradingBlocked and automatedExecutionAllowed from policy");
  }

  // ---------- No route can place/cancel without passing policy gate ----------
  console.log("\nPolicy gate enforced for all live surfaces");
  {
    const config: RuntimeConfig = {
      mode: "paper",
      allowedModes: ["disabled", "observe_only", "paper"],
      source: "test",
    };
    const surfaces: ExecutionSurface[] = ["manual_api", "approval_queue", "position_exit"];
    for (const surface of surfaces) {
      check(isExecutionAllowed(surface, config) === false, `${surface} is not allowed`);
      try {
        assertExecutionAllowed(surface, config);
        fail(`${surface} assertExecutionAllowed should throw`);
      } catch (e) {
        check(String(e).includes("Execution not allowed"), `throw message mentions not allowed for ${surface}`);
      }
    }
    pass("all manual/live surfaces blocked and assert throws");
  }

  console.log("\n--- Trading execution policy tests ---");
  console.log(`Passed: ${passed}, Failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
