/**
 * Types for shadow-candidate ML training examples.
 * Feature groups and labels are explicit; no implicit parsing.
 */

/** Outcome classification from shadow evaluation (good_block | bad_block | good_allow | bad_allow). */
export type OutcomeClassification = "good_block" | "bad_block" | "good_allow" | "bad_allow";

/** One ML-ready row derived from a ShadowCandidate + snapshots. */
export interface ShadowTrainingRow {
  // Identifiers / linkage
  shadowCandidateId: string;
  funderAddress: string;
  recommendationId: string | null;
  orderIntentId: string | null;
  assetId: string;
  marketId: string | null;
  candidateSource: string;
  createdAt: Date;

  // A. decision-stage features
  policyState: string | null;
  sizeMultiplier: string | null;
  finalSuggestedSize: string | null;
  eligibilityBlockersCount: number;
  reducedSizeIndicator: boolean;
  blockedIndicator: boolean;

  // B. execution-policy features
  executionAllow: boolean | null;
  executionBlockingReasonGroups: string | null;
  executionWarningCount: number;

  // C. execution-quality features
  qualityState: string | null;
  spreadBps: string | null;
  estimatedSlippage: string | null;
  depthSufficiency: string | null;
  quoteFreshnessState: string | null;
  tradable: boolean | null;

  // D. portfolio-risk features
  grossExposure: string | null;
  totalOpenExposure: string | null;
  workingOrderExposure: string | null;
  maxSingleMarketConcentrationPct: string | null;
  maxSingleThemeConcentrationPct: string | null;
  worstCaseLossEstimate: string | null;
  nearResolutionExposure: string | null;
  illiquidExposureEstimate: string | null;
  correlatedExposureEstimate: string | null;
  portfolioRiskFlagsCount: number;

  // E. runtime-safety features
  runtimeSafetyState: string | null;
  runtimeWarningCount: number;
  runtimeBlockingCount: number;

  // F. simple market / candidate features
  side: string;
  intendedPrice: string;
  intendedSize: string;
  recommendationPresent: boolean;
  outcomeBlockedVsAllowedVsSubmitted: "blocked" | "allowed" | "submitted" | null;

  // Labels / outcomes
  markout1h: string | null;
  markout6h: string | null;
  markout12h: string | null;
  markout24h: string | null;
  outcomeClassification: OutcomeClassification | null;
  wasBlocked: boolean;
  wasSubmitted: boolean;
  wasFilled: boolean | null;
  labelGoodDecision: boolean | null;
  /** 12h horizon good-decision label (paper-trading horizon). May be null if 12h markout not computable. */
  labelGoodDecision12h: boolean | null;
  labelBadDecision: boolean | null;
  labelMissedOpportunity: boolean | null;
  labelExecutionUnsafe: boolean | null;
}

/** How to choose which ShadowCandidates to visit each run (bounded). */
export type DatasetCandidateSelectionMode = "sequential" | "prefer_missing_12h_label";

export interface BuildShadowTrainingExamplesOptions {
  funderAddress?: string;
  limit?: number;
  /** Only include candidates created on or after this date. */
  createdAfter?: Date;
  /** Only include candidates created on or before this date. */
  createdBefore?: Date;
  /**
   * If true (default), only ShadowCandidate rows with evaluatedAt != null.
   * Evaluation is performed by evaluateShadowCandidates(); outcomeClassification may still be null
   * when 24h markout prices are missing (labelGoodDecision stays null until classification is set).
   */
  evaluatedOnly?: boolean;
  /**
   * sequential: legacy cursor walk by createdAt (always starts from oldest — can starve newer rows when limit is small).
   * prefer_missing_12h_label: bounded SQL selection of candidates missing truthful 12h label (or no ML row yet), then optional fill.
   * Primary selection does not require evaluatedAt (12h truth is snapshot-based); fill still respects evaluatedOnly when topping up.
   */
  datasetCandidateSelection?: DatasetCandidateSelectionMode;
  /** Min age before a candidate is eligible for truthful 12h labeling (default 12h). */
  minAgeMsFor12hLabel?: number;
  /**
   * Prefer strict PaperTrade linkage for 12h labels (recommendationId+assetId+side within join lag window).
   * Falls back to snapshot-derived markout12h when no strict link exists.
   */
  strictPaperLabelJoin?: boolean;
  /** Max lag between ShadowCandidate.createdAt and PaperTrade.entryTime for strict linkage (default 60m). */
  strictPaperJoinMaxLagMs?: number;
}

export interface BuildShadowTrainingExamplesResult {
  examplesBuilt: number;
  examplesSkipped: number;
  errors: string[];
}

export interface PersistShadowTrainingExamplesOptions extends BuildShadowTrainingExamplesOptions {
  /** Skip persisting; just return rows (e.g. for dry run). */
  dryRun?: boolean;
}

export interface PersistShadowTrainingExamplesResult extends BuildShadowTrainingExamplesResult {
  persisted: number;
}
