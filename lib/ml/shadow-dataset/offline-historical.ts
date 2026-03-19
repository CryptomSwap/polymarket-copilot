/**
 * Offline historical dataset builder: create MlShadowTrainingExample rows from past
 * market price data only. No ShadowCandidate, order submission, or execution policy.
 * Uses MarketPriceSnapshot and the same markout/outcome/label semantics as the live path.
 */

import { prisma } from "@/lib/db";
import { markout, classify } from "@/lib/shadow-evaluation/markout";
import { deriveLabels } from "./build";
import type { OutcomeClassification } from "./types";

const HORIZON_24H_MS = 24 * 60 * 60 * 1000;
const HORIZON_1H_MS = 60 * 60 * 1000;
const HORIZON_6H_MS = 6 * HORIZON_1H_MS;
const HORIZON_12H_MS = 12 * HORIZON_1H_MS;
const DEFAULT_INTERVAL_HOURS = 24;
const DEFAULT_LIMIT = 10_000;
/** Liquidity (numeric) above this is treated as tradable / quality "good". */
const LIQUIDITY_MIN_FOR_GOOD = 50;

type Point = { capturedAt: Date; price: number; liquidity: number; volume: number };

function parseNum(s: string | null | undefined): number | null {
  if (s == null || s === "") return null;
  const n = parseFloat(String(s).trim());
  return Number.isFinite(n) ? n : null;
}

/** Get value at or before `at` from sorted snapshots; getter returns the field to use. */
function valueAtOrBefore<T>(points: Point[], at: Date, getter: (p: Point) => number): number | null {
  if (points.length === 0) return null;
  let lo = 0;
  let hi = points.length - 1;
  if (points[0].capturedAt > at) return null;
  if (points[hi].capturedAt <= at) return getter(points[hi]);
  while (lo < hi - 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (points[mid].capturedAt <= at) lo = mid;
    else hi = mid;
  }
  return points[lo].capturedAt <= at ? getter(points[lo]) : null;
}

function priceAtOrBefore(points: Point[], at: Date): number | null {
  return valueAtOrBefore(points, at, (p) => p.price);
}

function volatilityBps(points: Point[], t: number, windowMs: number): number {
  const start = new Date(t - windowMs);
  const end = new Date(t);
  let minP = Infinity;
  let maxP = -Infinity;
  for (const p of points) {
    if (p.capturedAt >= start && p.capturedAt <= end && p.price > 0) {
      minP = Math.min(minP, p.price);
      maxP = Math.max(maxP, p.price);
    }
  }
  if (minP === Infinity || maxP === 0) return 0;
  const mid = (minP + maxP) / 2;
  return mid > 0 ? ((maxP - minP) / mid) * 10000 : 0;
}

/** Volatility in window [t-24h, t]: (max - min) / mid, scaled to bps. */
function volatility24hBps(points: Point[], t: number): number {
  return volatilityBps(points, t, HORIZON_24H_MS);
}

function volatility1hBps(points: Point[], t: number): number {
  return volatilityBps(points, t, HORIZON_1H_MS);
}

function volatility6hBps(points: Point[], t: number): number {
  return volatilityBps(points, t, HORIZON_6H_MS);
}

export interface BuildOfflineHistoricalOptions {
  /** Start of decision-time range (inclusive). */
  from: Date;
  /** End of decision-time range (inclusive). */
  to: Date;
  /** Funder address to set on rows (default "offline"). */
  funderAddress?: string;
  /** Side to assume for all synthetic candidates (default "BUY"). */
  side?: "BUY" | "SELL";
  /** Sample one decision time per N hours per (marketId, assetId) (default 24). */
  intervalHours?: number;
  /** Max examples to build in one run (default 10000). */
  limit?: number;
  /** Optional market IDs to restrict to. */
  marketIds?: string[];
}

