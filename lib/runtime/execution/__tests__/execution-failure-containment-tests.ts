/**
 * Execution failure containment: ambiguous submit/cancel/replace freezes asset,
 * blocks new entries, and can degrade runtime or force cancel_only/frozen.
 *
 * Run with (from repo root):
 *   npx ts-node --project tsconfig.tests.json -r tsconfig-paths/register lib/runtime/execution/__tests__/execution-failure-containment-tests.ts
 */

import assert from "assert";
import {
  FailureContainmentStateManager,
  DEFAULT_AMBIGUITY_DEGRADE_THRESHOLD,
  DEFAULT_FROZEN_ASSETS_FORCE_MODE_THRESHOLD,
} from "../execution-failure-containment";

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

  console.log("\n--- Submit ambiguous freezes asset and increments counters ---");
  {
    const m = new FailureContainmentStateManager();
    ok(!m.isAssetExecutionFrozen("a1"), "asset not frozen initially");
    m.recordSubmitAmbiguous("a1");
    check(m.isAssetExecutionFrozen("a1"), "asset frozen after submit ambiguous");
    const state = m.getState();
    check(state.submitAmbiguousCount === 1, "submitAmbiguousCount === 1");
    check(state.executionVerificationRequiredCount === 1, "executionVerificationRequiredCount === 1");
    check(state.frozenAssetIds.has("a1"), "frozenAssetIds contains a1");
  }

  console.log("\n--- Cancel ambiguous freezes asset ---");
  {
    const m = new FailureContainmentStateManager();
    m.recordCancelAmbiguous("a2");
    check(m.isAssetExecutionFrozen("a2"), "asset frozen after cancel ambiguous");
    const state = m.getState();
    check(state.cancelAmbiguousCount === 1, "cancelAmbiguousCount === 1");
  }

  console.log("\n--- Replace ambiguous freezes asset ---");
  {
    const m = new FailureContainmentStateManager();
    m.recordReplaceAmbiguous("a3");
    check(m.isAssetExecutionFrozen("a3"), "asset frozen after replace ambiguous");
    check(m.getState().replaceAmbiguousCount === 1, "replaceAmbiguousCount === 1");
  }

  console.log("\n--- clearAssetFrozen unfreezes asset ---");
  {
    const m = new FailureContainmentStateManager();
    m.recordSubmitAmbiguous("a1");
    ok(m.isAssetExecutionFrozen("a1"), "frozen before clear");
    m.clearAssetFrozen("a1");
    ok(!m.isAssetExecutionFrozen("a1"), "not frozen after clear");
  }

  console.log("\n--- Repeated ambiguities in window => shouldDegradeRuntime ---");
  {
    const m = new FailureContainmentStateManager({
      ambiguityDegradeThreshold: 3,
      ambiguityWindowMs: 60_000,
    });
    ok(!m.shouldDegradeRuntime(), "not degraded with 0 ambiguities");
    m.recordSubmitAmbiguous("a1");
    m.recordCancelAmbiguous("a2");
    ok(!m.shouldDegradeRuntime(), "not degraded with 2 ambiguities");
    m.recordReplaceAmbiguous("a3");
    check(m.shouldDegradeRuntime(), "degraded with 3 ambiguities in window");
  }

  console.log("\n--- Frozen assets >= threshold => shouldForceCancelOnlyOrFrozen ---");
  {
    const m = new FailureContainmentStateManager({
      frozenAssetsForceModeThreshold: 2,
    });
    ok(!m.shouldForceCancelOnlyOrFrozen(), "not force mode with 0 frozen");
    m.recordSubmitAmbiguous("a1");
    ok(!m.shouldForceCancelOnlyOrFrozen(), "not force mode with 1 frozen");
    m.recordCancelAmbiguous("a2");
    check(m.shouldForceCancelOnlyOrFrozen(), "force cancel_only/frozen with 2 frozen assets");
  }

  console.log("\n--- Health/diagnostics: state snapshot has all counters ---");
  {
    const m = new FailureContainmentStateManager();
    m.recordSubmitAmbiguous("x");
    m.recordCancelAmbiguous("y");
    const state = m.getState();
    check(state.submitAmbiguousCount === 1, "snapshot submitAmbiguousCount");
    check(state.cancelAmbiguousCount === 1, "snapshot cancelAmbiguousCount");
    check(state.frozenAssetIds.size === 2, "snapshot frozenAssetIds size");
    check(state.lastAmbiguityAt != null, "lastAmbiguityAt set");
  }

  console.log("\n--- reset clears all state ---");
  {
    const m = new FailureContainmentStateManager();
    m.recordSubmitAmbiguous("a1");
    m.recordCancelAmbiguous("a2");
    m.reset();
    ok(!m.isAssetExecutionFrozen("a1"), "a1 not frozen after reset");
    ok(!m.isAssetExecutionFrozen("a2"), "a2 not frozen after reset");
    check(m.getState().submitAmbiguousCount === 0, "submitAmbiguousCount 0 after reset");
    check(m.getState().cancelAmbiguousCount === 0, "cancelAmbiguousCount 0 after reset");
  }

  console.log("\n--- Default constants ---");
  {
    check(DEFAULT_AMBIGUITY_DEGRADE_THRESHOLD >= 1, "DEFAULT_AMBIGUITY_DEGRADE_THRESHOLD >= 1");
    check(DEFAULT_FROZEN_ASSETS_FORCE_MODE_THRESHOLD >= 1, "DEFAULT_FROZEN_ASSETS_FORCE_MODE_THRESHOLD >= 1");
  }

  console.log("\n--- Summary ---");
  console.log(`  Passed: ${passed}, Failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
