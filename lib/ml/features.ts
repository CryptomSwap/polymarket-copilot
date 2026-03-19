/**
 * Feature extraction and encoding for ML training.
 * Numeric features normalized; categoricals label-encoded. Safe handling of missing values.
 */

export const FEATURE_SET_V1 = "v1";

const CAT_SIGNAL_TYPES = [
  "MOMENTUM_CONTINUATION", "MISPRICED_BREAKOUT", "CHEAP_LONGSHOT", "OVERCROWDED_THEME",
  "LATE_CHASE", "WATCHLIST", "EXIT_CANDIDATE", "TRIM_CANDIDATE",
];
const CAT_ACTIONS = ["STRONG_BUY", "BUY_SMALL", "WATCH", "NO_TRADE", "TRIM", "EXIT"];
const CAT_REVIEW = ["NEW", "REVIEWED", "APPROVED", "REJECTED", "ARCHIVED"];

function indexOf(arr: string[], v: string | null | undefined): number {
  if (v == null) return 0;
  const i = arr.indexOf(v);
  return i >= 0 ? i + 1 : 0;
}

function parseNum(s: string | number | null | undefined): number {
  if (s == null || s === "") return 0;
  if (typeof s === "number") return Number.isFinite(s) ? s : 0;
  const n = parseFloat(String(s).trim());
  return Number.isFinite(n) ? n : 0;
}

export interface TrainingRow {
  recommendationId: string;
  marketPrice: number;
  fairPrice: number;
  edge: number;
  confidence: number;
  momentumComponent: number;
  liquidityComponent: number;
  crowdingComponent: number;
  portfolioComponent: number;
  behaviorComponent: number;
  longshotComponent: number;
  timeComponent: number;
  themeExposurePct: number;
  /** Largest theme % of portfolio. */
  topThemeConcentrationPct: number;
  hasExistingPosition: number;
  reservedExposure?: number;
  linkedNewsCount: number;
  newsFreshnessScore: number;
  newsCredibilityScore: number;
  noveltyScore: number;
  saturationScore: number;
  catalystBoost: number;
  signalTypeEnc: number;
  actionEnc: number;
  reviewStatusEnc: number;
  categoryEnc: number;
  themeEnc: number;
  labelPositive6h?: boolean;
  labelPositive24h?: boolean;
  forwardReturn6h?: number;
  forwardReturn24h?: number;
  priorityScore: number;
}

/**
 * Encode one training example (from MlTrainingExample or in-memory row) to numeric feature vector.
 * Order of features must match for training and inference.
 */
export function toFeatureVector(row: {
  marketPrice?: string | number;
  fairPrice?: string | number;
  edge?: string | number;
  confidence?: string | number;
  momentumComponent?: string | number | null;
  liquidityComponent?: string | number | null;
  portfolioComponent?: string | number | null;
  behaviorComponent?: string | number | null;
  themeExposurePct?: string | number | null;
  topThemeConcentrationPct?: string | number | null;
  hasExistingPosition?: boolean;
  linkedNewsCount?: number;
  newsFreshnessScore?: string | number | null;
  newsCredibilityScore?: string | number | null;
  noveltyScore?: string | number | null;
  saturationScore?: string | number | null;
  catalystBoost?: string | number | null;
  signalType?: string | null;
  action?: string | null;
  reviewStatus?: string | null;
  priorityScore?: string | number;
}): number[] {
  return [
    parseNum(row.marketPrice),
    parseNum(row.fairPrice),
    parseNum(row.edge),
    parseNum(row.confidence),
    parseNum(row.momentumComponent),
    parseNum(row.liquidityComponent),
    parseNum(row.portfolioComponent),
    parseNum(row.behaviorComponent),
    parseNum(row.themeExposurePct),
    parseNum(row.topThemeConcentrationPct),
    row.hasExistingPosition ? 1 : 0,
    Number(row.linkedNewsCount) || 0,
    parseNum(row.newsFreshnessScore),
    parseNum(row.newsCredibilityScore),
    parseNum(row.noveltyScore),
    parseNum(row.saturationScore),
    parseNum(row.catalystBoost),
    indexOf(CAT_SIGNAL_TYPES, row.signalType ?? null),
    indexOf(CAT_ACTIONS, row.action ?? null),
    indexOf(CAT_REVIEW, row.reviewStatus ?? null),
    parseNum(row.priorityScore),
  ];
}

