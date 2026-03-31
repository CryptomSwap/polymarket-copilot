/**
 * Stable join key for ShadowCandidate ↔ PaperTrade.metadataJson ↔ MlShadowTrainingExample.
 * When upstream omits recommendationId, paper trading uses `shadow:<shadowCandidateId>` (see load path).
 */

export function effectiveRecommendationIdForShadowCandidate(
  shadowCandidateId: string,
  recommendationId: string | null | undefined
): string {
  const t = recommendationId?.trim();
  return t || `shadow:${shadowCandidateId}`;
}

/** Align with paper-trading candidate load: BUY / SELL only. */
export function normalizeShadowSideForJoin(side: string): "BUY" | "SELL" {
  return side.toUpperCase() === "SELL" ? "SELL" : "BUY";
}
