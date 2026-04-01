/**
 * Paper-trading candidates from runtime ShadowCandidate telemetry (wasSubmitted, runtime_automated).
 * Maps persisted snapshot JSON into ShadowScoreInput for scoreShadowCandidate — same feature semantics as shadow dataset build.
 */

import { prisma } from "@/lib/db";
import type { ShadowScoreInput } from "@/lib/ml/shadow-score/types";
import type { DecisionSnapshotLike } from "@/lib/decision-calibration/subtypes";
import { getPaperTradingConfig } from "./config";
import type { BotProfile, EffectiveBotProfile, PriceBandLabel } from "./bot-profiles";
import type { PaperPolicyMode, PaperRelaxationReason } from "./paper-relaxation";
import { classifyEntryPriceBand, parseEntryPrice } from "./price-bands";

function parseNum(s: string | null | undefined): number {
  if (s == null || s === "") return 0;
  const n = parseFloat(String(s).trim());
  return Number.isFinite(n) ? n : 0;
}

function toStr(n: number | null | undefined): string | null {
  if (n == null || !Number.isFinite(n)) return null;
  return String(n);
}

function parseDecisionSnapshot(json: string | null | undefined): DecisionSnapshotLike | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as DecisionSnapshotLike;
  } catch {
    return null;
  }
}

/** Reco-thesis strings from `ShadowCandidate.decisionSnapshotJson` (root or `recoThesis` / `reco_thesis`). */
export function parseRecoThesisFromDecisionSnapshotJson(
  json: string | null | undefined
): Pick<PaperTradingCandidate, "strategyFamily" | "strategyVariant" | "hypothesisType"> {
  const out: {
    strategyFamily?: string;
    strategyVariant?: string;
    hypothesisType?: string;
  } = {};
  if (!json?.trim()) return out;
  try {
    const o = JSON.parse(json) as Record<string, unknown>;
    const nest = (o.recoThesis ?? o.reco_thesis) as Record<string, unknown> | undefined;
    const pick = (k: string): string | undefined => {
      const v = o[k] ?? nest?.[k];
      if (typeof v === "string" && v.trim()) return v.trim();
      if (typeof v === "number" && Number.isFinite(v)) return String(v);
      return undefined;
    };
    const sf = pick("strategyFamily");
    const sv = pick("strategyVariant");
    const ht = pick("hypothesisType");
    if (sf) out.strategyFamily = sf;
    if (sv) out.strategyVariant = sv;
    if (ht) out.hypothesisType = ht;
  } catch {
    /* ignore */
  }
  return out;
}

/** Root keys merged into `PaperTrade.metadataJson` before `openAttribution` (omit missing). */
export function recoThesisMetadataForPaperTrade(
  c: Pick<PaperTradingCandidate, "strategyFamily" | "strategyVariant" | "hypothesisType">
): Record<string, unknown> {
  const m: Record<string, unknown> = {};
  if (c.strategyFamily?.trim()) m.strategyFamily = c.strategyFamily.trim();
  if (c.strategyVariant?.trim()) m.strategyVariant = c.strategyVariant.trim();
  if (c.hypothesisType?.trim()) m.hypothesisType = c.hypothesisType.trim();
  return m;
}

/** Prefer DB column; recover marketId from decision JSON when runtime omitted the column. */
function resolvedMarketIdForShadowRow(r: {
  marketId: string | null;
  decisionSnapshotJson: string | null;
}): string | null {
  const col = r.marketId?.trim();
  if (col) return col;
  const d = parseDecisionSnapshot(r.decisionSnapshotJson) as Record<string, unknown> | null;
  const mid = d && typeof d.marketId === "string" ? d.marketId.trim() : "";
  return mid || null;
}

function parseExecutionPolicySnapshot(json: string | null | undefined): {
  allow?: boolean;
  policyState?: string;
  blockingReasons?: string[];
  warnings?: string[];
} | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as {
      allow?: boolean;
      policyState?: string;
      blockingReasons?: string[];
      warnings?: string[];
    };
  } catch {
    return null;
  }
}

function optFiniteQuoteNum(x: unknown): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

function parseExecutionQualitySnapshot(json: string | null | undefined): {
  qualityState?: string;
  spreadBps?: number | null;
  estimatedSlippageBps?: number | null;
  tradable?: boolean;
  blockingReasons?: string[];
  warnings?: string[];
  bestBid?: number | null;
  bestAsk?: number | null;
  midPrice?: number | null;
  intendedPrice?: number | null;
} | null {
  if (!json) return null;
  try {
    const o = JSON.parse(json) as Record<string, unknown>;
    return {
      qualityState: typeof o.qualityState === "string" ? o.qualityState : undefined,
      spreadBps: typeof o.spreadBps === "number" ? o.spreadBps : null,
      estimatedSlippageBps: typeof o.estimatedSlippageBps === "number" ? o.estimatedSlippageBps : null,
      tradable: typeof o.tradable === "boolean" ? o.tradable : undefined,
      blockingReasons: Array.isArray(o.blockingReasons) ? (o.blockingReasons as string[]) : undefined,
      warnings: Array.isArray(o.warnings) ? (o.warnings as string[]) : undefined,
      bestBid: optFiniteQuoteNum(o.bestBid),
      bestAsk: optFiniteQuoteNum(o.bestAsk),
      midPrice: optFiniteQuoteNum(o.midPrice),
      intendedPrice: optFiniteQuoteNum(o.intendedPrice),
    };
  } catch {
    return null;
  }
}

function parsePortfolioRiskSnapshot(json: string | null | undefined): {
  grossExposure?: number;
  totalOpenExposure?: number;
  maxSingleMarketConcentrationPct?: number;
  maxSingleThemeConcentrationPct?: number;
  concentrationFlags?: unknown[];
  riskFlags?: unknown[];
} | null {
  if (!json) return null;
  try {
    const o = JSON.parse(json) as Record<string, unknown>;
    return {
      grossExposure: typeof o.grossExposure === "number" ? o.grossExposure : undefined,
      totalOpenExposure: typeof o.totalOpenExposure === "number" ? o.totalOpenExposure : undefined,
      maxSingleMarketConcentrationPct:
        typeof o.maxSingleMarketConcentrationPct === "number" ? o.maxSingleMarketConcentrationPct : undefined,
      maxSingleThemeConcentrationPct:
        typeof o.maxSingleThemeConcentrationPct === "number" ? o.maxSingleThemeConcentrationPct : undefined,
      concentrationFlags: Array.isArray(o.concentrationFlags) ? o.concentrationFlags : undefined,
      riskFlags: Array.isArray(o.riskFlags) ? o.riskFlags : undefined,
    };
  } catch {
    return null;
  }
}

function parseRuntimeSafetySnapshot(json: string | null | undefined): {
  state?: string;
  blockingReasons?: string[];
  warnings?: string[];
} | null {
  if (!json) return null;
  try {
    const o = JSON.parse(json) as Record<string, unknown>;
    return {
      state: typeof o.state === "string" ? o.state : undefined,
      blockingReasons: Array.isArray(o.blockingReasons) ? (o.blockingReasons as string[]) : [],
      warnings: Array.isArray(o.warnings) ? (o.warnings as string[]) : [],
    };
  } catch {
    return null;
  }
}

/** Map execution policy outcome to staged-style labels used by bot profile filters. */
export function stagedPolicyLabelFromExecutionPolicy(policyState: string | null | undefined): string | null {
  const s = (policyState ?? "").toLowerCase().trim();
  if (s === "allow") return "ALLOW_NORMAL";
  if (s === "warn") return "REVIEW_REQUIRED";
  if (s === "block") return "BLOCK";
  return null;
}

/** Canonical staged decision states from evaluate-staged / policy.ts (uppercase). */
const DECISION_POLICY_STATES_FOR_PAPER = new Set([
  "ALLOW_SMALL",
  "ALLOW_NORMAL",
  "ALLOW_HIGH_CONVICTION",
  "TRIM",
  "EXIT",
  "REVIEW_REQUIRED",
  "BLOCK",
]);

/**
 * Map decision snapshot policyState into the same labels used for paper profile filtering.
 * Execution snapshot (allow/warn/block) is preferred when present; use this when execution omits policy.
 */
