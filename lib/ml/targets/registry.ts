/**
 * ML target registry: canonical list of labels with explicit truth (schema, population, trainable).
 * Shadow targets: MlShadowTrainingExample. Recommendation targets: MlTrainingExample (separate).
 */

import type { TargetDefinition, TargetImplementationStatus } from "./types";
import type { MlTargetKey } from "@/lib/ml/types/targets";
import { isShadowSchemaLabelColumn } from "./schema";

function def(
  key: MlTargetKey,
  description: string,
  horizonHours: number | null,
  objectiveFamily: TargetDefinition["objectiveFamily"],
  opts: {
    implemented: boolean;
    schemaPresent: boolean;
    populatedByCanonicalBuilder: boolean;
    populatedByOfflineHistorical: boolean;
    trainableNow: boolean;
    scoringSupportedNow: boolean;
    implementationStatus: TargetImplementationStatus;
    gaps?: string[];
  }
): TargetDefinition {
  return {
    key,
    description,
    horizonHours,
    objectiveFamily,
    implemented: opts.implemented,
    gaps: opts.gaps,
    schemaPresent: opts.schemaPresent,
    populatedByCanonicalBuilder: opts.populatedByCanonicalBuilder,
    populatedByOfflineHistorical: opts.populatedByOfflineHistorical,
    trainableNow: opts.trainableNow,
    scoringSupportedNow: opts.scoringSupportedNow,
    implementationStatus: opts.implementationStatus,
  };
}

/** Shadow canonical build = build.ts persistShadowTrainingExamples (from ShadowCandidate). */
/** Shadow offline = offline-historical.ts (from MarketPriceSnapshot). */
/** TrainableNow = accepted by trainShadowModel (ShadowTargetLabel). */

export const ML_TARGET_REGISTRY: Record<MlTargetKey, TargetDefinition> = {
  labelGoodDecision: def(
    "labelGoodDecision",
    "Good decision (outcome-based: good_allow or good_block)",
    null,
    "good_decision",
    {
      implemented: true,
      schemaPresent: true,
      populatedByCanonicalBuilder: true,
      populatedByOfflineHistorical: true,
      trainableNow: true,
      scoringSupportedNow: true,
      implementationStatus: "implemented",
    }
  ),
  labelGoodDecision6h: def(
    "labelGoodDecision6h",
    "Good decision at 6h horizon (markout-based)",
    6,
    "good_decision",
    {
      implemented: false,
      schemaPresent: true,
      populatedByCanonicalBuilder: false,
      populatedByOfflineHistorical: true,
      trainableNow: true,
      scoringSupportedNow: true,
      implementationStatus: "partial",
      gaps: ["Canonical build (build.ts) does not set labelGoodDecision6h; only offline-historical populates it."],
    }
  ),
  labelGoodDecision12h: def(
    "labelGoodDecision12h",
    "Good decision at 12h horizon (markout-based)",
    12,
    "good_decision",
    {
      implemented: true,
      schemaPresent: true,
      populatedByCanonicalBuilder: true,
      populatedByOfflineHistorical: true,
      trainableNow: true,
      scoringSupportedNow: true,
      implementationStatus: "implemented",
      gaps: [
        "Canonical build sets labelGoodDecision12h only when 12h price snapshots are available; rows without sufficient data are left null.",
      ],
    }
  ),
  labelGoodDecision24h: def(
    "labelGoodDecision24h",
    "Good decision at 24h horizon (markout-based)",
    24,
    "good_decision",
    {
      implemented: false,
      schemaPresent: false,
      populatedByCanonicalBuilder: false,
      populatedByOfflineHistorical: false,
      trainableNow: false,
      scoringSupportedNow: false,
      implementationStatus: "scaffolded",
      gaps: ["No column on MlShadowTrainingExample; add to schema to implement."],
    }
  ),
  labelSpreadAdjustedGoodDecision12h: def(
    "labelSpreadAdjustedGoodDecision12h",
    "Good decision at 12h after spread adjustment (realistic fill)",
    12,
    "spread_adjusted",
    {
      implemented: false,
      schemaPresent: false,
      populatedByCanonicalBuilder: false,
      populatedByOfflineHistorical: false,
      trainableNow: false,
      scoringSupportedNow: false,
      implementationStatus: "scaffolded",
      gaps: ["Requires spread at decision time and at 12h; not yet computed."],
    }
  ),
  labelRealizablePnlPositive12h: def(
    "labelRealizablePnlPositive12h",
    "Realizable PnL at 12h positive (execution-aware)",
    12,
    "realizable_pnl",
    {
      implemented: false,
      schemaPresent: false,
      populatedByCanonicalBuilder: false,
      populatedByOfflineHistorical: false,
      trainableNow: false,
      scoringSupportedNow: false,
      implementationStatus: "scaffolded",
      gaps: ["Requires fill/slippage model; not yet computed."],
    }
  ),
  labelPositive6h: def(
    "labelPositive6h",
    "Positive forward return at 6h (recommendation ML)",
    6,
    "positive_return",
    {
      implemented: true,
      schemaPresent: false,
      populatedByCanonicalBuilder: true,
      populatedByOfflineHistorical: false,
      trainableNow: true,
      scoringSupportedNow: false,
      implementationStatus: "implemented",
    }
  ),
  labelPositive24h: def(
    "labelPositive24h",
    "Positive forward return at 24h (recommendation ML)",
    24,
    "positive_return",
    {
      implemented: true,
      schemaPresent: false,
      populatedByCanonicalBuilder: true,
      populatedByOfflineHistorical: false,
      trainableNow: true,
      scoringSupportedNow: false,
      implementationStatus: "implemented",
    }
  ),
  labelMissedOpportunity: def(
    "labelMissedOpportunity",
    "Missed opportunity (bad_block: we blocked, outcome was favorable)",
    null,
    "missed_opportunity",
    {
      implemented: true,
      schemaPresent: true,
      populatedByCanonicalBuilder: true,
      populatedByOfflineHistorical: true,
      trainableNow: true,
      scoringSupportedNow: true,
      implementationStatus: "implemented",
    }
  ),
};

export function getTargetDefinition(key: MlTargetKey): TargetDefinition {
  return ML_TARGET_REGISTRY[key];
}

/** Targets with implementationStatus === "implemented". */
export function getImplementedTargets(): MlTargetKey[] {
  return (Object.keys(ML_TARGET_REGISTRY) as MlTargetKey[]).filter(
    (k) => ML_TARGET_REGISTRY[k].implementationStatus === "implemented"
  );
}

/** Targets that are scaffolded or partial (not fully implemented). */
export function getScaffoldedTargets(): MlTargetKey[] {
  return (Object.keys(ML_TARGET_REGISTRY) as MlTargetKey[]).filter(
    (k) =>
      ML_TARGET_REGISTRY[k].implementationStatus === "scaffolded" ||
      ML_TARGET_REGISTRY[k].implementationStatus === "partial" ||
      ML_TARGET_REGISTRY[k].implementationStatus === "schema_only"
  );
}

/** Shadow targets that exist as columns on MlShadowTrainingExample. */
export function getShadowSchemaTargetKeys(): MlTargetKey[] {
  return (Object.keys(ML_TARGET_REGISTRY) as MlTargetKey[]).filter(
    (k) => ML_TARGET_REGISTRY[k].schemaPresent && isShadowSchemaLabelColumn(k)
  );
}
