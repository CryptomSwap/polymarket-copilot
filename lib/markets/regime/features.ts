/**
 * Market regime features: deterministic metrics for volatility/regime classification.
 * Uses existing price snapshots, market metadata, and news/event links. No ML.
 */

import { prisma } from "@/lib/db";

const MS_1H = 60 * 60 * 1000;
const MS_6H = 6 * 60 * 60 * 1000;
const MS_24H = 24 * 60 * 60 * 1000;
const ROLLING_WINDOW_MS = MS_24H;
const MIN_SNAPSHOTS_FOR_RANGE = 3;

function parseNum(x: unknown): number {
  if (typeof x === "number" && Number.isFinite(x)) return x;
  if (typeof x === "string") {
    const n = parseFloat(x);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function priceFromRaw(raw: Record<string, unknown> | null, outcomeIndex: number): number {
  if (!raw) return 0.5;
  const prices = raw.outcomePrices ?? raw.prices;
  if (Array.isArray(prices)) return parseNum(prices[outcomeIndex]);
  if (typeof prices === "string") {
    try {
      const arr = JSON.parse(prices) as unknown[];
      return parseNum(arr[outcomeIndex]);
    } catch {
      return 0.5;
    }
  }
  return 0.5;
}

export interface MarketRegimeFeatures {
  marketId: string;
  assetId: string;
  outcome: string;
  outcomeIndex: number;
  /** Last available price (0–1). */
  lastPrice: number;
  /** Return 1h ago to now. */
  return1h: number;
  return6h: number;
  return24h: number;
  /** Rolling min/max over last 24h of snapshots. */
  rollingLow: number | null;
  rollingHigh: number | null;
  /** Normalized 0–1: higher = more volatile (from snapshot std dev). */
  volatilityScore: number;
  /** Normalized 0–1: 0.5 = flat, >0.5 = up, <0.5 = down (from avg recent returns). */
  trendScore: number;
  /** 0–1: 0 = at low, 1 = at high, null if no range. */
  distanceFromRangeLow: number | null;
  distanceFromRangeHigh: number | null;
  /** 0–1: liquidity quality from market liquidityNum. */
  spreadLiquidityQuality: number;
  /** Hours until market endDate. */
  hoursToResolution: number | null;
  /** Count of news links for this market (recent 7d). */
  newsActivityCount: number;
  /** Count of event links with material impact (proxy for shock). */
  newsShockProxy: number;
  /** Snapshot count used for range/volatility. */
  snapshotCount: number;
}

export interface MarketRegimeFeaturesInput {
  marketId: string;
  assetId?: string;
}

/**
 * Compute regime features for a market (and optionally a specific asset).
 * If assetId omitted, uses first asset of the market. Cheap: one market + snapshots + 2 counts.
 */
export async function computeMarketRegimeFeatures(
  input: MarketRegimeFeaturesInput
): Promise<MarketRegimeFeatures | null> {
  const market = await prisma.syncedMarket.findUnique({
    where: { id: input.marketId },
    include: { assets: { orderBy: { outcomeIndex: "asc" } } },
  });
  if (!market || market.assets.length === 0) return null;

  const asset = input.assetId
    ? market.assets.find((a) => a.tokenId === input.assetId) ?? market.assets[0]
    : market.assets[0];

  let rawJson: Record<string, unknown> | null = null;
  if (market.raw) {
    try {
      rawJson = JSON.parse(market.raw) as Record<string, unknown>;
    } catch {
      rawJson = null;
    }
  }

  const now = Date.now();
  const cutoff = new Date(now - ROLLING_WINDOW_MS);
  const snapshots = await prisma.marketPriceSnapshot.findMany({
    where: { marketId: input.marketId, assetId: asset.tokenId, capturedAt: { gte: cutoff } },
    orderBy: { capturedAt: "asc" },
    take: 500,
  });

  const lastPrice = snapshots.length > 0
    ? parseNum(snapshots[snapshots.length - 1].price)
    : priceFromRaw(rawJson, asset.outcomeIndex ?? 0);
  const price = lastPrice > 0 && lastPrice < 1 ? lastPrice : 0.5;

  const sorted = snapshots.map((s) => ({ price: parseNum(s.price), at: s.capturedAt.getTime() }));

  const p1h = sorted.find((s) => s.at <= now - MS_1H);
  const p6h = sorted.find((s) => s.at <= now - MS_6H);
  const p24h = sorted.find((s) => s.at <= now - MS_24H);
  const return1h = p1h && p1h.price > 0 ? (price - p1h.price) / p1h.price : 0;
  const return6h = p6h && p6h.price > 0 ? (price - p6h.price) / p6h.price : 0;
  const return24h = p24h && p24h.price > 0 ? (price - p24h.price) / p24h.price : 0;

  let rollingLow: number | null = null;
  let rollingHigh: number | null = null;
  if (sorted.length >= MIN_SNAPSHOTS_FOR_RANGE) {
    rollingLow = Math.min(...sorted.map((s) => s.price));
    rollingHigh = Math.max(...sorted.map((s) => s.price));
  }

  const avgReturn = [return1h, return6h, return24h].filter((r) => Number.isFinite(r));
  const trendScore = avgReturn.length > 0
    ? Math.max(0, Math.min(1, 0.5 + (avgReturn.reduce((a, b) => a + b, 0) / avgReturn.length) * 2))
    : 0.5;

  const prices = sorted.map((s) => s.price);
  const mean = prices.length > 0 ? prices.reduce((a, b) => a + b, 0) / prices.length : price;
  const variance = prices.length >= 2
    ? prices.reduce((s, p) => s + (p - mean) ** 2, 0) / prices.length
    : 0;
  const vol = Math.sqrt(variance);
  const volatilityScore = Math.min(1, Math.max(0, vol * 10));

  let distanceFromRangeLow: number | null = null;
  let distanceFromRangeHigh: number | null = null;
  if (rollingLow != null && rollingHigh != null && rollingHigh > rollingLow) {
    distanceFromRangeLow = (price - rollingLow) / (rollingHigh - rollingLow);
    distanceFromRangeHigh = (rollingHigh - price) / (rollingHigh - rollingLow);
  }

  const liquidityNum = market.liquidityNum ?? 0;
  const spreadLiquidityQuality = Math.min(1, Math.max(0, liquidityNum / 1e6));

  let hoursToResolution: number | null = null;
  if (market.endDate) {
    const h = (market.endDate.getTime() - now) / (60 * 60 * 1000);
    hoursToResolution = h > 0 ? h : 0;
  }

  const newsSince = new Date(now - 7 * 24 * 60 * 60 * 1000);
  const [newsActivityCount, eventLinkCount] = await Promise.all([
    prisma.marketNewsLink.count({
      where: { marketId: input.marketId, createdAt: { gte: newsSince } },
    }),
    prisma.marketEventLink.count({
      where: {
        marketId: input.marketId,
        confidence: { gte: 0.3 },
      },
    }),
  ]);

  return {
    marketId: input.marketId,
    assetId: asset.tokenId,
    outcome: asset.outcome,
    outcomeIndex: asset.outcomeIndex ?? 0,
    lastPrice: price,
    return1h,
    return6h,
    return24h,
    rollingLow,
    rollingHigh,
    volatilityScore,
    trendScore,
    distanceFromRangeLow,
    distanceFromRangeHigh,
    spreadLiquidityQuality,
    hoursToResolution,
    newsActivityCount,
    newsShockProxy: eventLinkCount,
    snapshotCount: snapshots.length,
  };
}