export function stagedPolicyLabelFromDecisionPolicy(policyState: string | null | undefined): string | null {
  if (policyState == null) return null;
  const t = String(policyState).trim();
  if (!t) return null;
  const norm = t.replace(/\s+/g, "_").toUpperCase();
  if (DECISION_POLICY_STATES_FOR_PAPER.has(norm)) return norm;
  return null;
}

export function resolvePaperStagedPolicyLabel(
  executionPolicyState: string | null | undefined,
  decisionPolicyState: string | null | undefined
): string | null {
  return (
    stagedPolicyLabelFromExecutionPolicy(executionPolicyState) ??
    stagedPolicyLabelFromDecisionPolicy(decisionPolicyState)
  );
}

export function buildShadowScoreInputFromShadowCandidateRow(row: {
  recommendationId: string | null;
  decisionSnapshotJson: string | null;
  executionPolicySnapshotJson: string | null;
  executionQualitySnapshotJson: string | null;
  portfolioRiskSnapshotJson: string | null;
  runtimeSafetySnapshotJson: string | null;
  wasBlocked: boolean;
  blockingReasons: unknown;
  wasSubmitted: boolean;
  intendedPrice: string;
  intendedSize: string;
  side: string;
}): ShadowScoreInput {
  const decision = parseDecisionSnapshot(row.decisionSnapshotJson);
  const policy = parseExecutionPolicySnapshot(row.executionPolicySnapshotJson);
  const eq = parseExecutionQualitySnapshot(row.executionQualitySnapshotJson);
  const risk = parsePortfolioRiskSnapshot(row.portfolioRiskSnapshotJson);
  const safety = parseRuntimeSafetySnapshot(row.runtimeSafetySnapshotJson);

  const eligibilityBlockersCount = (decision?.blockers ?? []).length;
  const sizeMult = decision?.sizeMultiplier;
  const sizeMultNum = typeof sizeMult === "number" ? sizeMult : parseNum(String(sizeMult ?? ""));
  const reducedSizeIndicator =
    sizeMultNum != null && Number.isFinite(sizeMultNum) && sizeMultNum > 0 && sizeMultNum < 1;

  const executionAllow = policy?.allow ?? null;
  const executionWarningCount = policy?.warnings?.length ?? 0;

  const riskFlagsCount =
    (risk?.concentrationFlags?.length ?? 0) + (risk?.riskFlags?.length ?? 0);

  const policyStateForFeatures = policy?.policyState ?? decision?.policyState ?? null;
  const finalSuggestedSizeForFeatures =
    decision?.finalSuggestedSize != null ? String(decision.finalSuggestedSize) : row.intendedSize;
  const sizeMultiplierForFeatures =
    decision?.sizeMultiplier != null ? String(decision.sizeMultiplier) : null;

  return {
    policyState: policyStateForFeatures,
    sizeMultiplier: sizeMultiplierForFeatures,
    finalSuggestedSize: finalSuggestedSizeForFeatures,
    eligibilityBlockersCount,
    reducedSizeIndicator,
    blockedIndicator: row.wasBlocked,
    executionAllow,
    executionWarningCount,
    qualityState: eq?.qualityState ?? null,
    spreadBps: toStr(eq?.spreadBps ?? null),
    estimatedSlippage:
      eq?.estimatedSlippageBps != null && Number.isFinite(eq.estimatedSlippageBps)
        ? String(eq.estimatedSlippageBps / 10_000)
        : null,
    quoteBestBid: eq?.bestBid ?? null,
    quoteBestAsk: eq?.bestAsk ?? null,
    quoteMidPrice: eq?.midPrice ?? null,
    tradable: eq?.tradable ?? null,
    grossExposure: toStr(risk?.grossExposure ?? risk?.totalOpenExposure ?? null),
    totalOpenExposure: toStr(risk?.totalOpenExposure ?? null),
    maxSingleMarketConcentrationPct: toStr(risk?.maxSingleMarketConcentrationPct ?? null),
    maxSingleThemeConcentrationPct: toStr(risk?.maxSingleThemeConcentrationPct ?? null),
    portfolioRiskFlagsCount: riskFlagsCount,
    runtimeWarningCount: safety?.warnings?.length ?? 0,
    runtimeBlockingCount: safety?.blockingReasons?.length ?? 0,
    intendedPrice: row.intendedPrice,
    intendedSize: row.intendedSize,
    recommendationPresent: row.recommendationId != null && row.recommendationId !== "",
    side: row.side.toUpperCase() === "SELL" ? "SELL" : "BUY",
  };
}

export interface PaperTradingCandidate {
  /** Set for telemetry-originated rows. */
  shadowCandidateId?: string;
  recommendationId: string;
  marketId: string;
  assetId: string;
  outcome: string;
  side: string;
  entryPrice: string;
  intendedSize: string;
  theme: string | null;
  category: string | null;
  /** Staged-style policy label for profile filter / traces (from execution policy when present). */
  sourceDecisionState?: string;
  /** Execution policy state string (allow | warn | block) when known. */
  executionPolicyState?: string | null;
  /** For profile filtering: ALLOW_NORMAL | REVIEW_REQUIRED | BLOCK | null (unknown). */
  paperStagedPolicyState?: string | null;
  entryPriceBand?: PriceBandLabel | null;
  shadowInput: ShadowScoreInput;
  passedViaRelaxation?: boolean;
  relaxedBlockReason?: string;
  paperPolicyMode?: PaperPolicyMode;
  paperRelaxationReason?: PaperRelaxationReason;
  originalBlockingReasons?: string[];
  paperEligibilityVersion?: string;
  derivationSource?: string;
  /** From shadow `decisionSnapshotJson` when present (reco-thesis attribution). */
  strategyFamily?: string;
  strategyVariant?: string;
  hypothesisType?: string;
}

/** Options for loading submitted shadow rows for one tick. */
export interface GetSubmittedShadowCandidatesForTickOptions {
  funderAddress: string;
  /** Default: from getPaperTradingConfig().shadowLookbackMinutes */
  lookbackMinutes?: number;
}

/** Upstream candidate breadth after price-bias expansion (read-only telemetry). */
export interface ShadowExpansionBreadthDiagnostics {
  expansionTarget: number;
  expansionMax: number;
  /** 0 = no per-market limit during expansion pulls (legacy slice behavior). */
  perMarketCap: number;
  beforePriceBiasCount: number;
  afterPriceBiasCount: number;
  uniqueRecommendationIds: number;
  uniqueMarketIds: number;
  uniqueAssetSidePairs: number;
  /** Unique market count per V2-style shadow price band (entry-intended price). */
  uniqueMarketsByShadowBand: Record<string, number>;
}

/**
 * After mid-range expansion: optional cap on share/count of extreme-band candidates (<0.1 or >=0.9 entry price).
 * Disabled when both env knobs are unset (reversible default).
 */
export interface ShadowExtremeBandCapDiagnostics {
  enabled: boolean;
  maxShareEnv: number | null;
  maxCountEnv: number | null;
  totalBefore: number;
  totalAfter: number;
  /** Effective ceiling on extreme-band rows kept (min of share floor and count cap). */
  maxExtremeAllowed: number;
  /** Counts by `shadowPriceBandForDiagnostics` label. */
  selectedCountByBandBefore: Record<string, number>;
  selectedCountByBandAfter: Record<string, number>;
  extremeCountBefore: number;
  extremeCountAfter: number;
  extremeDroppedByCap: number;
}

/**
 * Final post-dedupe selection bias (after extreme-band cap): constrain low-extreme (<0.1) share/count
 * and preserve/promote mid bands when available.
 */
export interface ShadowFinalSelectionBiasDiagnostics {
  enabled: boolean;
  lowExtremeMaxShareEnv: number | null;
  lowExtremeMaxCountEnv: number | null;
  midBandMinCountEnv: number | null;
  selectedCountByBandBeforeFinalBias: Record<string, number>;
  selectedCountByBandAfterFinalBias: Record<string, number>;
  lowExtremeDroppedByFinalBias: number;
  midBandReservedOrPromoted: number;
  lowExtremeCountBefore: number;
  lowExtremeCountAfter: number;
}