export const FEATURE_NAMES = [
  "marketPrice", "fairPrice", "edge", "confidence", "momentumComponent", "liquidityComponent",
  "portfolioComponent", "behaviorComponent", "themeExposurePct", "topThemeConcentrationPct",
  "hasExistingPosition", "linkedNewsCount", "newsFreshnessScore", "newsCredibilityScore",
  "noveltyScore", "saturationScore", "catalystBoost", "signalTypeEnc", "actionEnc", "reviewStatusEnc",
  "priorityScore",
];

/**
 * Build TrainingRow from raw example for training (includes label).
 */
export function toTrainingRow(raw: {
  marketPrice: string;
  fairPrice: string;
  edge: string;
  confidence: string;
  momentumComponent?: string | null;
  liquidityComponent?: string | null;
  crowdingComponent?: string | null;
  portfolioComponent?: string | null;
  behaviorComponent?: string | null;
  longshotComponent?: string | null;
  timeComponent?: string | null;
  themeExposurePct?: string | null;
  /** Theme concentration. */
  topThemeConcentrationPct?: string | null;
  hasExistingPosition: boolean;
  reservedExposure?: string | null;
  linkedNewsCount: number;
  newsFreshnessScore?: string | null;
  newsCredibilityScore?: string | null;
  noveltyScore?: string | null;
  saturationScore?: string | null;
  catalystBoost?: string | null;
  signalType?: string | null;
  action?: string | null;
  reviewStatus?: string | null;
  category?: string | null;
  theme?: string | null;
  forwardReturn6h?: string | null;
  forwardReturn24h?: string | null;
  labelPositive6h?: boolean | null;
  labelPositive24h?: boolean | null;
  priorityScore: string;
}, recommendationId: string): TrainingRow {
  const catEnc = (v: string | null | undefined, arr: string[]) => indexOf(arr, v ?? null);
  return {
    recommendationId,
    marketPrice: parseNum(raw.marketPrice),
    fairPrice: parseNum(raw.fairPrice),
    edge: parseNum(raw.edge),
    confidence: parseNum(raw.confidence),
    momentumComponent: parseNum(raw.momentumComponent),
    liquidityComponent: parseNum(raw.liquidityComponent),
    crowdingComponent: parseNum(raw.crowdingComponent),
    portfolioComponent: parseNum(raw.portfolioComponent),
    behaviorComponent: parseNum(raw.behaviorComponent),
    longshotComponent: parseNum(raw.longshotComponent),
    timeComponent: parseNum(raw.timeComponent),
    themeExposurePct: parseNum(raw.themeExposurePct),
    topThemeConcentrationPct: parseNum(raw.topThemeConcentrationPct ?? 0),
    hasExistingPosition: raw.hasExistingPosition ? 1 : 0,
    reservedExposure: parseNum(raw.reservedExposure) || 0,
    linkedNewsCount: raw.linkedNewsCount,
    newsFreshnessScore: parseNum(raw.newsFreshnessScore),
    newsCredibilityScore: parseNum(raw.newsCredibilityScore),
    noveltyScore: parseNum(raw.noveltyScore),
    saturationScore: parseNum(raw.saturationScore),
    catalystBoost: parseNum(raw.catalystBoost),
    signalTypeEnc: catEnc(raw.signalType, CAT_SIGNAL_TYPES),
    actionEnc: catEnc(raw.action, CAT_ACTIONS),
    reviewStatusEnc: catEnc(raw.reviewStatus, CAT_REVIEW),
    categoryEnc: 0,
    themeEnc: 0,
    labelPositive6h: raw.labelPositive6h ?? undefined,
    labelPositive24h: raw.labelPositive24h ?? undefined,
    forwardReturn6h: parseNum(raw.forwardReturn6h) || undefined,
    forwardReturn24h: parseNum(raw.forwardReturn24h) || undefined,
    priorityScore: parseNum(raw.priorityScore),
  };
}
