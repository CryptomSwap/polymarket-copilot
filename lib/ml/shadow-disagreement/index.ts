/**
 * Advisory ML disagreement analysis: staged decision vs shadow ML scores.
 * Descriptive only; no runtime behavior change.
 */

export { runDisagreementAnalysis, getStagedCohort, getShadowBand } from "./analyze";
export type {
  StagedCohort,
  ShadowBand,
  CohortKey,
  CohortStats,
  DisagreementAnalysisFilters,
  DisagreementAnalysisResult,
  DisagreementSampleRow,
} from "./types";