export interface ShadowTickLoadDiagnostics {
  shadowRowsQueried: number;
  shadowRowsSkippedNoMarket: number;
  shadowRowsSkippedZeroBuySize: number;
  dedupeDroppedCount: number;
  candidatesLoaded: number;
  /** Ids after dedupe (newest-first wins per marketId+side). */
  candidateIds: string[];
  zeroCandidatesReason: string;
  lookbackMinutes: number;
  /** Funder address used for the Prisma query that produced shadowRowsQueried. */
  funderUsedForLoad?: string;
  /** Wallet / tick hint tried first (may differ from funderUsedForLoad when fallback ran). */
  preferredFunderTried?: string | null;
  /** True when rows were loaded using a different funder than preferredFunderTried. */
  usedFunderFallback?: boolean;
  /** Minutes for the extended lookback attempt (only if tried). */
  extendedLookbackTriedMinutes?: number | null;
  /** Recent submitters in the widened window (diagnostics). */
  topSubmittersByCount?: { funderAddress: string; count: number }[];
  /** Present after mid-range price bias + expansion (pre–profile / pre-V2). */
  expansionBreadth?: ShadowExpansionBreadthDiagnostics;
  /** Present after optional extreme-band cap (still pre–profile / pre-V2). */
  extremeBandCap?: ShadowExtremeBandCapDiagnostics;
  /** Present after final selection bias (still pre–profile / pre-V2). */
  finalSelectionBias?: ShadowFinalSelectionBiasDiagnostics;
  /** Dedupe winner choice diagnostics (raw->dedup stage). */
  dedupeWinnerChoice?: {
    enabled: boolean;
    keysEvaluated: number;
    keysWinnerChanged: number;
    currentWinnerBandCounts: Record<string, number>;
    preferredWinnerBandCounts: Record<string, number>;
    changedKeysSample?: { dedupeKey: string; currentWinnerBand: string; preferredWinnerBand: string }[];
  };
}

/** Normalize tick/API funder hint: empty or legacy "paper" → auto-pick from ShadowCandidate activity. */
export function normalizePreferredFunderForShadowLoad(f: string | null | undefined): string | null {
  const t = f?.trim().toLowerCase();
  if (!t || t === "paper") return null;
  return t;
}

export interface LoadShadowCandidatesForPaperTickOpts {
  preferredFunder?: string | null;
  lookbackMinutes?: number;
  allowFunderFallback?: boolean;
  extendedLookbackMinutes?: number;
}

function parsePriceBoundEnv(key: string, fallback: number): number {
  const raw = typeof process !== "undefined" ? process.env[key]?.trim() : "";
  if (!raw) return fallback;
  const n = parseFloat(raw);
  if (!Number.isFinite(n)) return fallback;
  return n;
}

/** Matches `classifyShadowBand` in engine_v2_minimal (entry-intended price → overlay band labels). */
function shadowPriceBandForDiagnostics(entryPrice: string | null | undefined): string {
  const p = parseEntryPrice(entryPrice);
  if (p == null) return "0.4-0.6";
  if (p < 0.1) return "<0.1";
  if (p < 0.2) return "0.1-0.2";
  if (p < 0.3) return "0.2-0.3";
  if (p < 0.4) return "0.3-0.4";
  if (p < 0.6) return "0.4-0.6";
  if (p < 0.8) return "0.6-0.8";
  if (p < 0.9) return "0.8-0.9";
  return ">=0.9";
}

function computeExpansionBreadthDiagnostics(
  filtered: PaperTradingCandidate[],
  beforeCount: number,
  expansionTarget: number,
  expansionMax: number,
  perMarketCap: number
): ShadowExpansionBreadthDiagnostics {
  const uniqueMarketsByShadowBand: Record<string, number> = {};
  const bandMarketSets = new Map<string, Set<string>>();
  for (const c of filtered) {
    const b = shadowPriceBandForDiagnostics(c.entryPrice);
    let s = bandMarketSets.get(b);
    if (!s) {
      s = new Set();
      bandMarketSets.set(b, s);
    }
    s.add(c.marketId);
  }
  for (const [b, s] of bandMarketSets) uniqueMarketsByShadowBand[b] = s.size;

  return {
    expansionTarget,
    expansionMax,
    perMarketCap,
    beforePriceBiasCount: beforeCount,
    afterPriceBiasCount: filtered.length,
    uniqueRecommendationIds: new Set(filtered.map((c) => c.recommendationId)).size,
    uniqueMarketIds: new Set(filtered.map((c) => c.marketId)).size,
    uniqueAssetSidePairs: new Set(filtered.map((c) => `${c.assetId}|${c.side}`)).size,
    uniqueMarketsByShadowBand,
  };
}

/**
 * Take up to `need` candidates in list order; skip ids already in `selectedIds`.
 * When `perMarketCap` > 0, at most that many selections per marketId (updates `marketTally`).
 * When `perMarketCap` <= 0, only id-uniqueness applies (legacy slice semantics).
 */
function takeWithPerMarketCapExcluding(
  queue: PaperTradingCandidate[],
  need: number,
  perMarketCap: number,
  marketTally: Map<string, number>,
  selectedIds: Set<string>
): PaperTradingCandidate[] {
  if (need <= 0) return [];
  const out: PaperTradingCandidate[] = [];
  for (const c of queue) {
    if (out.length >= need) break;
    const id = c.shadowCandidateId ?? c.recommendationId;
    if (selectedIds.has(id)) continue;
    if (perMarketCap > 0) {
      const cur = marketTally.get(c.marketId) ?? 0;
      if (cur >= perMarketCap) continue;
      marketTally.set(c.marketId, cur + 1);
    }
    selectedIds.add(id);
    out.push(c);
  }
  return out;
}

function parsePaperShadowExpansionTarget(fallback: number): number {
  const raw = typeof process !== "undefined" ? process.env.PAPER_SHADOW_CANDIDATE_EXPANSION_TARGET?.trim() : "";
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}

function parsePaperShadowExpansionMax(target: number, fallback: number): number {
  const raw = typeof process !== "undefined" ? process.env.PAPER_SHADOW_CANDIDATE_EXPANSION_MAX?.trim() : "";
  if (!raw) return Math.max(target, fallback);
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 ? Math.max(n, target) : Math.max(target, fallback);
}

