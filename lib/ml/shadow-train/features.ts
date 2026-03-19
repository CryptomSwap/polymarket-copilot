/**
 * Shadow feature vector: same order for training (MlShadowTrainingExample) and scoring (candidate context).
 * Conservative: numeric and simple encodings; missing -> 0.
 */

export const SHADOW_FEATURE_SET_V1 = "shadow_v1";

const POLICY_STATE_ENC: Record<string, number> = { allow: 1, warn: 2, block: 3 };
const QUALITY_STATE_ENC: Record<string, number> = { good: 1, warn: 2, block: 3 };
const OUTCOME_ENC: Record<string, number> = { blocked: 1, allowed: 2, submitted: 3 };

function parseNum(s: string | number | null | undefined): number {
  if (s == null || s === "") return 0;
  if (typeof s === "number") return Number.isFinite(s) ? s : 0;
  const n = parseFloat(String(s).trim());
  return Number.isFinite(n) ? n : 0;
}

function enc(state: string | null | undefined, map: Record<string, number>): number {
  if (state == null) return 0;
  const v = map[String(state).toLowerCase()];
  return v ?? 0;
}

/** Input shape for feature vector (training row or scoring context). outcomeBlockedVsAllowedVsSubmitted can be null when scoring. */
export interface ShadowFeatureInput {
  policyState?: string | null;
  sizeMultiplier?: string | null;
  finalSuggestedSize?: string | null;
  eligibilityBlockersCount?: number;
  reducedSizeIndicator?: boolean;
  blockedIndicator?: boolean;
  executionAllow?: boolean | null;
  executionWarningCount?: number;
  qualityState?: string | null;
  spreadBps?: string | null;
  estimatedSlippage?: string | null;
  tradable?: boolean | null;
  grossExposure?: string | null;
  totalOpenExposure?: string | null;
  maxSingleMarketConcentrationPct?: string | null;
  maxSingleThemeConcentrationPct?: string | null;
  portfolioRiskFlagsCount?: number;
  runtimeWarningCount?: number;
  runtimeBlockingCount?: number;
  intendedPrice?: string | null;
  intendedSize?: string | null;
  recommendationPresent?: boolean;
  side?: string | null;
  outcomeBlockedVsAllowedVsSubmitted?: "blocked" | "allowed" | "submitted" | null;
  // Historical-only (offline dataset)
  momentum1hBps?: string | null;
  momentum6hBps?: string | null;
  volatility1hBps?: string | null;
  volatility6hBps?: string | null;
  distanceFromMid?: string | null;
  timeToCloseHours?: string | null;
  liquidityTrend?: string | null;
}

export const SHADOW_FEATURE_NAMES: string[] = [
  "sizeMultiplier",
  "finalSuggestedSize",
  "eligibilityBlockersCount",
  "reducedSizeIndicator",
  "blockedIndicator",
  "executionAllow",
  "executionWarningCount",
  "qualityStateEnc",
  "spreadBps",
  "estimatedSlippage",
  "tradable",
  "grossExposure",
  "totalOpenExposure",
  "maxSingleMarketConcentrationPct",
  "maxSingleThemeConcentrationPct",
  "portfolioRiskFlagsCount",
  "runtimeWarningCount",
  "runtimeBlockingCount",
  "intendedPrice",
  "intendedSize",
  "recommendationPresent",
  "sideEnc",
  "policyStateEnc",
  "outcomeBlockedVsAllowedVsSubmittedEnc",
  "momentum1hBps",
  "momentum6hBps",
  "volatility1hBps",
  "volatility6hBps",
  "distanceFromMid",
  "timeToCloseHours",
  "liquidityTrend",
];

/**
 * Build numeric feature vector from a training row or scoring context.
 * Same order as SHADOW_FEATURE_NAMES. Missing values -> 0. For scoring, pass outcomeBlockedVsAllowedVsSubmitted 0 or omit (encoded as 0).
 */
export function toShadowFeatureVector(row: ShadowFeatureInput): number[] {
  const outcomeEnc = row.outcomeBlockedVsAllowedVsSubmitted
    ? (OUTCOME_ENC[row.outcomeBlockedVsAllowedVsSubmitted] ?? 0)
    : 0;
  return [
    parseNum(row.sizeMultiplier),
    parseNum(row.finalSuggestedSize),
    Number(row.eligibilityBlockersCount) ?? 0,
    row.reducedSizeIndicator ? 1 : 0,
    row.blockedIndicator ? 1 : 0,
    row.executionAllow === true ? 1 : 0,
    Number(row.executionWarningCount) ?? 0,
    enc(row.qualityState, QUALITY_STATE_ENC),
    parseNum(row.spreadBps),
    parseNum(row.estimatedSlippage),
    row.tradable === true ? 1 : 0,
    parseNum(row.grossExposure),
    parseNum(row.totalOpenExposure),
    parseNum(row.maxSingleMarketConcentrationPct),
    parseNum(row.maxSingleThemeConcentrationPct),
    Number(row.portfolioRiskFlagsCount) ?? 0,
    Number(row.runtimeWarningCount) ?? 0,
    Number(row.runtimeBlockingCount) ?? 0,
    parseNum(row.intendedPrice),
    parseNum(row.intendedSize),
    row.recommendationPresent ? 1 : 0,
    (row.side ?? "").toUpperCase() === "BUY" ? 1 : 0,
    enc(row.policyState, POLICY_STATE_ENC),
    outcomeEnc,
    parseNum(row.momentum1hBps),
    parseNum(row.momentum6hBps),
    parseNum(row.volatility1hBps),
    parseNum(row.volatility6hBps),
    parseNum(row.distanceFromMid),
    parseNum(row.timeToCloseHours),
    parseNum(row.liquidityTrend),
  ];
}