export interface OfflineHistoricalRow {
  shadowCandidateId: string;
  funderAddress: string;
  assetId: string;
  marketId: string;
  candidateSource: string;
  createdAt: Date;
  side: string;
  intendedPrice: string;
  intendedSize: string;
  policyState: string | null;
  sizeMultiplier: string | null;
  finalSuggestedSize: string | null;
  eligibilityBlockersCount: number;
  reducedSizeIndicator: boolean;
  blockedIndicator: boolean;
  executionAllow: boolean | null;
  executionBlockingReasonGroups: string | null;
  executionWarningCount: number;
  qualityState: string | null;
  spreadBps: string | null;
  estimatedSlippage: string | null;
  depthSufficiency: string | null;
  quoteFreshnessState: string | null;
  tradable: boolean | null;
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
  runtimeSafetyState: string | null;
  runtimeWarningCount: number;
  runtimeBlockingCount: number;
  recommendationPresent: boolean;
  outcomeBlockedVsAllowedVsSubmitted: string;
  markout1h: string | null;
  markout6h: string | null;
  markout12h: string | null;
  markout24h: string | null;
  outcomeClassification: OutcomeClassification | null;
  wasBlocked: boolean;
  wasSubmitted: boolean;
  wasFilled: boolean | null;
  labelGoodDecision: boolean | null;
  labelGoodDecision6h: boolean | null;
  labelGoodDecision12h: boolean | null;
  labelBadDecision: boolean | null;
  labelMissedOpportunity: boolean | null;
  labelExecutionUnsafe: boolean | null;
  momentum1hBps: string | null;
  momentum6hBps: string | null;
  volatility1hBps: string | null;
  volatility6hBps: string | null;
  distanceFromMid: string | null;
  timeToCloseHours: string | null;
  liquidityTrend: string | null;
}

/**
 * Build offline historical training rows from MarketPriceSnapshot only.
 * Does not persist; returns rows and stats.
 */
