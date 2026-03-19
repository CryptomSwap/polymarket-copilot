/**
 * Decision-stage boundary calibration: reviewable recommendations from shadow outcomes.
 * No auto-apply; descriptive and conservative.
 */

export * from "./types";
export {
  decisionSubtypeFromBlockReason,
  subtypesFromDecisionSnapshot,
  subtypesFromDecisionSnapshotJson,
  hasDecisionStageBlock,
  type DecisionSnapshotLike,
} from "./subtypes";
export {
  runDecisionStageCalibration,
  buildRecommendation,
  type DecisionCalibrationFilters,
} from "./analyze";
