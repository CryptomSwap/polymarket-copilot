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
  /** Quote snapshot from execution-quality persistence; not part of SHADOW_FEATURE_NAMES / toShadowFeatureVector. */
  quoteBestBid?: number | null;
  quoteBestAsk?: number | null;
  quoteMidPrice?: number | null;
  outcomeBlockedVsAllowedVsSubmitted?: "blocked" | "allowed" | "submitted" | null;
  // Historical-only (offline dataset)
  momentum1hBps?: string | null;
  momentum6hBps?: string | null;
  volatility1hBps?: string | null;
  volatility6hBps?: string | null;
  distanceFromMid?: string | null;
  timeToCloseHours?: string | null;
  liquidityTrend?: string | null;
  // V2 decision-filter context (optional; defaults keep compatibility)
  scoreThresholdGap?: string | number | null;
  probabilityBand?: string | null;
  entryPriceBand?: string | null;
  botType?: string | null;
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
  "scoreThresholdGap",
  "probabilityBandLow",
  "probabilityBandMid",
  "probabilityBandHigh",
  "entryPriceBandEnc",
  "botTypeEnc",
];

function probabilityBandOneHot(rawBand: string | null | undefined, intendedPrice: string | null | undefined): [number, number, number] {
  let band = (rawBand ?? "").toLowerCase().trim();
  if (!band) {
    const p = parseNum(intendedPrice);
    if (p <= 0.2) band = "low";
    else if (p >= 0.8) band = "high";
    else band = "mid";
  }
  return [band === "low" ? 1 : 0, band === "mid" ? 1 : 0, band === "high" ? 1 : 0];
}

function encodeEntryPriceBand(raw: string | null | undefined, intendedPrice: string | null | undefined): number {
  const s = (raw ?? "").toLowerCase().trim();
  if (s) {
    if (s.includes("low") || s.includes("0.0-0.2")) return 1;
    if (s.includes("mid") || s.includes("0.2-0.8")) return 2;
    if (s.includes("high") || s.includes("0.8-1")) return 3;
  }
  const p = parseNum(intendedPrice);
  if (p <= 0.2) return 1;
  if (p >= 0.8) return 3;
  return 2;
}

function encodeBotType(raw: string | null | undefined): number {
  const s = (raw ?? "").trim().toLowerCase();
  if (!s) return 0;
  let hash = 2166136261;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 1000) / 1000;
}

/**
 * Build numeric feature vector from a training row or scoring context.
 * Same order as SHADOW_FEATURE_NAMES. Missing values -> 0. For scoring, pass outcomeBlockedVsAllowedVsSubmitted 0 or omit (encoded as 0).
 */
export function toShadowFeatureVector(row: ShadowFeatureInput): number[] {
  const outcomeEnc = row.outcomeBlockedVsAllowedVsSubmitted
    ? (OUTCOME_ENC[row.outcomeBlockedVsAllowedVsSubmitted] ?? 0)
    : 0;
  const [pLow, pMid, pHigh] = probabilityBandOneHot(row.probabilityBand, row.intendedPrice);
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
    parseNum(row.scoreThresholdGap),
    pLow,
    pMid,
    pHigh,
    encodeEntryPriceBand(row.entryPriceBand, row.intendedPrice),
    encodeBotType(row.botType),
  ];
}
