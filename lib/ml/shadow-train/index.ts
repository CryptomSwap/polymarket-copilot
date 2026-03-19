/**
 * Shadow ML training: train on MlShadowTrainingExample, persist as MlModelRun (modelType logistic_regression_shadow).
 * Advisory only; does not change execution behavior.
 */

export { trainShadowModel, SHADOW_MODEL_TYPE } from "./train";
export { toShadowFeatureVector, SHADOW_FEATURE_NAMES, SHADOW_FEATURE_SET_V1 } from "./features";
export type { ShadowTargetLabel, TrainShadowOptions, TrainShadowResult } from "./types";
export type { ShadowFeatureInput } from "./features";
