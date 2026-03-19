/**
 * Post-trade evaluation: markouts, outcome classification, summary for shadow candidates.
 */

export * from "./types";
export {
  evaluateShadowCandidates,
  getShadowEvaluationSummary,
  getShadowCandidatesSample,
  type EvaluateShadowOptions,
} from "./evaluate";
