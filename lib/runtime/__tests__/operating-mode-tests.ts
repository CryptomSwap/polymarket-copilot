/**
 * Operating mode: derivation from config and guardrail verdict, policy behavior by mode.
 *
 * Run with (from repo root):
 *   npx ts-node --project tsconfig.tests.json -r tsconfig-paths/register lib/runtime/__tests__/operating-mode-tests.ts
 */

import assert from "assert";
import {
  getEffectiveOperatingMode,
  isNoIntentAdmitted,
  isCancelOnly,
  isReduceOnly,
  isPaperFull,
} from "../operating-mode";
import type { RuntimeMode } from "../runtime-config";
import { getTradingExecutionPolicy, isExecutionAllowed } from "../trading-execution-policy";
import type { RuntimeConfig } from "../runtime-config";

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

  console.log("\n--- Config disabled → operating mode disabled ---");
  {
    const r = getEffectiveOperatingMode({
      runtimeMode: "disabled",
      runtimePhase: "ready",
      guardrailVerdict: "allowed",
    });
    check(r.operatingMode === "disabled", "operatingMode disabled");
    check(r.source === "config", "source config");
  }

  console.log("\n--- Config observe_only → telemetry_only ---");
  {
    const r = getEffectiveOperatingMode({
      runtimeMode: "observe_only",
      runtimePhase: "ready",
      guardrailVerdict: "allowed",
    });
    check(r.operatingMode === "telemetry_only", "operatingMode telemetry_only");
    check(r.source === "config", "source config");
  }

  console.log("\n--- Phase not ready → frozen ---");
  {
    const r = getEffectiveOperatingMode({
      runtimeMode: "paper",
      runtimePhase: "rebuilding",
      guardrailVerdict: "allowed",
    });
    check(r.operatingMode === "frozen", "operatingMode frozen when rebuilding");
    check(r.source === "phase", "source phase");
  }

  console.log("\n--- Guardrail frozen → frozen ---");
  {
    const r = getEffectiveOperatingMode({
      runtimeMode: "paper",
      runtimePhase: "ready",
      guardrailVerdict: "frozen",
    });
    check(r.operatingMode === "frozen", "operatingMode frozen from guardrail");
    check(r.source === "guardrail", "source guardrail");
  }

  console.log("\n--- Guardrail cancel_only → cancel_only ---");
  {
    const r = getEffectiveOperatingMode({
      runtimeMode: "paper",
      runtimePhase: "ready",
      guardrailVerdict: "cancel_only",
    });
    check(r.operatingMode === "cancel_only", "operatingMode cancel_only");
    check(r.source === "guardrail", "source guardrail");
  }

  console.log("\n--- Guardrail requires_reduction → reduce_only ---");
  {
    const r = getEffectiveOperatingMode({
      runtimeMode: "paper",
      runtimePhase: "ready",
      guardrailVerdict: "requires_reduction",
    });
    check(r.operatingMode === "reduce_only", "operatingMode reduce_only");
    check(r.source === "guardrail", "source guardrail");
  }

  console.log("\n--- Paper + allowed or blocked → paper_full ---");
  {
    const r = getEffectiveOperatingMode({
      runtimeMode: "paper",
      runtimePhase: "ready",
      guardrailVerdict: "allowed",
    });
    check(r.operatingMode === "paper_full", "operatingMode paper_full when allowed");
    check(r.source === "config", "source config");
    const rBlocked = getEffectiveOperatingMode({
      runtimeMode: "paper",
      runtimePhase: "ready",
      guardrailVerdict: "blocked",
    });
    check(rBlocked.operatingMode === "paper_full", "operatingMode paper_full when blocked (per-intent block)");
  }

  console.log("\n--- Policy behavior by mode: disabled / telemetry_only = no automated execution ---");
  {
    const configDisabled: RuntimeConfig = {
      mode: "disabled",
      allowedModes: ["disabled", "observe_only", "paper"],
      source: "test",
    };
    check(isExecutionAllowed("runtime_automated", configDisabled) === false, "runtime_automated not allowed when disabled");

    const configObserve: RuntimeConfig = {
      mode: "observe_only",
      allowedModes: ["disabled", "observe_only", "paper"],
      source: "test",
    };
    check(isExecutionAllowed("runtime_automated", configObserve) === false, "runtime_automated not allowed when observe_only");
    const r = getEffectiveOperatingMode({ runtimeMode: "observe_only", runtimePhase: "ready" });
    check(isNoIntentAdmitted(r.operatingMode), "telemetry_only is no intent admitted");
  }

  console.log("\n--- Policy behavior: paper = automated allowed ---");
  {
    const configPaper: RuntimeConfig = {
      mode: "paper",
      allowedModes: ["disabled", "observe_only", "paper"],
      source: "test",
    };
    check(isExecutionAllowed("runtime_automated", configPaper) === true, "runtime_automated allowed when paper");
    const r = getEffectiveOperatingMode({ runtimeMode: "paper", runtimePhase: "ready", guardrailVerdict: "allowed" });
    check(isPaperFull(r.operatingMode), "paper_full when allowed");
  }

  console.log("\n--- Helper predicates ---");
  {
    check(isNoIntentAdmitted("disabled"), "disabled isNoIntentAdmitted");
    check(isNoIntentAdmitted("telemetry_only"), "telemetry_only isNoIntentAdmitted");
    check(isNoIntentAdmitted("frozen"), "frozen isNoIntentAdmitted");
    check(!isNoIntentAdmitted("cancel_only"), "cancel_only allows intents (cancel)");
    check(!isNoIntentAdmitted("paper_full"), "paper_full allows intents");
    check(isCancelOnly("cancel_only"), "cancel_only isCancelOnly");
    check(!isCancelOnly("reduce_only"), "reduce_only not isCancelOnly");
    check(isReduceOnly("reduce_only"), "reduce_only isReduceOnly");
    check(isPaperFull("paper_full"), "paper_full isPaperFull");
  }

  console.log("\n--- Safe rollout: live not in allowedModes ---");
  {
    const policy = getTradingExecutionPolicy({
      mode: "paper",
      allowedModes: ["disabled", "observe_only", "paper"],
      source: "test",
    });
    check(policy.effectiveRuntimeMode === "paper", "effective mode paper");
    check(!policy.liveOrManualExecutionAllowed, "live/manual not allowed");
    check(policy.automatedExecutionAllowed === true, "automated allowed in paper");
  }

  console.log("\n--- Result ---");
  console.log(`Passed: ${passed}, Failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
