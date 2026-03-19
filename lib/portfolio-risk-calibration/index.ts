/**
 * Portfolio-risk threshold calibration: reviewable recommendations from shadow outcomes.
 * No auto-apply; descriptive and conservative.
 */

export * from "./types";
export {
  portfolioRiskSubtypeFromRaw,
  subtypesFromBlockingReasons,
  hasPortfolioRiskBlock,
  subtypesFromPortfolioRiskSnapshot,
} from "./subtypes";
export {
  runPortfolioRiskCalibration,
  buildRecommendation,
  type RiskCalibrationFilters,
} from "./analyze";
