/**
 * Target and label definition types for the ML target registry.
 */

import type { MlTargetKey } from "@/lib/ml/types/targets";

/** Objective family for grouping targets. */
export type TargetObjectiveFamily =
  | "good_decision"
  | "positive_return"
  | "spread_adjusted"
  | "realizable_pnl"
  | "missed_opportunity";

/**
 * Implementation status: unambiguous truth about whether a target is usable end-to-end.
 * - implemented: schema + populated by at least one canonical path + trainable
 * - partial: schema + populated by offline/historical only (or only some paths)
 * - scaffolded: schema may exist but not populated by any builder, or only in code
 * - schema_only: column exists, never populated by any current builder
 */
export type TargetImplementationStatus =
  | "implemented"
  | "partial"
  | "scaffolded"
  | "schema_only";

export interface TargetDefinition {
  key: MlTargetKey;
  description: string;
  horizonHours: number | null;
  objectiveFamily: TargetObjectiveFamily;
  /** @deprecated Use implementationStatus and population flags instead. */
  implemented: boolean;
  /** If scaffolded/partial, document gaps. */
  gaps?: string[];

  // --- Explicit truth (additive) ---
  /** Column exists on MlShadowTrainingExample (or N/A for recommendation-only targets). */
  schemaPresent: boolean;
  /** Populated by canonical shadow build (build.ts persistShadowTrainingExamples). */
  populatedByCanonicalBuilder: boolean;
  /** Populated by offline-historical path (offline-historical.ts). */
  populatedByOfflineHistorical: boolean;
  /** trainShadowModel() accepts this target and will load rows where this column is not null. */
  trainableNow: boolean;
  /** Active shadow scorer can load a run trained on this target (scoring is target-agnostic). */
  scoringSupportedNow: boolean;
  /** Single unambiguous status. */
  implementationStatus: TargetImplementationStatus;
}
