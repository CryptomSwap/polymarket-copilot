/**
 * Execution policy: formal pre-trade gate types.
 * Single deterministic evaluator; no alpha scoring; fail closed when critical data is missing.
 */

export type ExecutionPolicyState = "allow" | "warn" | "block";

/** Result of the execution policy evaluation. Auditable, no hidden weighting. */
export interface ExecutionPolicyResult {
  /** If false, order must not be submitted. */
  allow: boolean;
  /** allow | warn: proceed with optional warnings; block: do not submit. */
  policyState: ExecutionPolicyState;
  /** Reasons that caused a block. Empty when allow is true. */
  blockingReasons: string[];
  /** Non-blocking issues to surface (e.g. soft freshness). */
  warnings: string[];
  /** ISO timestamp when evaluation ran. */
  evaluatedAt: string;
  /** Per-category check outcomes for audit. */
  checks: ExecutionPolicyChecks;
  /** Safe to persist (e.g. OrderIntent.executionPolicySnapshotJson). No secrets. */
  snapshotJson: string;
}

export interface ExecutionPolicyChecks {
  /** Market/data/user/reconcile freshness; decision snapshot age if provided. */
  freshness: FreshnessCheck;
  /** Position/market/theme concentration; growth from this order if derivable. */
  exposure: ExposureCheck;
  /** Market tradable, spread, depth, price context, near-resolution. */
  liquidity: LiquidityCheck;
  /** Side/size/price validity, limit band, slippage, zero/NaN rejection. */
  pricing: PricingCheck;
  /** Kill switch, runtime degraded, reconciliation drift, credentials, market/asset resolution. */
  operationalSafety: OperationalSafetyCheck;
  /** Blocked recommendation, stale decision, missing rationale/confidence, not executable. */
  recommendationQuality: RecommendationQualityCheck;
}

export interface FreshnessCheck {
  pass: boolean;
  /** Block reason when pass is false. */
  blockReason?: string;
  marketDataFresh?: boolean;
  userDataFresh?: boolean;
  reconciliationFresh?: boolean;
  decisionSnapshotFresh?: boolean;
  /** Max age ms of decision snapshot if applicable. */
  decisionSnapshotAgeMs?: number;
  /** Runtime phase at evaluation time. */
  runtimePhase?: string;
}

export interface ExposureCheck {
  pass: boolean;
  blockReason?: string;
  /** Current gross exposure vs limit. */
  grossExposureVsLimit?: { current: number; limit: number };
  /** Per-asset notional vs limit. */
  perAssetVsLimit?: { current: number; limit: number; assetId: string };
  /** Working order count vs limit. */
  workingOrdersVsLimit?: { current: number; limit: number };
  /** Concentration growth from this order (if derivable). */
  concentrationGrowthFromOrder?: string;
  /** Single-market concentration vs limit (from portfolio risk snapshot). */
  singleMarketConcentrationVsLimit?: { current: number; limit: number };
  /** Single-theme concentration vs limit (from portfolio risk snapshot). */
  singleThemeConcentrationVsLimit?: { current: number; limit: number };
}

export interface LiquidityCheck {
  pass: boolean;
  blockReason?: string;
  marketStale?: boolean;
  marketInactive?: boolean;
  spreadTooWide?: boolean;
  insufficientDepth?: boolean;
  missingPriceContext?: boolean;
  notTradable?: boolean;
  /** When execution-quality result is present and blocks. */
  executionQualityBlock?: boolean;
}

export interface PricingCheck {
  pass: boolean;
  blockReason?: string;
  invalidSide?: boolean;
  invalidSize?: boolean;
  invalidPrice?: boolean;
  priceOutOfBand?: boolean;
  zeroOrNegativeOrNaN?: boolean;
}

export interface OperationalSafetyCheck {
  pass: boolean;
  blockReason?: string;
  killSwitchActive?: boolean;
  runtimeDegraded?: boolean;
  reconciliationDrift?: boolean;
  unresolvedAnomalies?: boolean;
  missingCredentials?: boolean;
  missingMarketOrAssetResolution?: boolean;
  executionFrozenForAsset?: boolean;
}

export interface RecommendationQualityCheck {
  pass: boolean;
  blockReason?: string;
  recommendationBlocked?: boolean;
  blockedReason?: string;
  staleDecisionSnapshot?: boolean;
  missingRationaleOrConfidence?: boolean;
  notInExecutableState?: boolean;
}

/** Input to the execution policy evaluator. All optional fields: missing => fail closed where critical. */
export interface ExecutionPolicyInput {
  /** Order parameters (required for sanity checks). */
  order: {
    side: string;
    size: number;
    limitPrice: number;
    assetId: string;
    marketId: string;
    funderAddress: string;
  };
  /** Freshness flags (missing => block for new entry). */
  freshness?: {
    marketDataFresh?: boolean;
    userDataFresh?: boolean;
    reconciliationFresh?: boolean;
    runtimePhase?: string;
    /** Decision snapshot timestamp if applicable; stale => block. */
    decisionSnapshotAt?: Date | null;
    decisionSnapshotMaxAgeMs?: number;
  };
  /** Exposure / risk state. From portfolio risk snapshot when available. */
  exposure?: {
    grossExposure?: number;
    maxTotalExposure?: number;
    perAssetNotional?: number;
    maxNotionalPerAsset?: number;
    workingOrderCount?: number;
    maxWorkingOrders?: number;
    /** Max single-market concentration % (0–100). Block when current exceeds limit. */
    maxSingleMarketConcentrationPct?: number;
    currentSingleMarketConcentrationPct?: number;
    /** Max single-theme concentration % (0–100). Block when current exceeds limit. */
    maxSingleThemeConcentrationPct?: number;
    currentSingleThemeConcentrationPct?: number;
    /** Near-resolution exposure; warn or block when policy uses it. */
    nearResolutionExposure?: number;
    totalOpenExposure?: number;
  };
  /** Market/liquidity context (from asset live state). */
  liquidity?: {
    marketStale?: boolean;
    marketDegraded?: boolean;
    isTradable?: boolean;
    liquidityQualityScore?: number;
    minLiquidityQualityScore?: number;
    spreadBps?: number;
    minSpreadBps?: number;
  };
  /** Operational state. */
  operational?: {
    killSwitchActive?: boolean;
    runtimeDegraded?: boolean;
    reconciliationDrift?: boolean;
    exchangeTruthUnavailable?: boolean;
    executionFrozenAssetIds?: ReadonlySet<string> | string[];
    /** Asset under evaluation. */
    assetId?: string;
    missingCredentials?: boolean;
    missingMarketOrAssetResolution?: boolean;
    /** From runtime safety state machine: block when "blocked" or "kill_switch". */
    runtimeSafetyState?: "normal" | "degraded" | "blocked" | "kill_switch";
  };
  /** Recommendation / decision quality (e.g. from strategy or approval flow). */
  recommendation?: {
    blocked?: boolean;
    blockedReason?: string | null;
    decisionSnapshotAt?: Date | null;
    decisionSnapshotMaxAgeMs?: number;
    hasRationale?: boolean;
    hasConfidence?: boolean;
    executable?: boolean;
  };
  /** Price band for limit (e.g. 0–1 for probability markets). */
  priceBand?: { min: number; max: number };
  /**
   * Optional result from execution-quality evaluation (spread, depth, slippage, quote freshness).
   * When present and qualityState is "block", policy blocks and adds execution-quality blocking reasons.
   */
  executionQuality?: {
    qualityState: "good" | "warn" | "block";
    blockingReasons: string[];
    warnings: string[];
  };
}
