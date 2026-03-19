/**
 * Model variant types for champion/challenger.
 * Champion = current active default; challenger = alternate target/calibration/feature set.
 */

import type { MlScoreBundle } from "./types/scoring";

export type ModelVariantRole = "champion" | "challenger";

export interface ModelVariantDescriptor {
  variantId: string;
  role: ModelVariantRole;
  targetLabel?: string;
  featureSet?: string;
  description?: string;
}

export interface ChampionChallengerComparison {
  candidateId: string;
  champion: MlScoreBundle | null;
  challengers: Array<{ descriptor: ModelVariantDescriptor; bundle: MlScoreBundle }>;
  /** Simple comparison summary (e.g. score diff). */
  summary?: {
    championScore?: number;
    bestChallengerScore?: number;
    scoreDelta?: number;
  };
}
