/**
 * Shadow ML training: train on MlShadowTrainingExample, persist as MlModelRun (modelType logistic_regression_shadow).
 * Advisory only; does not change execution behavior.
 */

export { trainShadowModel, SHADOW_MODEL_TYPE } from "./train";
export { toShadowFeatureVector, SHADOW_FEATURE_NAMES, SHADOW_FEATURE_SET_V1 } from "./features";
export {
  toShadowFeatureVectorV1Micro,
  SHADOW_FEATURE_NAMES_V1_MICRO,
  SHADOW_FEATURE_SET_V1_MICRO,
  SHADOW_MICRO_SUFFIX_NAMES,
} from "./features-shadow-v1-micro";
export type { ShadowFeatureInputMicro } from "./features-shadow-v1-micro";
export type { ShadowTargetLabel, TrainShadowOptions, TrainShadowResult } from "./types";
export type { ShadowFeatureInput } from "./features";
