/**
 * Validation and assertion helpers for target truth.
 * Use in training/report scripts to warn when target is scaffolded, empty, or mismatched with active model.
 */

import { getTargetDefinition, ML_TARGET_REGISTRY } from "./registry";
import type { MlTargetKey } from "@/lib/ml/types/targets";
import type { ShadowSchemaLabelColumn } from "./schema";
import { ML_SHADOW_LABEL_COLUMNS } from "./schema";

const REGISTRY_KEYS = new Set(Object.keys(ML_TARGET_REGISTRY) as MlTargetKey[]);

function getTargetDefinitionSafe(key: string): ReturnType<typeof getTargetDefinition> | undefined {
  return REGISTRY_KEYS.has(key as MlTargetKey) ? getTargetDefinition(key as MlTargetKey) : undefined;
}

export interface TargetValidationResult {
  targetKey: MlTargetKey;
  ok: boolean;
  warnings: string[];
  errors: string[];
}

/**
 * Validate a target before training: warn if scaffolded, partial, or zero population.
 */
export function validateTargetForTraining(
  targetKey: MlTargetKey,
  options: { populatedCount?: number; minRequired?: number }
): TargetValidationResult {
  const { populatedCount, minRequired = 10 } = options;
  const def = getTargetDefinition(targetKey);
  const warnings: string[] = [];
  const errors: string[] = [];

  if (def.implementationStatus === "scaffolded" || def.implementationStatus === "schema_only") {
    warnings.push(`Target ${targetKey} is ${def.implementationStatus}; training may fail or be unreliable.`);
  }
  if (def.implementationStatus === "partial") {
    warnings.push(
      `Target ${targetKey} is partial (e.g. only populated by offline-historical). Canonical build does not set it.`
    );
  }
  if (populatedCount != null) {
    if (populatedCount === 0) {
      errors.push(`Target ${targetKey} has zero populated rows; cannot train.`);
    } else if (populatedCount < minRequired) {
      warnings.push(
        `Target ${targetKey} has ${populatedCount} populated rows (below recommended ${minRequired}).`
      );
    }
  }
  if (!def.trainableNow) {
    errors.push(`Target ${targetKey} is not accepted by trainShadowModel (not in ShadowTargetLabel).`);
  }

  return {
    targetKey,
    ok: errors.length === 0,
    warnings,
    errors,
  };
}

/**
 * Check for mismatch: active model run claims to be trained on a target that has no canonical population.
 */
export function validateActiveModelTarget(
  activeTargetLabel: string,
  options: { hasCanonicalPopulation?: boolean }
): TargetValidationResult {
  const targetKey = activeTargetLabel as MlTargetKey;
  const def = getTargetDefinitionSafe(activeTargetLabel);
  const warnings: string[] = [];
  const errors: string[] = [];

  if (!def) {
    return {
      targetKey: targetKey as MlTargetKey,
      ok: false,
      warnings: [],
      errors: [`Active model target "${activeTargetLabel}" is not in the registry.`],
    };
  }

  if (def.implementationStatus === "scaffolded" || def.implementationStatus === "schema_only") {
    warnings.push(
      `Active model target ${activeTargetLabel} is ${def.implementationStatus}; model may have been trained on empty or synthetic data.`
    );
  }
  if (def.implementationStatus === "partial" && options.hasCanonicalPopulation === false) {
    warnings.push(
      `Active model target ${activeTargetLabel} is only populated by offline-historical; canonical build does not populate it.`
    );
  }

  return {
    targetKey,
    ok: true,
    warnings,
    errors,
  };
}

/**
 * Return shadow label columns that are valid for DB population counts (schema columns).
 */
export function getShadowLabelColumnsForAudit(): readonly ShadowSchemaLabelColumn[] {
  return ML_SHADOW_LABEL_COLUMNS;
}
