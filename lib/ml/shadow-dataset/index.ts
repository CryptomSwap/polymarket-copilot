/**
 * Shadow-to-ML dataset pipeline: build and persist ML-ready examples from ShadowCandidate rows.
 * Advisory only; does not change live trading behavior.
 */

export {
  buildShadowTrainingRow,
  buildShadowTrainingExamples,
  persistShadowTrainingExamples,
} from "./build";
export type {
  ShadowTrainingRow,
  OutcomeClassification,
  BuildShadowTrainingExamplesOptions,
  BuildShadowTrainingExamplesResult,
  PersistShadowTrainingExamplesOptions,
  PersistShadowTrainingExamplesResult,
} from "./types";
