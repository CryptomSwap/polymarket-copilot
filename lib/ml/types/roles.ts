/**
 * ML score roles: ranking, probability, uncertainty/support.
 * Additive; existing shadow score remains the legacy single-score output.
 */

/** Role of an ML score output. */
export type MlScoreRole = "ranking" | "probability" | "uncertainty_support";

/** Human-readable role description. */
export const ML_SCORE_ROLE_DESCRIPTIONS: Record<MlScoreRole, string> = {
  ranking: "Relative prioritization among candidates",
  probability: "Interpretable P(good outcome) for a label horizon",
  uncertainty_support: "Confidence/support flags, low-density warnings, feature completeness",
};
