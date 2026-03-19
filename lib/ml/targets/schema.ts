/**
 * Single source of truth: which label columns exist on MlShadowTrainingExample (Prisma schema).
 * Used by audit and registry to avoid drift. Do not add a key here unless the column exists in schema.
 */

/** Label columns that physically exist on MlShadowTrainingExample (prisma schema). Keep in sync with schema.prisma. */
export const ML_SHADOW_LABEL_COLUMNS = [
  "labelGoodDecision",
  "labelGoodDecision6h",
  "labelGoodDecision12h",
  "labelBadDecision",
  "labelMissedOpportunity",
  "labelExecutionUnsafe",
] as const;

export type ShadowSchemaLabelColumn = (typeof ML_SHADOW_LABEL_COLUMNS)[number];

export function isShadowSchemaLabelColumn(key: string): key is ShadowSchemaLabelColumn {
  return (ML_SHADOW_LABEL_COLUMNS as readonly string[]).includes(key);
}