export async function buildOfflineHistoricalExamples(
  options: BuildOfflineHistoricalOptions
): Promise<{ rows: OfflineHistoricalRow[]; errors: string[] }> {
  const {
    from,
    to,
    funderAddress = "offline",
    side = "BUY",
    intervalHours = DEFAULT_INTERVAL_HOURS,
    limit = DEFAULT_LIMIT,
    marketIds,
  } = options;

  const errors: string[] = [];
  const intervalMs = intervalHours * 60 * 60 * 1000;
  const toPlus24h = new Date(to.getTime() + HORIZON_24H_MS);
  /** Load 24h before `from` so momentum/volatility at first decision time have prior points. */
  const fromMinus24h = new Date(from.getTime() - HORIZON_24H_MS);

  const where: { capturedAt: { gte: Date; lte: Date }; marketId?: { in: string[] } } = {
    capturedAt: { gte: fromMinus24h, lte: toPlus24h },
  };
  if (marketIds?.length) where.marketId = { in: marketIds };

  const snapshots = await prisma.marketPriceSnapshot.findMany({
    where,
    orderBy: { capturedAt: "asc" },
    select: { marketId: true, assetId: true, price: true, liquidity: true, volume: true, capturedAt: true },
  });

  type PairKey = string;
  const byPair = new Map<PairKey, { marketId: string; assetId: string; points: Point[] }>();
  for (const s of snapshots) {
    const p = parseNum(s.price);
    if (p == null || p <= 0) continue;
    const liquidity = parseNum(s.liquidity) ?? 0;
    const volume = parseNum(s.volume) ?? 0;
    const k: PairKey = `${s.marketId}\t${s.assetId}`;
    if (!byPair.has(k)) {
      byPair.set(k, { marketId: s.marketId, assetId: s.assetId, points: [] });
    }
    byPair.get(k)!.points.push({
      capturedAt: s.capturedAt,
      price: p,
      liquidity,
      volume,
    });
  }

  // Batch-fetch market end dates for timeToCloseHours
  const uniqueMarketIds = [...new Set([...byPair.values()].map((x) => x.marketId))];
  const markets =
    uniqueMarketIds.length > 0
      ? await prisma.syncedMarket.findMany({
          where: {
            OR: [{ id: { in: uniqueMarketIds } }, { conditionId: { in: uniqueMarketIds } }],
          },
          select: { id: true, conditionId: true, endDate: true },
        })
      : [];
  const marketEndDateByRef = new Map<string, Date>();
  for (const m of markets) {
    if (m.endDate) {
      const d = m.endDate instanceof Date ? m.endDate : new Date(m.endDate);
      if (m.id) marketEndDateByRef.set(m.id, d);
      if (m.conditionId) marketEndDateByRef.set(m.conditionId, d);
    }
  }

  const rows: OfflineHistoricalRow[] = [];
  for (const { marketId, assetId, points } of byPair.values()) {
    if (points.length < 2) continue;
    const endDate = marketEndDateByRef.get(marketId) ?? null;
    let t = from.getTime();
    const endTs = to.getTime();
    while (t <= endTs && rows.length < limit) {
      const decisionAt = new Date(t);
      const at6h = new Date(t + HORIZON_6H_MS);
      const at12h = new Date(t + HORIZON_12H_MS);
      const at24h = new Date(t + HORIZON_24H_MS);
      const price0 = priceAtOrBefore(points, decisionAt);
      const price6h = priceAtOrBefore(points, at6h);
      const price12h = priceAtOrBefore(points, at12h);
      const price24h = priceAtOrBefore(points, at24h);
      if (price0 == null || price24h == null || price0 <= 0) {
        t += intervalMs;
        continue;
      }
      const m24h = markout(side, price0, price24h);
      if (m24h == null) {
        t += intervalMs;
        continue;
      }
      const outcome = classify(false, side, m24h);
      if (outcome == null) {
        t += intervalMs;
        continue;
      }
      const labels = deriveLabels(outcome, false, false);

      const m6h = price6h != null ? markout(side, price0, price6h) : null;
      const m12h = price12h != null ? markout(side, price0, price12h) : null;
      const outcome6h = m6h != null ? classify(false, side, m6h) : null;
      const outcome12h = m12h != null ? classify(false, side, m12h) : null;
      const labels6h = outcome6h != null ? deriveLabels(outcome6h, false, false) : { labelGoodDecision: null, labelBadDecision: null, labelMissedOpportunity: null, labelExecutionUnsafe: null };
      const labels12h = outcome12h != null ? deriveLabels(outcome12h, false, false) : { labelGoodDecision: null, labelBadDecision: null, labelMissedOpportunity: null, labelExecutionUnsafe: null };

      // Historical features from snapshots (no forward-looking leakage)
      const liquidityAtT = valueAtOrBefore(points, decisionAt, (p) => p.liquidity) ?? 0;
      const liquidity6hAgo = valueAtOrBefore(points, new Date(t - HORIZON_6H_MS), (p) => p.liquidity) ?? 0;
      const volumeAtT = valueAtOrBefore(points, decisionAt, (p) => p.volume) ?? 0;
      const price1hAgo = priceAtOrBefore(points, new Date(t - HORIZON_1H_MS));
      const price6hAgo = priceAtOrBefore(points, new Date(t - HORIZON_6H_MS));
      const volBps = volatility24hBps(points, t);
      const vol1hBps = volatility1hBps(points, t);
      const vol6hBps = volatility6hBps(points, t);
      const priceChange1hBps =
        price1hAgo != null && price1hAgo > 0
          ? ((price0 - price1hAgo) / price1hAgo) * 10000
          : 0;
      const priceChange6hBps =
        price6hAgo != null && price6hAgo > 0
          ? ((price0 - price6hAgo) / price6hAgo) * 10000
          : 0;
      const momentum1hBps = priceChange1hBps;
      const momentum6hBps = priceChange6hBps;
      const spreadBps = volBps;
      const estimatedSlippage = Math.min(volBps, Math.max(Math.abs(priceChange1hBps), Math.abs(priceChange6hBps) * 0.5));
      const tradable = liquidityAtT >= LIQUIDITY_MIN_FOR_GOOD;
      const qualityState = liquidityAtT >= LIQUIDITY_MIN_FOR_GOOD ? "good" : "warn";
      const sizeMult = volumeAtT > 0 ? Math.min(2, Math.max(0.25, Math.log1p(volumeAtT))) : 1;
      const policyState = "allow";
      const distanceFromMid = Math.abs(price0 - 0.5);
      const timeToCloseHours =
        endDate != null ? (endDate.getTime() - decisionAt.getTime()) / (3600 * 1000) : null;
      const liquidityTrend =
        liquidity6hAgo > 0 ? (liquidityAtT - liquidity6hAgo) / liquidity6hAgo : 0;

      const shadowCandidateId = `offline-${marketId}-${assetId}-${t}`;
      rows.push({
        shadowCandidateId,
        funderAddress,
        assetId,
        marketId,
        candidateSource: "offline_historical",
        createdAt: decisionAt,
        side,
        intendedPrice: String(price0),
        intendedSize: volumeAtT > 0 ? String(Math.min(1e6, volumeAtT)) : "1",
        policyState,
        sizeMultiplier: String(sizeMult),
        finalSuggestedSize: String(sizeMult),
        eligibilityBlockersCount: 0,
        reducedSizeIndicator: sizeMult < 1,
        blockedIndicator: false,
        executionAllow: true,
        executionBlockingReasonGroups: null,
        executionWarningCount: 0,
        qualityState,
        spreadBps: spreadBps > 0 ? String(spreadBps) : null,
        estimatedSlippage: estimatedSlippage > 0 ? String(estimatedSlippage) : null,
        depthSufficiency: null,
        quoteFreshnessState: null,
        tradable,
        grossExposure: null,
        totalOpenExposure: null,
        workingOrderExposure: null,
        maxSingleMarketConcentrationPct: null,
        maxSingleThemeConcentrationPct: null,
        worstCaseLossEstimate: null,
        nearResolutionExposure: null,
        illiquidExposureEstimate: null,
        correlatedExposureEstimate: null,
        portfolioRiskFlagsCount: 0,
        runtimeSafetyState: null,
        runtimeWarningCount: 0,
        runtimeBlockingCount: 0,
        recommendationPresent: false,
        outcomeBlockedVsAllowedVsSubmitted: "submitted",
        markout1h: null,
        markout6h: m6h != null ? String(m6h) : null,
        markout12h: m12h != null ? String(m12h) : null,
        markout24h: String(m24h),
        outcomeClassification: outcome,
        wasBlocked: false,
        wasSubmitted: true,
        wasFilled: null,
        ...labels,
        labelGoodDecision6h: labels6h.labelGoodDecision ?? null,
        labelGoodDecision12h: labels12h.labelGoodDecision ?? null,
        momentum1hBps: String(momentum1hBps),
        momentum6hBps: String(momentum6hBps),
        volatility1hBps: vol1hBps > 0 ? String(vol1hBps) : null,
        volatility6hBps: vol6hBps > 0 ? String(vol6hBps) : null,
        distanceFromMid: String(distanceFromMid),
        timeToCloseHours: timeToCloseHours != null ? String(timeToCloseHours) : null,
        liquidityTrend: String(liquidityTrend),
      });
      t += intervalMs;
    }
  }

  return { rows, errors };
}

