/**
 * Post-trade evaluation: outcome classification and markout types.
 */

export type OutcomeClassification = "good_block" | "bad_block" | "good_allow" | "bad_allow";

export interface ShadowCandidateRow {
  id: string;
  funderAddress: string;
  recommendationId: string | null;
  orderIntentId: string | null;
  assetId: string;
  marketId: string | null;
  side: string;
  intendedPrice: string;
  intendedSize: string;
  candidateSource: string;
  wasBlocked: boolean;
  wasSubmitted: boolean;
  wasFilled: boolean | null;
  createdAt: Date;
  evaluatedAt: Date | null;
  markout1h: string | null;
  markout6h: string | null;
  markout24h: string | null;
  outcomeClassification: string | null;
  evaluationNotes: string | null;
}

export interface EvaluateShadowCandidateResult {
  id: string;
  evaluated: boolean;
  markout1h: number | null;
  markout6h: number | null;
  markout24h: number | null;
  outcomeClassification: OutcomeClassification | null;
  evaluationNotes: string | null;
}

export interface ShadowEvaluationSummary {
  totalCandidates: number;
  blockedCandidates: number;
  allowedCandidates: number;
  evaluatedCandidates: number;
  goodBlocks: number;
  badBlocks: number;
  goodAllows: number;
  badAllows: number;
  averageMarkout1h: number | null;
  averageMarkout6h: number | null;
  averageMarkout24h: number | null;
  byClassification: Record<string, number>;
}
