/**
 * Types for advisory ML disagreement analysis: staged decision vs shadow ML scores.
 * Descriptive only; no runtime behavior change.
 */

/** Staged decision outcome cohort. */
export type StagedCohort = "staged_block" | "staged_allow" | "staged_reduce";

/** Shadow ML score band (from advisory score). */
export type ShadowBand = "low" | "medium" | "high";

export type OutcomeClassification = "good_block" | "bad_block" | "good_allow" | "bad_allow";

/** One cohort bucket: (staged_cohort, shadow_band). */
export interface CohortKey {
  stagedCohort: StagedCohort;
  shadowBand: ShadowBand;
}

/** Counts and averages for a single cohort. */
export interface CohortStats {
  cohortKey: CohortKey;
  total: number;
  evaluated: number;
  goodBlock: number;
  badBlock: number;
  goodAllow: number;
  badAllow: number;
  averageMarkout24h: number | null;
  /** When outcomes favor staged decision (e.g. we blocked and good_block). */
  stagedRightCount: number;
  /** When outcomes favor shadow signal (e.g. we blocked and bad_block → missed opportunity). */
  shadowRightCount: number;
  /** Short label for usefulness: who was more often right in this cohort. */
  usefulnessSummary: "staged_more_right" | "shadow_more_right" | "tie" | "insufficient";
}

/** Sample row for API (no PII). */
export interface DisagreementSampleRow {
  shadowCandidateId: string;
  stagedCohort: StagedCohort;
  shadowBand: ShadowBand;
  shadowScore: number;
  outcomeClassification: OutcomeClassification | null;
  markout24h: number | null;
  candidateSource: string;
  createdAt: string;
}

export interface DisagreementAnalysisFilters {
  funderAddress?: string;
  candidateSource?: string;
  shadowBand?: ShadowBand;
  stagedCohort?: StagedCohort;
  limit?: number;
}

export interface DisagreementAnalysisResult {
  /** Model id used for scoring (or null if no model). */
  modelId: string | null;
  cohortStats: CohortStats[];
  /** Overall agreement: staged and shadow aligned (e.g. block+low, allow+high). */
  agreementRate: number | null;
  /** Overall disagreement rate. */
  disagreementRate: number | null;
  totalRows: number;
  evaluatedRows: number;
  recentSamples: DisagreementSampleRow[];
  /** Advisory-only: no execution change. */
  advisoryOnly: true;
}