function parsePaperShadowExpansionPerMarketCap(fallback: number): number {
  const raw = typeof process !== "undefined" ? process.env.PAPER_SHADOW_EXPANSION_PER_MARKET_CAP?.trim() : "";
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** 0–1 share cap on extreme-band rows in the final loader selection; unset = no share limit. */
function parsePaperShadowExtremeBandMaxShare(): number | null {
  const raw = typeof process !== "undefined" ? process.env.PAPER_SHADOW_EXTREME_BAND_MAX_SHARE?.trim() : "";
  if (!raw) return null;
  const n = parseFloat(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) return null;
  return n;
}

/** Hard cap on count of extreme-band rows kept; unset = no count limit. */
function parsePaperShadowExtremeBandMaxCount(): number | null {
  const raw = typeof process !== "undefined" ? process.env.PAPER_SHADOW_EXTREME_BAND_MAX_COUNT?.trim() : "";
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** 0–1 share cap for final selected low-extreme rows (<0.1). */
function parsePaperShadowLowExtremeMaxShare(): number | null {
  const raw =
    typeof process !== "undefined" ? process.env.PAPER_SHADOW_LOW_EXTREME_MAX_SHARE?.trim() : "";
  if (!raw) return null;
  const n = parseFloat(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) return null;
  return n;
}

/** Hard count cap for final selected low-extreme rows (<0.1). */
function parsePaperShadowLowExtremeMaxCount(): number | null {
  const raw =
    typeof process !== "undefined" ? process.env.PAPER_SHADOW_LOW_EXTREME_MAX_COUNT?.trim() : "";
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Soft minimum for final selected mid-band rows (0.2-0.3, 0.4-0.6, 0.6-0.8). */
function parsePaperShadowMidBandMinCount(): number | null {
  const raw =
    typeof process !== "undefined" ? process.env.PAPER_SHADOW_MID_BAND_MIN_COUNT?.trim() : "";
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function dedupeBandLabel(entryPrice: string | null | undefined): string {
  const p = parseEntryPrice(entryPrice);
  if (p == null) return "unknown";
  if (p < 0.1) return "<0.1";
  if (p < 0.2) return "0.1-0.2";
  if (p < 0.3) return "0.2-0.3";
  if (p < 0.4) return "0.3-0.4";
  if (p < 0.6) return "0.4-0.6";
  if (p < 0.8) return "0.6-0.8";
  if (p < 0.9) return "0.8-0.9";
  return ">=0.9";
}

function shouldPreferGoodBandsForDedupeWinner(): boolean {
  return (typeof process !== "undefined" ? process.env.PAPER_SHADOW_DEDUPE_PREFER_GOOD_BANDS : "") === "1";
}

function isExtremeShadowEntryPrice(entryPrice: string | null | undefined): boolean {
  const p = parseEntryPrice(entryPrice);
  if (p == null) return false;
  return p < 0.1 || p >= 0.9;
}

function isLowExtremeShadowEntryPrice(entryPrice: string | null | undefined): boolean {
  const p = parseEntryPrice(entryPrice);
  if (p == null) return false;
  return p < 0.1;
}

function isMidBandShadowEntryPrice(entryPrice: string | null | undefined): boolean {
  const p = parseEntryPrice(entryPrice);
  if (p == null) return false;
  return (p >= 0.2 && p < 0.3) || (p >= 0.4 && p < 0.6) || (p >= 0.6 && p < 0.8);
}

function countSelectedByDiagnosticsBand(candidates: PaperTradingCandidate[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of candidates) {
    const b = shadowPriceBandForDiagnostics(c.entryPrice);
    out[b] = (out[b] ?? 0) + 1;
  }
  return out;
}

function countExtremeCandidates(candidates: PaperTradingCandidate[]): number {
  let n = 0;
  for (const c of candidates) {
    if (isExtremeShadowEntryPrice(c.entryPrice)) n++;
  }
  return n;
}

function countLowExtremeCandidates(candidates: PaperTradingCandidate[]): number {
  let n = 0;
  for (const c of candidates) {
    if (isLowExtremeShadowEntryPrice(c.entryPrice)) n++;
  }
  return n;
}

function countMidBandCandidates(candidates: PaperTradingCandidate[]): number {
  let n = 0;
  for (const c of candidates) {
    if (isMidBandShadowEntryPrice(c.entryPrice)) n++;
  }
  return n;
}

/**
 * Preserves list order and mid-band priority: never drops non-extreme rows; drops excess extremes from the tail of the extreme sequence in list order.
 */
function applyExtremeBandCandidateCap(
  ordered: PaperTradingCandidate[],
  maxShare: number | null,
  maxCount: number | null
): { capped: PaperTradingCandidate[]; diagnostics: ShadowExtremeBandCapDiagnostics } {
  const beforeBands = countSelectedByDiagnosticsBand(ordered);
  const extremeBefore = countExtremeCandidates(ordered);
  const maxShareEnv = maxShare;
  const maxCountEnv = maxCount;
  const enabled = maxShare != null || maxCount != null;

  if (!enabled) {
    return {
      capped: ordered,
      diagnostics: {
        enabled: false,
        maxShareEnv: null,
        maxCountEnv: null,
        totalBefore: ordered.length,
        totalAfter: ordered.length,
        maxExtremeAllowed: extremeBefore,
        selectedCountByBandBefore: beforeBands,
        selectedCountByBandAfter: { ...beforeBands },
        extremeCountBefore: extremeBefore,
        extremeCountAfter: extremeBefore,
        extremeDroppedByCap: 0,
      },
    };
  }

  const n = ordered.length;
  const limitFromShare = maxShare != null ? Math.floor(n * maxShare) : Number.POSITIVE_INFINITY;
  const limitFromCount = maxCount != null ? maxCount : Number.POSITIVE_INFINITY;
  const maxExtremeAllowed = Math.max(0, Math.min(limitFromShare, limitFromCount));

  let extremeKept = 0;
  const capped: PaperTradingCandidate[] = [];
  for (const c of ordered) {
    if (!isExtremeShadowEntryPrice(c.entryPrice)) {
      capped.push(c);
      continue;
    }
    if (extremeKept < maxExtremeAllowed) {
      extremeKept++;
      capped.push(c);
    }
  }

  const extremeAfter = countExtremeCandidates(capped);
  return {
    capped,
    diagnostics: {
      enabled: true,
      maxShareEnv,
      maxCountEnv,
      totalBefore: n,
      totalAfter: capped.length,
      maxExtremeAllowed,
      selectedCountByBandBefore: beforeBands,
      selectedCountByBandAfter: countSelectedByDiagnosticsBand(capped),
      extremeCountBefore: extremeBefore,
      extremeCountAfter: extremeAfter,
      extremeDroppedByCap: extremeBefore - extremeAfter,
    },
  };
}

/**
 * Final post-dedupe bias: keep order as much as possible, cap low-extreme (<0.1), and reserve/promote
 * mid bands when available. If no non-low rows exist, fallback keeps one low row to avoid empty output.
 */
function applyFinalSelectionLowExtremeBias(
  ordered: PaperTradingCandidate[],
  lowExtremeMaxShare: number | null,
  lowExtremeMaxCount: number | null,
  midBandMinCount: number | null
): { biased: PaperTradingCandidate[]; diagnostics: ShadowFinalSelectionBiasDiagnostics } {
  const beforeBands = countSelectedByDiagnosticsBand(ordered);
  const lowBefore = countLowExtremeCandidates(ordered);
  const midBefore = countMidBandCandidates(ordered);
  const enabled = lowExtremeMaxShare != null || lowExtremeMaxCount != null || midBandMinCount != null;

  if (!enabled) {
    return {
      biased: ordered,
      diagnostics: {
        enabled: false,
        lowExtremeMaxShareEnv: null,
        lowExtremeMaxCountEnv: null,
        midBandMinCountEnv: null,
        selectedCountByBandBeforeFinalBias: beforeBands,
        selectedCountByBandAfterFinalBias: { ...beforeBands },
        lowExtremeDroppedByFinalBias: 0,
        midBandReservedOrPromoted: 0,
        lowExtremeCountBefore: lowBefore,
        lowExtremeCountAfter: lowBefore,
      },
    };
  }

  const n = ordered.length;
  const capShare = lowExtremeMaxShare != null ? Math.floor(n * lowExtremeMaxShare) : Number.POSITIVE_INFINITY;
  const capCount = lowExtremeMaxCount != null ? lowExtremeMaxCount : Number.POSITIVE_INFINITY;
  const lowCap = Math.max(0, Math.min(capShare, capCount));
  const midMin = Math.max(0, midBandMinCount ?? 0);

  const kept: PaperTradingCandidate[] = [];
  const skippedLow: PaperTradingCandidate[] = [];
  let lowKept = 0;
  let midKept = 0;
  for (const c of ordered) {
    if (isLowExtremeShadowEntryPrice(c.entryPrice)) {
      if (lowKept < lowCap) {
        kept.push(c);
        lowKept++;
      } else {
        skippedLow.push(c);
      }
      continue;
    }
    kept.push(c);
    if (isMidBandShadowEntryPrice(c.entryPrice)) midKept++;
  }

  let promoted = 0;
  if (midMin > 0 && midKept < midMin) {
    const seen = new Set(kept.map((c) => c.shadowCandidateId ?? c.recommendationId));
    const missing = midMin - midKept;
    for (const c of ordered) {
      if (promoted >= missing) break;
      if (!isMidBandShadowEntryPrice(c.entryPrice)) continue;
      const id = c.shadowCandidateId ?? c.recommendationId;
      if (seen.has(id)) continue;
      seen.add(id);
      kept.push(c);
      promoted++;
    }
  }

  if (kept.length === 0 && skippedLow.length > 0) {
    kept.push(skippedLow[0]!);
  }

  const lowAfter = countLowExtremeCandidates(kept);
  return {
    biased: kept,
    diagnostics: {
      enabled: true,
      lowExtremeMaxShareEnv: lowExtremeMaxShare,
      lowExtremeMaxCountEnv: lowExtremeMaxCount,
      midBandMinCountEnv: midBandMinCount,
      selectedCountByBandBeforeFinalBias: beforeBands,
      selectedCountByBandAfterFinalBias: countSelectedByDiagnosticsBand(kept),
      lowExtremeDroppedByFinalBias: lowBefore - lowAfter,
      midBandReservedOrPromoted: promoted,
      lowExtremeCountBefore: lowBefore,
      lowExtremeCountAfter: lowAfter,
    },
  };
}

async function findTopRuntimeShadowSubmitters(
  since: Date,
  take: number
): Promise<{ funderAddress: string; _count: { id: number } }[]> {
  const groups = await prisma.shadowCandidate.groupBy({
    by: ["funderAddress"],
    where: {
      wasSubmitted: true,
      wasBlocked: false,
      candidateSource: "runtime_automated",
      createdAt: { gte: since },
    },
    _count: { id: true },
  });
  groups.sort((a, b) => b._count.id - a._count.id);
  return groups.slice(0, take);
}

/**
 * Resolve ShadowCandidate rows for one paper tick: preferred funder + optional extended window + top-submitter fallback
 * when the wallet hint does not match runtime_automated persistence.
 */
export async function loadShadowCandidatesForPaperTick(
  opts: LoadShadowCandidatesForPaperTickOpts
): Promise<{ candidates: PaperTradingCandidate[]; shadowDiagnostics: ShadowTickLoadDiagnostics }> {
  const config = getPaperTradingConfig();
  const L = opts.lookbackMinutes ?? config.shadowLookbackMinutes;
  const allowFb = opts.allowFunderFallback ?? config.paperTickShadowFunderFallback;
  const extCfg = opts.extendedLookbackMinutes ?? config.shadowTickExtendedLookbackMinutes;
  const extendedEnabled = extCfg > 0;
  const extL = extendedEnabled ? Math.max(extCfg, L) : L;
  const preferred = opts.preferredFunder?.trim() ? opts.preferredFunder.trim().toLowerCase() : null;

  const windowForTopMinutes = Math.max(L, extL);
  const sinceForTop = new Date(Date.now() - windowForTopMinutes * 60 * 1000);

  const withPreferredMeta = (diag: ShadowTickLoadDiagnostics): ShadowTickLoadDiagnostics => ({
    ...diag,
    preferredFunderTried: preferred,
  });

  const applyMidRangePriceFilter = (payload: {
    candidates: PaperTradingCandidate[];
    shadowDiagnostics: ShadowTickLoadDiagnostics;
  }): { candidates: PaperTradingCandidate[]; shadowDiagnostics: ShadowTickLoadDiagnostics } => {
    // Bias toward low-probability markets based on observed positive markout in V2 regime.
    const pool = payload.candidates;
    const beforeCount = pool.length;
    type BandKey =
      | "<0.1"
      | "0.1-0.3"
      | "0.3-0.6"
      | "0.6-0.8"
      | "0.8-0.9"
      | ">=0.9"
      | "unknown";
    const bandOf = (c: PaperTradingCandidate): BandKey => {
      const p = parseEntryPrice(c.entryPrice);
      if (p == null || !Number.isFinite(p)) return "unknown";
      if (p < 0.1) return "<0.1";
      if (p < 0.3) return "0.1-0.3";
      if (p < 0.6) return "0.3-0.6";
      if (p < 0.8) return "0.6-0.8";
      if (p < 0.9) return "0.8-0.9";
      return ">=0.9";
    };
    const histogram = (list: PaperTradingCandidate[]): Record<BandKey, number> => {
      const h: Record<BandKey, number> = {
        "<0.1": 0,
        "0.1-0.3": 0,
        "0.3-0.6": 0,
        "0.6-0.8": 0,
        "0.8-0.9": 0,
        ">=0.9": 0,
        unknown: 0,
      };
      for (const c of list) h[bandOf(c)]++;
      return h;
    };

    const byBand: Record<BandKey, PaperTradingCandidate[]> = {
      "<0.1": [],
      "0.1-0.3": [],
      "0.3-0.6": [],
      "0.6-0.8": [],
      "0.8-0.9": [],
      ">=0.9": [],
      unknown: [],
    };
    for (const c of pool) byBand[bandOf(c)].push(c);

    // Primary focus: 0.1-0.3.
    const primary = byBand["0.1-0.3"];
    const secondary = byBand["0.3-0.6"];
    const lowerExploration = byBand["<0.1"];
    const midHigh = byBand["0.6-0.8"];
    const highDeprioritized = byBand["0.8-0.9"];
    const tailHigh = byBand[">=0.9"];

    const expansionThreshold = parsePaperShadowExpansionTarget(36);
    const expansionMax = parsePaperShadowExpansionMax(expansionThreshold, 80);
    const perMarketCap = parsePaperShadowExpansionPerMarketCap(3);

    const marketTally = new Map<string, number>();
    const selectedIds = new Set<string>();
    const selected: PaperTradingCandidate[] = [];

    for (const c of primary) {
      const id = c.shadowCandidateId ?? c.recommendationId;
      selected.push(c);
      selectedIds.add(id);
      marketTally.set(c.marketId, (marketTally.get(c.marketId) ?? 0) + 1);
    }

    const secondaryCap = Math.max(2, Math.floor(primary.length * 0.5));
    selected.push(
      ...takeWithPerMarketCapExcluding(secondary, secondaryCap, perMarketCap, marketTally, selectedIds)
    );

    if (selected.length < expansionThreshold && beforeCount > 0) {
      const need = expansionThreshold - selected.length;
      selected.push(
        ...takeWithPerMarketCapExcluding(lowerExploration, need, perMarketCap, marketTally, selectedIds)
      );
    }
    if (selected.length < expansionThreshold && beforeCount > 0) {
      const need = expansionThreshold - selected.length;
      selected.push(...takeWithPerMarketCapExcluding(secondary, need, perMarketCap, marketTally, selectedIds));
    }
    if (selected.length < expansionThreshold && beforeCount > 0) {
      const need = expansionThreshold - selected.length;
      selected.push(...takeWithPerMarketCapExcluding(midHigh, need, perMarketCap, marketTally, selectedIds));
    }
    if (selected.length < expansionThreshold && beforeCount > 0) {
      const need = expansionThreshold - selected.length;
      selected.push(
        ...takeWithPerMarketCapExcluding(
          highDeprioritized,
          Math.min(1, need),
          perMarketCap,
          marketTally,
          selectedIds
        )
      );
    }
    if (selected.length < expansionThreshold && beforeCount > 0) {
      const need = expansionThreshold - selected.length;
      selected.push(...takeWithPerMarketCapExcluding(tailHigh, need, perMarketCap, marketTally, selectedIds));
    }

    const seenIds = new Set<string>();
    let filtered = selected.filter((c) => {
      const id = c.shadowCandidateId ?? c.recommendationId;
      if (seenIds.has(id)) return false;
      seenIds.add(id);
      return true;
    });

    let trimmedForMax = false;
    if (filtered.length > expansionMax) {
      filtered = filtered.slice(0, expansionMax);
      trimmedForMax = true;
    }

    const extremeShareEnv = parsePaperShadowExtremeBandMaxShare();
    const extremeCountEnv = parsePaperShadowExtremeBandMaxCount();
    const { capped: afterExtremeCap, diagnostics: extremeBandCap } = applyExtremeBandCandidateCap(
      filtered,
      extremeShareEnv,
      extremeCountEnv
    );
    filtered = afterExtremeCap;
    const lowExtremeMaxShareEnv = parsePaperShadowLowExtremeMaxShare();
    const lowExtremeMaxCountEnv = parsePaperShadowLowExtremeMaxCount();
    const midBandMinCountEnv = parsePaperShadowMidBandMinCount();
    const { biased: afterFinalSelectionBias, diagnostics: finalSelectionBias } =
      applyFinalSelectionLowExtremeBias(
        filtered,
        lowExtremeMaxShareEnv,
        lowExtremeMaxCountEnv,
        midBandMinCountEnv
      );
    filtered = afterFinalSelectionBias;

    const expansionBreadth = computeExpansionBreadthDiagnostics(
      filtered,
      beforeCount,
      expansionThreshold,
      expansionMax,
      perMarketCap
    );

    console.info("[paper-trading] candidate price-band bias", {
      phase: "before_filter",
      totalCandidates: beforeCount,
      byBand: histogram(pool),
    });
    console.info("[paper-trading] candidate price-band bias", {
      phase: "after_filter",
      totalCandidates: filtered.length,
      byBand: histogram(filtered),
      primaryBand: "0.1-0.3",
      secondaryBand: "0.3-0.6 (capped exploration)",
      deprioritizedBand: "0.8-0.9 (last-resort cap<=1)",
      adaptiveExpansion: "low-first: <0.1 -> extra 0.3-0.6 -> 0.6-0.8 -> 0.8-0.9 -> >=0.9",
      expansionTarget: expansionThreshold,
      expansionMax,
      perMarketCap,
      trimmedToExpansionMax: trimmedForMax,
      expansionBreadth,
    });
    console.info("[paper-trading] extreme-band cap (upstream loader)", {
      phase: "after_extreme_band_cap",
      ...extremeBandCap,
    });
    console.info("[paper-trading] final selection bias (low extreme vs mid)", {
      phase: "after_final_selection_bias",
      ...finalSelectionBias,
    });

    return {
      candidates: filtered,
      shadowDiagnostics: {
        ...payload.shadowDiagnostics,
        candidatesLoaded: filtered.length,
        candidateIds: filtered.map((c) => c.shadowCandidateId!).filter(Boolean),
        expansionBreadth,
        extremeBandCap,
        finalSelectionBias,
        zeroCandidatesReason:
          filtered.length === 0 && beforeCount > 0
            ? "price_low_probability_bias_filter_removed_all"
            : payload.shadowDiagnostics.zeroCandidatesReason,
      },
    };
  };

  if (preferred == null) {
    const tops = await findTopRuntimeShadowSubmitters(sinceForTop, 8);
    const topSubmittersByCount = tops.map((t) => ({ funderAddress: t.funderAddress, count: t._count.id }));
    if (tops.length === 0) {
      return applyMidRangePriceFilter({
        candidates: [],
        shadowDiagnostics: {
          shadowRowsQueried: 0,
          shadowRowsSkippedNoMarket: 0,
          shadowRowsSkippedZeroBuySize: 0,
          dedupeDroppedCount: 0,
          candidatesLoaded: 0,
          candidateIds: [],
          zeroCandidatesReason: "no_shadow_runtime_submissions_in_window",
          lookbackMinutes: L,
          funderUsedForLoad: "",
          preferredFunderTried: null,
          usedFunderFallback: false,
          extendedLookbackTriedMinutes: null,
          topSubmittersByCount,
        },
      });
    }
    const f = tops[0].funderAddress.toLowerCase();
    const r = await getSubmittedShadowCandidatesForTickWithDiagnostics({
      funderAddress: f,
      lookbackMinutes: windowForTopMinutes,
    });
    return applyMidRangePriceFilter({
      candidates: r.candidates,
      shadowDiagnostics: {
        ...withPreferredMeta(r.shadowDiagnostics),
        topSubmittersByCount,
        usedFunderFallback: false,
      },
    });
  }

  let r = await getSubmittedShadowCandidatesForTickWithDiagnostics({
    funderAddress: preferred,
    lookbackMinutes: L,
  });
  let extendedLookbackTriedMinutes: number | null = null;
  if (r.shadowDiagnostics.shadowRowsQueried === 0 && extendedEnabled && extL > L) {
    r = await getSubmittedShadowCandidatesForTickWithDiagnostics({
      funderAddress: preferred,
      lookbackMinutes: extL,
    });
    extendedLookbackTriedMinutes = extL;
  }

  let shadowDiagnostics = withPreferredMeta({
    ...r.shadowDiagnostics,
    extendedLookbackTriedMinutes,
  });

  if (shadowDiagnostics.shadowRowsQueried === 0 && allowFb) {
    const tops = await findTopRuntimeShadowSubmitters(sinceForTop, 8);
    const topSubmittersByCount = tops.map((t) => ({ funderAddress: t.funderAddress, count: t._count.id }));
    const alt = tops.find((t) => t.funderAddress.toLowerCase() !== preferred.toLowerCase());
    if (alt?.funderAddress) {
      const f = alt.funderAddress.toLowerCase();
      const rFb = await getSubmittedShadowCandidatesForTickWithDiagnostics({
        funderAddress: f,
        lookbackMinutes: windowForTopMinutes,
      });
      if (rFb.shadowDiagnostics.shadowRowsQueried > 0) {
        return applyMidRangePriceFilter({
          candidates: rFb.candidates,
          shadowDiagnostics: {
            ...withPreferredMeta(rFb.shadowDiagnostics),
            usedFunderFallback: true,
            topSubmittersByCount,
            extendedLookbackTriedMinutes,
          },
        });
      }
    }
    return applyMidRangePriceFilter({
      candidates: r.candidates,
      shadowDiagnostics: {
        ...shadowDiagnostics,
        topSubmittersByCount,
      },
    });
  }

  return applyMidRangePriceFilter({
    candidates: r.candidates,
    shadowDiagnostics,
  });
}

function dedupeKeyMarketSide(marketId: string, side: string): string {
  return `${marketId}\0${side.toUpperCase()}`;
}

/**
 * Load runtime_automated ShadowCandidate rows that were submitted, within a recent createdAt window.
 * Dedupes by (marketId, side) keeping the newest row. Uses createdAt as proxy for decision time (decidedAt lives inside decisionSnapshotJson only).
 */
export async function getSubmittedShadowCandidatesForTick(
  opts: GetSubmittedShadowCandidatesForTickOptions
): Promise<PaperTradingCandidate[]> {
  const { candidates } = await getSubmittedShadowCandidatesForTickWithDiagnostics(opts);
  return candidates;
}

export async function getSubmittedShadowCandidatesForTickWithDiagnostics(
  opts: GetSubmittedShadowCandidatesForTickOptions
): Promise<{ candidates: PaperTradingCandidate[]; shadowDiagnostics: ShadowTickLoadDiagnostics }> {
  const funder = opts.funderAddress.toLowerCase().trim();
  const config = getPaperTradingConfig();
  const lookbackMinutes = opts.lookbackMinutes ?? config.shadowLookbackMinutes;
  const since = new Date(Date.now() - lookbackMinutes * 60 * 1000);

  const rows = await prisma.shadowCandidate.findMany({
    where: {
      funderAddress: funder,
      wasSubmitted: true,
      wasBlocked: false,
      candidateSource: "runtime_automated",
      createdAt: { gte: since },
    },
    orderBy: { createdAt: "desc" },
    take: 500,
  });

  const diag: ShadowTickLoadDiagnostics = {
    shadowRowsQueried: rows.length,
    shadowRowsSkippedNoMarket: 0,
    shadowRowsSkippedZeroBuySize: 0,
    dedupeDroppedCount: 0,
    candidatesLoaded: 0,
    candidateIds: [],
    zeroCandidatesReason: "",
    lookbackMinutes,
    funderUsedForLoad: funder,
  };

  if (rows.length === 0) {
    diag.zeroCandidatesReason = "no_submitted_shadow_rows_in_lookback";
    return { candidates: [], shadowDiagnostics: diag };
  }

  const groupsByKey = new Map<string, typeof rows>();
  for (const r of rows) {
    const mid = resolvedMarketIdForShadowRow(r);
    if (!mid) {
      diag.shadowRowsSkippedNoMarket++;
      continue;
    }
    const side = r.side.toUpperCase() === "SELL" ? "SELL" : "BUY";
    const k = dedupeKeyMarketSide(mid, side);
    const arr = groupsByKey.get(k) ?? [];
    arr.push(r);
    groupsByKey.set(k, arr);
  }

  const preferGoodBandWinner = shouldPreferGoodBandsForDedupeWinner();
  const deduped: typeof rows = [];
  const currentWinnerBandCounts = new Map<string, number>();
  const preferredWinnerBandCounts = new Map<string, number>();
  const changedKeysSample: { dedupeKey: string; currentWinnerBand: string; preferredWinnerBand: string }[] = [];
  let keysWinnerChanged = 0;

  for (const [k, group] of groupsByKey.entries()) {
    if (!group.length) continue;
    const currentWinner = group[0]!;
    const currentBand = dedupeBandLabel(currentWinner.intendedPrice);
    currentWinnerBandCounts.set(currentBand, (currentWinnerBandCounts.get(currentBand) ?? 0) + 1);

    let chosen = currentWinner;
    if (preferGoodBandWinner) {
      const preferredWinner =
        group.find((r) => dedupeBandLabel(r.intendedPrice) === "0.2-0.3") ??
        group.find((r) => dedupeBandLabel(r.intendedPrice) === "0.4-0.6") ??
        currentWinner;
      chosen = preferredWinner;
      if (preferredWinner.id !== currentWinner.id) {
        keysWinnerChanged++;
        if (changedKeysSample.length < 40) {
          changedKeysSample.push({
            dedupeKey: k,
            currentWinnerBand: currentBand,
            preferredWinnerBand: dedupeBandLabel(preferredWinner.intendedPrice),
          });
        }
      }
    }
    const chosenBand = dedupeBandLabel(chosen.intendedPrice);
    preferredWinnerBandCounts.set(chosenBand, (preferredWinnerBandCounts.get(chosenBand) ?? 0) + 1);
    deduped.push(chosen);
    diag.dedupeDroppedCount += Math.max(0, group.length - 1);
  }

  diag.dedupeWinnerChoice = {
    enabled: preferGoodBandWinner,
    keysEvaluated: groupsByKey.size,
    keysWinnerChanged,
    currentWinnerBandCounts: Object.fromEntries(currentWinnerBandCounts.entries()),
    preferredWinnerBandCounts: Object.fromEntries(preferredWinnerBandCounts.entries()),
    ...(changedKeysSample.length > 0 ? { changedKeysSample } : {}),
  };

  const marketIds = Array.from(new Set(deduped.map((r) => resolvedMarketIdForShadowRow(r)!).filter(Boolean)));
  const assets = await prisma.syncedAsset.findMany({
    where: { syncedMarketId: { in: marketIds } },
    select: {
      syncedMarketId: true,
      outcome: true,
      tokenId: true,
      syncedMarket: { select: { category: true } },
    },
  });
  const byMarketAndToken = new Map<string, (typeof assets)[0]>();
  for (const a of assets) {
    byMarketAndToken.set(`${a.syncedMarketId}\0${a.tokenId}`, a);
  }

  const out: PaperTradingCandidate[] = [];
  for (const r of deduped) {
    const mid = resolvedMarketIdForShadowRow(r)!;
    const side = r.side.toUpperCase() === "SELL" ? "SELL" : "BUY";
    const sizeNum = parseNum(r.intendedSize);
    if (side === "BUY" && sizeNum <= 0) {
      diag.shadowRowsSkippedZeroBuySize++;
      continue;
    }

    const asset = byMarketAndToken.get(`${mid}\0${r.assetId}`);
    const outcome = asset?.outcome ?? "";
    const theme: string | null = null;
    const category = asset?.syncedMarket?.category ?? null;

    const policy = parseExecutionPolicySnapshot(r.executionPolicySnapshotJson);
    const execState = policy?.policyState ?? null;
    const decision = parseDecisionSnapshot(r.decisionSnapshotJson);
    const decisionPolicyState = decision?.policyState ?? null;
    const paperStaged = resolvePaperStagedPolicyLabel(execState, decisionPolicyState);

    const shadowInput = buildShadowScoreInputFromShadowCandidateRow(r);
    const entryPriceNum = parseEntryPrice(r.intendedPrice);
    const entryPriceBand = classifyEntryPriceBand(entryPriceNum);

    const recommendationId = r.recommendationId?.trim() || `shadow:${r.id}`;
    const recoThesis = parseRecoThesisFromDecisionSnapshotJson(r.decisionSnapshotJson);
    if (process.env.PAPER_RECO_THESIS_TRACE === "1") {
      console.info("[paper-reco-thesis-trace]", {
        shadowCandidateId: r.id,
        strategyFamily: recoThesis.strategyFamily ?? null,
        strategyVariant: recoThesis.strategyVariant ?? null,
        hypothesisType: recoThesis.hypothesisType ?? null,
      });
    }

    out.push({
      shadowCandidateId: r.id,
      recommendationId,
      marketId: mid,
      assetId: r.assetId,
      outcome,
      side,
      entryPrice: r.intendedPrice,
      intendedSize: r.intendedSize,
      theme,
      category,
      sourceDecisionState: paperStaged ?? undefined,
      executionPolicyState: execState,
      paperStagedPolicyState: paperStaged,
      entryPriceBand,
      shadowInput,
      ...recoThesis,
    });
  }

  diag.candidatesLoaded = out.length;
  diag.candidateIds = out.map((c) => c.shadowCandidateId!).filter(Boolean);
  if (out.length === 0) {
    if (diag.shadowRowsSkippedNoMarket === rows.length) {
      diag.zeroCandidatesReason = "all_rows_missing_marketId";
    } else if (diag.shadowRowsSkippedZeroBuySize > 0 && diag.dedupeDroppedCount + diag.shadowRowsSkippedNoMarket === rows.length - 0) {
      diag.zeroCandidatesReason = "zero_buy_size_or_dedupe_removed_all";
    } else {
      diag.zeroCandidatesReason = "filtering_removed_all";
    }
  }

  return { candidates: out, shadowDiagnostics: diag };
}

/** Why a candidate was excluded by {@link filterShadowCandidatesForProfile} (paper-only; no ML/threshold). */
export type PaperProfileFilterRejectReason =
  | "block"
  | "review_required"
  | "price_band"
  | "excluded_theme"
  | "excluded_category";

function emptyProfileFilterRejectCounts(): Record<PaperProfileFilterRejectReason, number> {
  return {
    block: 0,
    review_required: 0,
    price_band: 0,
    excluded_theme: 0,
    excluded_category: 0,
  };
}

/**
 * First matching exclusion wins (same order as the filter).
 * Does not use allowedPolicyStates whitelist: ALLOW_* / TRIM / EXIT / unknown staged pass;
 * only hard-gates BLOCK and REVIEW_REQUIRED (when profile disallows).
 */
export function computePaperProfileFilterRejectReason(
  c: PaperTradingCandidate,
  profile: EffectiveBotProfile
): PaperProfileFilterRejectReason | null {
  const staged = c.paperStagedPolicyState ?? null;
  if (staged === "BLOCK") return "block";
  if (staged === "REVIEW_REQUIRED" && !profile.allowReviewRequired) return "review_required";
  const band = c.entryPriceBand;
  if (profile.allowedPriceBands?.length && band && !profile.allowedPriceBands.includes(band)) {
    return "price_band";
  }
  if (profile.excludedThemes.length && c.theme && profile.excludedThemes.includes(c.theme)) {
    return "excluded_theme";
  }
  if (profile.excludedCategories.length && c.category && profile.excludedCategories.includes(c.category)) {
    return "excluded_category";
  }
  return null;
}

export interface FilterShadowCandidatesForProfileDiagnostics {
  kept: PaperTradingCandidate[];
  beforeCount: number;
  afterCount: number;
  rejectByReason: Record<PaperProfileFilterRejectReason, number>;
}

/**
 * Profile filter with per-reason counts and optional logging when the pool is wiped.
 */
export function filterShadowCandidatesForProfileWithDiagnostics(
  candidates: PaperTradingCandidate[],
  profile: EffectiveBotProfile,
  options?: { logRemovedAll?: boolean }
): FilterShadowCandidatesForProfileDiagnostics {
  const beforeCount = candidates.length;
  const rejectByReason = emptyProfileFilterRejectCounts();
  const kept: PaperTradingCandidate[] = [];
  for (const c of candidates) {
    const reason = computePaperProfileFilterRejectReason(c, profile);
    if (reason != null) {
      rejectByReason[reason]++;
      continue;
    }
    kept.push(c);
  }
  const afterCount = kept.length;
  if (options?.logRemovedAll && beforeCount > 0 && afterCount === 0) {
    const stagedHistogram: Record<string, number> = {};
    const bandHistogram: Record<string, number> = {};
    for (const x of candidates) {
      const sk = x.paperStagedPolicyState ?? "null";
      stagedHistogram[sk] = (stagedHistogram[sk] ?? 0) + 1;
      const bk = x.entryPriceBand ?? "null";
      bandHistogram[bk] = (bandHistogram[bk] ?? 0) + 1;
    }
    console.warn("[paper-trading] filterShadowCandidatesForProfile removed all candidates", {
      botType: profile.botType,
      displayName: profile.displayName,
      beforeCount,
      rejectByReason,
      stagedPolicyHistogram: stagedHistogram,
      entryPriceBandHistogram: bandHistogram,
    });
  }
  return { kept, beforeCount, afterCount, rejectByReason };
}

export function filterShadowCandidatesForProfile(
  candidates: PaperTradingCandidate[],
  profile: EffectiveBotProfile
): PaperTradingCandidate[] {
  return filterShadowCandidatesForProfileWithDiagnostics(candidates, profile).kept;
}

/** Sample row for snapshot-match diagnostics (legacy field shape for tools). */
export interface SnapshotMatchSample {
  recommendationId: string;
  funderUsed: string;
  snapshotExists: boolean;
  snapshotFunderAddresses?: string[];
}

/** One row in sampleFilteredByPolicy. */
export interface PolicyFilterSample {
  recommendationId: string;
  policyState: string;
  finalSuggestedSize: string;
  reason: string;
}

/** Diagnostics when loading candidates. */
export interface PaperTradingLoadDiagnostics {
  recommendationsFound: number;
  noDecisionSnapshot: number;
  afterPolicyFilter: number;
  noAssetResolve: number;
  zeroSizeBuy: number;
  candidatesLoaded: number;
  zeroCandidatesReason: string;
  sampleSnapshotCheck?: SnapshotMatchSample[];
  policyStateCounts?: Record<string, number>;
  filteredByPolicyStateCount?: number;
  /** Per-reason drops from filterShadowCandidatesForProfile (paper-only). */
  profileFilterRejectByReason?: Record<string, number>;
  profileFilterBeforeCount?: number;
  profileFilterAfterCount?: number;
  avoidedCount?: number;
  allowedCount?: number;
  zeroSizeAfterPolicyCount?: number;
  sampleFilteredByPolicy?: PolicyFilterSample[];
  relaxedBlockedCount?: number;
  relaxedByReasonCounts?: Record<string, number>;
  candidatesPassedViaRelaxation?: number;
  blockedCandidatesSeen?: number;
  paperRelaxationEligible?: number;
  paperRelaxationRejected?: number;
  paperRelaxationAccepted_edgeTooSmall?: number;
  paperRelaxationAccepted_liquidityTooLow?: number;
  paperRelaxationAccepted_multiAllowed?: number;
  paperRelaxationAccepted_concentrationHigh?: number;
  relaxedCandidatesConsidered?: number;
  relaxedDropped_actionTypeAvoid?: number;
  relaxedDropped_actionTypeSyncFirst?: number;
  relaxedDropped_missingAssetResolution?: number;
  relaxedDropped_missingSide?: number;
  relaxedDropped_missingPriceContext?: number;
  relaxedDropped_other?: number;
  relaxedBuiltSuccessfully?: number;
  /** Shadow tick load (runtime_automated). */
  shadowRowsQueried?: number;
  shadowCandidateIds?: string[];
  shadowDedupeDropped?: number;
  shadowRowsSkippedNoMarket?: number;
  shadowRowsSkippedZeroBuySize?: number;
  shadowLookbackMinutes?: number;
  shadowPreferredFunderTried?: string | null;
  shadowFunderUsedForLoad?: string;
  shadowUsedFunderFallback?: boolean;
  shadowExtendedLookbackTriedMinutes?: number;
  shadowTopSubmittersByCount?: { funderAddress: string; count: number }[];
  shadowExpansionBreadth?: ShadowExpansionBreadthDiagnostics;
  shadowExtremeBandCap?: ShadowExtremeBandCapDiagnostics;
  shadowFinalSelectionBias?: ShadowFinalSelectionBiasDiagnostics;
  shadowDedupeWinnerChoice?: ShadowTickLoadDiagnostics["dedupeWinnerChoice"];
}

/** Map shadow tick diagnostics to PaperTradingLoadDiagnostics (no profile filter). */
export function paperLoadDiagnosticsFromShadowOnly(shadow: ShadowTickLoadDiagnostics): PaperTradingLoadDiagnostics {
  return mergeShadowDiagnosticsIntoLoadDiagnostics(
    shadow,
    shadow.candidatesLoaded,
    shadow.candidatesLoaded,
    0
  );
}

export function mergeShadowDiagnosticsIntoLoadDiagnostics(
  shadow: ShadowTickLoadDiagnostics,
  afterProfileCount: number,
  beforeProfileCount: number,
  profileFilteredOut: number,
  profileFilterDetail?: {
    rejectByReason: Record<string, number>;
  }
): PaperTradingLoadDiagnostics {
  const policyStateCounts: Record<string, number> = {};
  return {
    recommendationsFound: shadow.shadowRowsQueried,
    noDecisionSnapshot: 0,
    afterPolicyFilter: afterProfileCount,
    noAssetResolve: 0,
    zeroSizeBuy: shadow.shadowRowsSkippedZeroBuySize,
    candidatesLoaded: afterProfileCount,
    zeroCandidatesReason:
      afterProfileCount === 0
        ? shadow.candidatesLoaded === 0
          ? shadow.zeroCandidatesReason
          : profileFilteredOut > 0
            ? "profile_filter_removed_all"
            : "unknown_empty"
        : "",
    policyStateCounts,
    filteredByPolicyStateCount: profileFilteredOut,
    profileFilterRejectByReason: profileFilterDetail?.rejectByReason,
    profileFilterBeforeCount: beforeProfileCount,
    profileFilterAfterCount: afterProfileCount,
    avoidedCount: 0,
    allowedCount: afterProfileCount,
    shadowRowsQueried: shadow.shadowRowsQueried,
    shadowCandidateIds: shadow.candidateIds,
    shadowDedupeDropped: shadow.dedupeDroppedCount,
    shadowRowsSkippedNoMarket: shadow.shadowRowsSkippedNoMarket,
    shadowRowsSkippedZeroBuySize: shadow.shadowRowsSkippedZeroBuySize,
    shadowLookbackMinutes: shadow.lookbackMinutes,
    shadowPreferredFunderTried: shadow.preferredFunderTried,
    shadowFunderUsedForLoad: shadow.funderUsedForLoad,
    shadowUsedFunderFallback: shadow.usedFunderFallback,
    shadowExtendedLookbackTriedMinutes: shadow.extendedLookbackTriedMinutes ?? undefined,
    shadowTopSubmittersByCount: shadow.topSubmittersByCount,
    shadowExpansionBreadth: shadow.expansionBreadth,
    shadowExtremeBandCap: shadow.extremeBandCap,
    shadowFinalSelectionBias: shadow.finalSelectionBias,
    shadowDedupeWinnerChoice: shadow.dedupeWinnerChoice,
  };
}

/**
 * Fetch paper candidates from submitted runtime ShadowCandidates; diagnostics explain empty results.
 */
export async function getPaperTradingCandidatesWithDiagnostics(
  funderAddress?: string | null
): Promise<{ candidates: PaperTradingCandidate[]; loadDiagnostics: PaperTradingLoadDiagnostics }> {
  const preferred = normalizePreferredFunderForShadowLoad(funderAddress ?? null);
  const { candidates, shadowDiagnostics } = await loadShadowCandidatesForPaperTick({
    preferredFunder: preferred,
  });
  const loadDiagnostics = mergeShadowDiagnosticsIntoLoadDiagnostics(shadowDiagnostics, candidates.length, candidates.length, 0);
  if (candidates.length === 0 && !loadDiagnostics.zeroCandidatesReason) {
    loadDiagnostics.zeroCandidatesReason = shadowDiagnostics.zeroCandidatesReason;
  }
  return { candidates, loadDiagnostics };
}

export async function getPaperTradingCandidates(funderAddress?: string | null): Promise<PaperTradingCandidate[]> {
  const { candidates } = await getPaperTradingCandidatesWithDiagnostics(funderAddress);
  return candidates;
}

/**
 * Profile-aware filters (price band, theme/category, staged policy vs execution-derived labels).
 */
export async function getPaperTradingCandidatesForProfile(
  profile: BotProfile | EffectiveBotProfile,
  funderAddress?: string | null
): Promise<{ candidates: PaperTradingCandidate[]; loadDiagnostics: PaperTradingLoadDiagnostics }> {
  const preferred = normalizePreferredFunderForShadowLoad(funderAddress ?? null);
  const { candidates: raw, shadowDiagnostics } = await loadShadowCandidatesForPaperTick({
    preferredFunder: preferred,
  });
  const filterDiag = filterShadowCandidatesForProfileWithDiagnostics(raw, profile as EffectiveBotProfile, {
    logRemovedAll: true,
  });
  const filtered = filterDiag.kept;
  const profileFilteredOut = filterDiag.beforeCount - filterDiag.afterCount;
  const loadDiagnostics = mergeShadowDiagnosticsIntoLoadDiagnostics(
    shadowDiagnostics,
    filtered.length,
    raw.length,
    profileFilteredOut,
    { rejectByReason: filterDiag.rejectByReason }
  );
  if (filtered.length === 0 && raw.length > 0) {
    loadDiagnostics.zeroCandidatesReason = "profile_filter_removed_all";
  } else if (filtered.length === 0 && raw.length === 0) {
    loadDiagnostics.zeroCandidatesReason = shadowDiagnostics.zeroCandidatesReason;
  }
  return { candidates: filtered, loadDiagnostics };
}
