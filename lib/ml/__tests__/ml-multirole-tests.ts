/**
 * Focused tests: target registry, label definitions, score bundle backwards compatibility,
 * config-gated behavior, paper exploration legacy mode.
 */

import { ML_TARGET_REGISTRY, getImplementedTargets, getScaffoldedTargets, getTargetDefinition } from "../targets/registry";
import { ML_SHADOW_LABEL_COLUMNS } from "../targets/schema";
import { validateTargetForTraining, validateActiveModelTarget } from "../targets/validate";
import type { MlTargetKey } from "../types/targets";
import { fromLegacyShadowScore } from "../types/scoring";
import { getTargetHorizonHours } from "../types/targets";
import { getExplorationPolicyMode, suggestExplorationBucket } from "@/lib/paper-trading/exploration-policy";
import { buildChampionChallengerComparison } from "../champion-challenger";
import { buildSegmentSupportMap, isLowSupportSegment } from "../support/segment-support";
import { computeScoringSupportMetrics } from "../support/scoring-support";
import {
  enableMlMultiroleOutputs,
  enablePaperExplorationAllocatorV1,
  enableMlChampionChallenger,
  enableMlSupportFlags,
} from "../config";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function testTargetRegistry(): void {
  assert(getImplementedTargets().includes("labelGoodDecision"), "labelGoodDecision implemented");
  assert(getImplementedTargets().includes("labelMissedOpportunity"), "labelMissedOpportunity implemented");
  assert(getScaffoldedTargets().includes("labelGoodDecision12h"), "labelGoodDecision12h scaffolded");
  const def = getTargetDefinition("labelGoodDecision12h");
  assert(def.horizonHours === 12, "labelGoodDecision12h horizon 12");
  assert(def.implemented === false, "labelGoodDecision12h not implemented");
  assert(def.implementationStatus === "partial", "labelGoodDecision12h partial (offline-historical only)");
  assert(def.populatedByCanonicalBuilder === false && def.populatedByOfflineHistorical === true, "labelGoodDecision12h populated only by offline");
  assert(getTargetHorizonHours("labelRealizablePnlPositive12h") === 12, "realizable 12h horizon");
  assert(Object.keys(ML_TARGET_REGISTRY).length >= 5, "registry has multiple targets");
}

function testScoreBundleBackwardsCompatibility(): void {
  const bundle = fromLegacyShadowScore(0.55, "run-1", "labelGoodDecision", "shadow_v1", ["portfolio_exposure_missing"]);
  assert(bundle.rankingScore === 0.55, "rankingScore set");
  assert(bundle.probabilityScore === 0.55, "probabilityScore set");
  assert(bundle.modelVariantId === "run-1", "modelVariantId set");
  assert(Boolean(bundle.uncertaintyFlags?.includes("portfolio_exposure_missing")), "uncertaintyFlags from warnings");
  assert(Boolean(bundle.roles?.includes("ranking") && bundle.roles?.includes("probability")), "roles include ranking and probability");
}

function testConfigGating(): void {
  assert(typeof enableMlMultiroleOutputs() === "boolean", "enableMlMultiroleOutputs returns boolean");
  assert(typeof enablePaperExplorationAllocatorV1() === "boolean", "enablePaperExplorationAllocatorV1 returns boolean");
  assert(typeof enableMlChampionChallenger() === "boolean", "enableMlChampionChallenger returns boolean");
  assert(typeof enableMlSupportFlags() === "boolean", "enableMlSupportFlags returns boolean");
}

function testExplorationLegacyMode(): void {
  const mode = getExplorationPolicyMode();
  assert(mode === "legacy_threshold_only" || mode === "blended_allocator_v1", "valid mode");
  const prov = suggestExplorationBucket(
    { mode: "legacy_threshold_only" },
    { score: 0.6, threshold: 0.3 }
  );
  assert(prov === null, "legacy mode returns null provenance");
}

function testSupportHelpers(): void {
  const segmentValues = [
    { a: "x", b: "1" },
    { a: "x", b: "1" },
    { a: "y", b: "1" },
  ];
  const map = buildSegmentSupportMap(segmentValues, 2);
  assert(map.size >= 1, "support map has entries");
  const key = "a=x|b=1";
  const summary = map.get(key);
  assert(summary != null && summary.trainingCount === 2, "segment a=x|b=1 count 2");
  assert(!isLowSupportSegment(key, map, 2), "not low support for 2");
  assert(isLowSupportSegment("a=z|b=1", map, 2), "missing segment is low support");
  const metrics = computeScoringSupportMetrics({
    totalFeatureCount: 20,
    missingFeatureCount: 4,
    segmentKeys: { a: "x", b: "1" },
  }, map, 2);
  assert(metrics.missingFeatureFraction === 0.2, "missing fraction 0.2");
}

function testChampionChallenger(): void {
  const champ = fromLegacyShadowScore(0.5, "c1", "labelGoodDecision", "shadow_v1", []);
  const chall = fromLegacyShadowScore(0.52, "c2", "labelGoodDecision12h", "shadow_v1", []);
  const comp = buildChampionChallengerComparison("rec-1", champ, [
    { descriptor: { variantId: "c2", role: "challenger", targetLabel: "labelGoodDecision12h" }, bundle: chall },
  ]);
  assert(comp.champion !== null, "champion set");
  assert(comp.challengers.length === 1, "one challenger");
  assert(comp.summary?.championScore === 0.5, "champion score");
  assert(comp.summary?.bestChallengerScore === 0.52, "challenger score");
  assert(comp.summary?.scoreDelta != null && Math.abs(comp.summary.scoreDelta - 0.02) < 1e-6, "delta");
}

function main(): void {
  testTargetRegistry();
  testScoreBundleBackwardsCompatibility();
  testConfigGating();
  testExplorationLegacyMode();
  testSupportHelpers();
  testChampionChallenger();
  testTargetTruthValidation();
  console.log("All ml-multirole tests passed.");
}

function testTargetTruthValidation(): void {
  const v1 = validateTargetForTraining("labelGoodDecision12h", { populatedCount: 0 });
  assert(v1.warnings.length >= 1, "scaffolded/partial target yields warning");
  assert(v1.errors.some((e) => e.includes("zero")), "zero population yields error");

  const v2 = validateTargetForTraining("labelGoodDecision", { populatedCount: 100 });
  assert(v2.ok === true && v2.errors.length === 0, "implemented target with data ok");

  const v3 = validateActiveModelTarget("labelGoodDecision", { hasCanonicalPopulation: true });
  assert(v3.ok === true, "active model implemented target ok");

  const v4 = validateActiveModelTarget("unknown_target_xyz", {});
  assert(v4.ok === false && v4.errors.length >= 1, "unknown target yields error");

  assert((ML_SHADOW_LABEL_COLUMNS as readonly string[]).includes("labelGoodDecision12h"), "schema has labelGoodDecision12h");
  assert(!(ML_SHADOW_LABEL_COLUMNS as readonly string[]).includes("labelGoodDecision24h"), "schema does not have labelGoodDecision24h");
}

main();
