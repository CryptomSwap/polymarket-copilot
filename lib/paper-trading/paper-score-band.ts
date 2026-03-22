/**
 * Score bands for shadow probability at paper open / analytics.
 * Must stay aligned with lib/ml/shadow-score/score-live.ts band cutoffs.
 */

export type PaperScoreBand = "low" | "medium" | "high";

export function scoreBandFromShadowProba(proba: number): PaperScoreBand {
  if (!Number.isFinite(proba)) return "low";
  if (proba >= 0.6) return "high";
  if (proba >= 0.4) return "medium";
  return "low";
}
