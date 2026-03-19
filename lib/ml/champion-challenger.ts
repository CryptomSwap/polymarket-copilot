/**
 * Champion/challenger: run multiple ML scoring variants side by side on same candidates.
 * No change to default production decision path unless explicitly enabled.
 */

import type { ChampionChallengerComparison, ModelVariantDescriptor } from "./variant-types";
import type { MlScoreBundle } from "./types/scoring";

/**
 * Build a comparison record for one candidate: champion score bundle + optional challenger bundles.
 * Scaffolded: parallel scoring requires loading multiple models; this is the type and helper shape.
 */
export function buildChampionChallengerComparison(
  candidateId: string,
  championBundle: MlScoreBundle | null,
  challengerBundles: Array<{ descriptor: ModelVariantDescriptor; bundle: MlScoreBundle }>
): ChampionChallengerComparison {
  const championScore = championBundle?.rankingScore ?? championBundle?.probabilityScore;
  const challengerScores = challengerBundles.map(
    (c) => c.bundle.rankingScore ?? c.bundle.probabilityScore
  ).filter((s): s is number => typeof s === "number");
  const bestChallengerScore = challengerScores.length > 0 ? Math.max(...challengerScores) : undefined;
  return {
    candidateId,
    champion: championBundle,
    challengers: challengerBundles,
    summary:
      championScore != null || bestChallengerScore != null
        ? {
            championScore: championScore ?? undefined,
            bestChallengerScore,
            scoreDelta:
              championScore != null && bestChallengerScore != null
                ? bestChallengerScore - championScore
                : undefined,
          }
        : undefined,
  };
}
