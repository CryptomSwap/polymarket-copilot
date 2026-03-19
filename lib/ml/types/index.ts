/**
 * ML types: roles, targets, scoring bundle.
 * Additive interfaces for multi-role ML evolution.
 */

export type { MlScoreRole } from "./roles";
export { ML_SCORE_ROLE_DESCRIPTIONS } from "./roles";
export type { MlTargetKey } from "./targets";
export { getTargetHorizonHours } from "./targets";
export type { MlScoreBundle, SupportMetrics } from "./scoring";
export { fromLegacyShadowScore } from "./scoring";
