/**
 * Truthful path/regime features for shadow_v1 slots from MarketPriceSnapshot history
 * at or before decision time only (no forward-looking leakage into features).
 *
 * Semantics align with offline-historical builder; missing history → null columns (not silent 0).
 */

import type { PrismaClient } from "@prisma/client";

export const PATH_FEATURE_LOOKBACK_MS = 24 * 60 * 60 * 1000;

const HORIZON_1H_MS = 60 * 60 * 1000;
const HORIZON_6H_MS = 6 * HORIZON_1H_MS;

export interface SnapshotPoint {
  capturedAt: Date;
  price: number;
  liquidity: number;
  volume: number;
}

export interface PathRegimeFeatures {
  momentum1hBps: string | null;
  momentum6hBps: string | null;
  volatility1hBps: string | null;
  volatility6hBps: string | null;
  distanceFromMid: string | null;
  timeToCloseHours: string | null;
  liquidityTrend: string | null;
}

function parseNum(s: string | null | undefined): number | null {
  if (s == null || s === "") return null;
  const n = parseFloat(String(s).trim());
  return Number.isFinite(n) ? n : null;
}

function toStr(n: number | null | undefined): string | null {
  if (n == null || !Number.isFinite(n)) return null;
  return String(n);
}

/** Value at or before `at` from sorted points. */
export function valueAtOrBefore<T extends { capturedAt: Date }>(
  points: T[],
  at: Date,
  getter: (p: T) => number
): number | null {
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

export function priceAtOrBefore(points: SnapshotPoint[], at: Date): number | null {
  return valueAtOrBefore(points, at, (p) => p.price);
}

function volatilityBps(points: SnapshotPoint[], tMs: number, windowMs: number): number | null {
  const start = new Date(tMs - windowMs);
  const end = new Date(tMs);
  let minP = Infinity;
  let maxP = -Infinity;
  for (const p of points) {
    if (p.capturedAt >= start && p.capturedAt <= end && p.price > 0) {
      minP = Math.min(minP, p.price);
      maxP = Math.max(maxP, p.price);
    }
  }
  if (minP === Infinity || maxP === 0) return null;
  const mid = (minP + maxP) / 2;
  return mid > 0 ? ((maxP - minP) / mid) * 10000 : null;
}

/**
 * Only include snapshots with capturedAt <= decisionAt (strict pre-decision).
 */
export function filterPreDecisionPoints(points: SnapshotPoint[], decisionAt: Date): SnapshotPoint[] {
  return points.filter((p) => p.capturedAt <= decisionAt);
}

/**
 * Compute path/regime fields from pre-decision points only (sorted ascending by capturedAt).
 * Uses intendedPriceFallback for distanceFromMid (and anchors) only when snapshot mid is missing.
 */
export function computePathRegimeFeaturesFromPreDecisionPoints(
  preDecisionSorted: SnapshotPoint[],
  decisionAt: Date,
  options: {
    marketEndDate?: Date | null;
    intendedPriceFallback?: number | null;
  } = {}
): PathRegimeFeatures {
  const t = decisionAt.getTime();
  const price0 =
    priceAtOrBefore(preDecisionSorted, decisionAt) ??
    (options.intendedPriceFallback != null &&
    options.intendedPriceFallback > 0 &&
    Number.isFinite(options.intendedPriceFallback)
      ? options.intendedPriceFallback
      : null);

  const price1hAgo = priceAtOrBefore(preDecisionSorted, new Date(t - HORIZON_1H_MS));
  const price6hAgo = priceAtOrBefore(preDecisionSorted, new Date(t - HORIZON_6H_MS));

  const momentum1hBps =
    price0 != null &&
    price0 > 0 &&
    price1hAgo != null &&
    price1hAgo > 0 &&
    Number.isFinite(price0) &&
    Number.isFinite(price1hAgo)
      ? ((price0 - price1hAgo) / price1hAgo) * 10000
      : null;

  const momentum6hBps =
    price0 != null &&
    price0 > 0 &&
    price6hAgo != null &&
    price6hAgo > 0 &&
    Number.isFinite(price0) &&
    Number.isFinite(price6hAgo)
      ? ((price0 - price6hAgo) / price6hAgo) * 10000
      : null;

  const vol1h = volatilityBps(preDecisionSorted, t, HORIZON_1H_MS);
  const vol6h = volatilityBps(preDecisionSorted, t, HORIZON_6H_MS);

  const distanceFromMid =
    price0 != null && price0 > 0 && Number.isFinite(price0) ? Math.abs(price0 - 0.5) : null;

  const end = options.marketEndDate;
  const timeToCloseHours =
    end != null && end.getTime() > t ? (end.getTime() - t) / (3600 * 1000) : null;

  const liquidityAtT =
    valueAtOrBefore(preDecisionSorted, decisionAt, (p) => p.liquidity) ?? null;
  const liquidity6hAgo =
    valueAtOrBefore(preDecisionSorted, new Date(t - HORIZON_6H_MS), (p) => p.liquidity) ?? null;
  const liquidityTrend =
    liquidityAtT != null &&
    liquidity6hAgo != null &&
    liquidity6hAgo > 0 &&
    Number.isFinite(liquidityAtT) &&
    Number.isFinite(liquidity6hAgo)
      ? (liquidityAtT - liquidity6hAgo) / liquidity6hAgo
      : null;

  return {
    momentum1hBps: toStr(momentum1hBps),
    momentum6hBps: toStr(momentum6hBps),
    volatility1hBps: toStr(vol1h),
    volatility6hBps: toStr(vol6h),
    distanceFromMid: toStr(distanceFromMid),
    timeToCloseHours: toStr(timeToCloseHours),
    liquidityTrend: toStr(liquidityTrend),
  };
}

export function snapshotsToPoints(
  snapshots: { capturedAt: Date; price: string | null; liquidity: string | null; volume: string | null }[]
): SnapshotPoint[] {
  const out: SnapshotPoint[] = [];
  for (const s of snapshots) {
    const p = parseNum(s.price);
    if (p == null || p <= 0) continue;
    out.push({
      capturedAt: s.capturedAt,
      price: p,
      liquidity: parseNum(s.liquidity) ?? 0,
      volume: parseNum(s.volume) ?? 0,
    });
  }
  return out;
}

/** Resolve polymarket market id / conditionId aliases for snapshot queries. */
export async function resolveSnapshotMarketIdAliases(
  prisma: PrismaClient,
  marketId: string | null | undefined,
  cache?: Map<string, string[]>
): Promise<string[]> {
  const key = String(marketId ?? "").trim();
  if (!key) return [];
  if (cache?.has(key)) return cache.get(key)!;
  const rows = await prisma.syncedMarket.findMany({
    where: { OR: [{ id: key }, { conditionId: key }] },
    select: { id: true },
    take: 5,
  });
  const ids = Array.from(new Set([key, ...rows.map((r) => r.id)]));
  cache?.set(key, ids);
  return ids;
}

export interface FetchSnapshotsForShadowRowParams {
  decisionAt: Date;
  /** Upper bound for forward markout windows (e.g. decision + 12h). */
  forwardHorizonEnd: Date;
  marketId: string;
  assetId: string;
}

/**
 * Load snapshots from [decisionAt - 24h, forwardHorizonEnd] for markout + pre-decision path features.
 */
export async function fetchSnapshotsForShadowRow(
  prisma: PrismaClient,
  params: FetchSnapshotsForShadowRowParams,
  options: { marketIdAliasCache?: Map<string, string[]> } = {}
): Promise<SnapshotPoint[]> {
  const { decisionAt, forwardHorizonEnd, marketId, assetId } = params;
  const from = new Date(decisionAt.getTime() - PATH_FEATURE_LOOKBACK_MS);
  const resolved = await resolveSnapshotMarketIdAliases(prisma, marketId, options.marketIdAliasCache);
  if (resolved.length === 0) return [];
  const snapshots = await prisma.marketPriceSnapshot.findMany({
    where: {
      marketId: { in: resolved },
      assetId,
      capturedAt: { gte: from, lte: forwardHorizonEnd },
    },
    orderBy: { capturedAt: "asc" },
    select: { capturedAt: true, price: true, liquidity: true, volume: true },
  });
  return snapshotsToPoints(snapshots);
}

/** True when the column should be backfilled (null or empty string). */
export function pathSlotNeedsFill(value: string | null | undefined): boolean {
  return value == null || String(value).trim() === "";
}

export function mergePathFeaturesIntoUpdate(
  existing: Record<string, string | null | undefined>,
  computed: PathRegimeFeatures
): Partial<Record<keyof PathRegimeFeatures, string | null>> {
  const out: Partial<Record<keyof PathRegimeFeatures, string | null>> = {};
  (Object.keys(computed) as (keyof PathRegimeFeatures)[]).forEach((k) => {
    if (pathSlotNeedsFill(existing[k] as string | null | undefined) && computed[k] != null) {
      out[k] = computed[k];
    }
  });
  return out;
}
