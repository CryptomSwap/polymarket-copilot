/**
 * Types for shadow ML training pipeline.
 * Uses MlShadowTrainingExample; model persisted as MlModelRun with modelType "logistic_regression_shadow".
 */

/** Supported training targets (binary labels from shadow dataset). Includes 6h/12h horizons. */
export type ShadowTargetLabel =
  | "labelGoodDecision"
  | "labelGoodDecision6h"
  | "labelGoodDecision12h"
  | "labelMissedOpportunity";

export interface TrainShadowOptions {
  funderAddress?: string;
  /** Filter by candidateSource (e.g. "offline_historical"). */
  candidateSource?: string;
  /** Max rows to load (default 2000). */
  limit?: number;
  createdAfter?: Date;
  createdBefore?: Date;
  /** Train ratio for time-based split (default 0.8). */
  trainRatio?: number;
  /** If true, log feature names and first 3 train vectors. */
  debug?: boolean;
  /** Drop constant/near-constant training columns before fitting. */
  dropConstantFeatures?: boolean;
  /** Variance threshold used when dropping near-constant columns. */
  nearConstantVarianceThreshold?: number;
  /** Balanced class weighting for imbalanced bootstrap labels. */
  classWeighting?: "none" | "balanced";
}

export interface TrainShadowResult {
  success: boolean;
  modelRunId?: string;
  targetLabel: ShadowTargetLabel;
  datasetSize: number;
  trainCount: number;
  validationCount: number;
  trainedFrom?: string | null;
  trainedTo?: string | null;
  validatedFrom?: string | null;
  validatedTo?: string | null;
  metrics?: {
    accuracy: number;
    precision: number;
    recall: number;
    f1: number;
    rocAuc: number;
  };
  featureImportance?: Array<{ name: string; coefficient: number; absCoefficient: number }>;
  trainingDiagnostics?: {
    classWeighting: "none" | "balanced";
    activeFeatureCount: number;
    droppedFeatureCount: number;
  };
  error?: string;
}
