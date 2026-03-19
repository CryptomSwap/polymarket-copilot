/**
 * ML target registry and label building.
 */

export type { TargetDefinition, TargetObjectiveFamily, TargetImplementationStatus } from "./types";
export {
  ML_TARGET_REGISTRY,
  getTargetDefinition,
  getImplementedTargets,
  getScaffoldedTargets,
  getShadowSchemaTargetKeys,
} from "./registry";
export { ML_SHADOW_LABEL_COLUMNS, isShadowSchemaLabelColumn } from "./schema";
export type { ShadowSchemaLabelColumn } from "./schema";
export {
  validateTargetForTraining,
  validateActiveModelTarget,
  getShadowLabelColumnsForAudit,
} from "./validate";
export type { TargetValidationResult } from "./validate";
export {
  deriveLabels,
  deriveGoodDecisionFromMarkout,
  buildLabelForTarget,
} from "./build-labels";