export interface PersistOfflineHistoricalOptions extends BuildOfflineHistoricalOptions {
  /** If true, do not write to DB; only build and return counts. */
  dryRun?: boolean;
  /** If true, log first 5 rows' historical feature values (momentum, volatility, distanceFromMid, etc.). */
  debug?: boolean;
}

export interface PersistOfflineHistoricalResult {
  examplesBuilt: number;
  persisted: number;
  skipped: number;
  errors: string[];
}

/**
 * Build offline historical examples and optionally persist to MlShadowTrainingExample.
 * Skips any shadowCandidateId that already exists (idempotent).
 */
export async function persistOfflineHistoricalExamples(
  options: PersistOfflineHistoricalOptions = {}
): Promise<PersistOfflineHistoricalResult> {
  const { dryRun = false, debug = false } = options;
  const { rows, errors } = await buildOfflineHistoricalExamples(options);

  if (debug && rows.length > 0) {
    const sample = rows.slice(0, 5);
    console.log("");
    console.log("--- Debug: first 5 rows historical features ---");
    sample.forEach((r, idx) => {
      console.log(`  row ${idx + 1}: momentum1hBps=${r.momentum1hBps ?? "null"} momentum6hBps=${r.momentum6hBps ?? "null"} volatility1hBps=${r.volatility1hBps ?? "null"} volatility6hBps=${r.volatility6hBps ?? "null"} distanceFromMid=${r.distanceFromMid ?? "null"} timeToCloseHours=${r.timeToCloseHours ?? "null"} liquidityTrend=${r.liquidityTrend ?? "null"}`);
    });
    console.log("");
  }

  let persisted = 0;
  let skipped = 0;

  if (!dryRun && rows.length > 0) {
    const existing = await prisma.mlShadowTrainingExample.findMany({
      where: { shadowCandidateId: { in: rows.map((r) => r.shadowCandidateId) } },
      select: { shadowCandidateId: true },
    });
    const existingSet = new Set(existing.map((x) => x.shadowCandidateId));

    for (const row of rows) {
      if (existingSet.has(row.shadowCandidateId)) {
        skipped++;
        continue;
      }
      try {
        await prisma.mlShadowTrainingExample.create({
          data: {
            shadowCandidateId: row.shadowCandidateId,
            funderAddress: row.funderAddress,
            recommendationId: null,
            orderIntentId: null,
            assetId: row.assetId,
            marketId: row.marketId,
            candidateSource: row.candidateSource,
            policyState: row.policyState,
            sizeMultiplier: row.sizeMultiplier,
            finalSuggestedSize: row.finalSuggestedSize,
            eligibilityBlockersCount: row.eligibilityBlockersCount,
            reducedSizeIndicator: row.reducedSizeIndicator,
            blockedIndicator: row.blockedIndicator,
            executionAllow: row.executionAllow,
            executionBlockingReasonGroups: row.executionBlockingReasonGroups,
            executionWarningCount: row.executionWarningCount,
            qualityState: row.qualityState,
            spreadBps: row.spreadBps,
            estimatedSlippage: row.estimatedSlippage,
            depthSufficiency: row.depthSufficiency,
            quoteFreshnessState: row.quoteFreshnessState,
            tradable: row.tradable,
            grossExposure: row.grossExposure,
            totalOpenExposure: row.totalOpenExposure,
            workingOrderExposure: row.workingOrderExposure,
            maxSingleMarketConcentrationPct: row.maxSingleMarketConcentrationPct,
            maxSingleThemeConcentrationPct: row.maxSingleThemeConcentrationPct,
            worstCaseLossEstimate: row.worstCaseLossEstimate,
            nearResolutionExposure: row.nearResolutionExposure,
            illiquidExposureEstimate: row.illiquidExposureEstimate,
            correlatedExposureEstimate: row.correlatedExposureEstimate,
            portfolioRiskFlagsCount: row.portfolioRiskFlagsCount,
            runtimeSafetyState: row.runtimeSafetyState,
            runtimeWarningCount: row.runtimeWarningCount,
            runtimeBlockingCount: row.runtimeBlockingCount,
            side: row.side,
            intendedPrice: row.intendedPrice,
            intendedSize: row.intendedSize,
            recommendationPresent: row.recommendationPresent,
            outcomeBlockedVsAllowedVsSubmitted: row.outcomeBlockedVsAllowedVsSubmitted,
            markout1h: row.markout1h,
            markout6h: row.markout6h,
            markout12h: row.markout12h,
            markout24h: row.markout24h,
            outcomeClassification: row.outcomeClassification,
            wasBlocked: row.wasBlocked,
            wasSubmitted: row.wasSubmitted,
            wasFilled: row.wasFilled,
            labelGoodDecision: row.labelGoodDecision,
            labelGoodDecision6h: row.labelGoodDecision6h,
            labelGoodDecision12h: row.labelGoodDecision12h,
            labelBadDecision: row.labelBadDecision,
            labelMissedOpportunity: row.labelMissedOpportunity,
            labelExecutionUnsafe: row.labelExecutionUnsafe,
            momentum1hBps: row.momentum1hBps,
            momentum6hBps: row.momentum6hBps,
            volatility1hBps: row.volatility1hBps,
            volatility6hBps: row.volatility6hBps,
            distanceFromMid: row.distanceFromMid,
            timeToCloseHours: row.timeToCloseHours,
            liquidityTrend: row.liquidityTrend,
          },
        });
        persisted++;
      } catch (err: unknown) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
  }

  return {
    examplesBuilt: rows.length,
    persisted,
    skipped,
    errors,
  };
}
