/**
 * Execution-quality threshold calibration: reviewable recommendations from shadow outcomes.
 * No auto-apply; descriptive and conservative.
 */

export * from "./types";
export {
  executionQualitySubtypeFromRaw,
  subtypesFromBlockingReasons,
  subtypesFromWarnings,
  hasExecutionQualityBlock,
  snapshotHasEqWarnings,
} from "./subtypes";
export {
  runExecutionQualityCalibration,
  buildRecommendation,
  type EqCalibrationFilters,
} from "./analyze";
