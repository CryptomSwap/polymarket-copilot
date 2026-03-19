/**
 * Shadow threshold calibration and outcome analysis types.
 * Descriptive only; no automatic parameter mutation.
 */

export type CalibrationSuggestion =
  | "review_threshold"   // High bad_block rate or pattern suggests threshold may be too strict
  | "keep_strict"        // High good_block rate suggests block is beneficial
  | "insufficient_data"  // Too few evaluated candidates to suggest
  | "monitor";           // Neutral; keep monitoring

export interface ShadowGateStats {
  /** Gate / reason group label (e.g. execution_quality, guardrail). */
  gate: string;
  /** Total candidates that had this gate as a blocking reason (blocked only). */
  blockedCount: number;
  /** Evaluated among blocked with this reason. */
  evaluatedCount: number;
  goodBlockCount: number;
  badBlockCount: number;
  /** Average 24h markout among evaluated blocked (good_block negative, bad_block positive typically). */
  averageMarkout24h: number | null;
  /** Raw reason strings that map to this gate (sample). */
  rawReasonSamples: string[];
}

export interface ShadowReasonStats {
  /** Normalized reason group. */
  reasonGroup: string;
  /** Total occurrences (blocked candidates that had this reason). */
  totalBlocked: number;
  evaluatedBlocked: number;
  goodBlocks: number;
  badBlocks: number;
  /** Allowed candidates (no primary block reason; for allowed we track by source or overall). */
  allowedCount: number;
  evaluatedAllowed: number;
  goodAllows: number;
  badAllows: number;
  averageMarkout24hBlocked: number | null;
  averageMarkout24hAllowed: number | null;
  rawSamples: string[];
}

export interface ShadowThresholdCalibrationReport {
  /** Suggested action for this gate/reason. */
  suggestion: CalibrationSuggestion;
  reasonGroup: string;
  /** Human-readable summary. */
  summary: string;
  /** Counts that drove the suggestion. */
  goodBlockCount: number;
  badBlockCount: number;
  evaluatedCount: number;
  /** Minimum evaluated count to suggest review_threshold or keep_strict. */
  minEvaluatedForSuggestion: number;
}

export interface ShadowAnalysisSummary {
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
  /** By normalized reason group (blocked only). */
  byReasonGroup: Record<string, ShadowReasonStats>;
  /** By candidateSource. */
  bySource: Record<string, { total: number; blocked: number; allowed: number; evaluated: number; goodBlock: number; badBlock: number; goodAllow: number; badAllow: number }>;
  /** Calibration suggestions (descriptive; do not auto-apply). */
  calibrationSuggestions: ShadowThresholdCalibrationReport[];
  /** Warning-only: allowed but had warnings (inferred from execution policy snapshot when present). Not all records have this. */
  warningOnlyAllowedCount: number;
  warningOnlyEvaluatedCount: number;
  warningOnlyGoodAllowCount: number;
  warningOnlyBadAllowCount: number;
}

export interface ShadowAnalysisFilters {
  funderAddress?: string;
  minCandidates?: number;
  onlyEvaluated?: boolean;
  source?: string;
  reasonGroup?: string;
}
