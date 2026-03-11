/**
 * Market metrics: price, momentum from snapshots, liquidity, crowding, portfolio/behavior context.
 * Momentum and price changes use MarketPriceSnapshot history (not user fills). Read-only.
 */

import { prisma } from "@/lib/db";
import { classifyCategory, deriveTheme, type MarketCategory } from "./classify";

const MS_15M = 15 * 60 * 1000;
const MS_1H = 60 * 60 * 1000;
const MS_6H = 6 * 60 * 60 * 1000;
const MS_24H = 24 * 60 * 60 * 1000;

export interface MarketMetricsInput {
  marketId: string;
  conditionId: string | null;
  slug: string | null;
  title: string;
  outcome: string;
  outcomeIndex: number;
  tokenId: string;
  rawJson: Record<string, unknown> | null;
  volumeNum: number | null;
  liquidityNum: number | null;
  endDate: Date | null;
}

export interface MarketMetrics {
  marketPrice: number;
  priceChange15m: number;
  priceChange1h: number;
  priceChange6h: number;
  priceChange24h: number;
  volatilityEstimate: number;
  momentumScore: number;
  liquidityScore: number;
  crowdingScore: number;
  timeToResolutionDays: number | null;
  category: MarketCategory;
  theme: string;
  userExposureInTheme: number;
  themeOverconcentrated: boolean;
  isChaseCondition: boolean;
}

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

/**
 * Get price at a given time from snapshot history (closest before or at that time).
 */
function priceAt(snapshots: { price: string; capturedAt: Date }[], at: Date): number | null {
  const ts = at.getTime();
  let best: { price: number; capturedAt: Date } | null = null;
  for (const s of snapshots) {
    const t = s.capturedAt.getTime();
    if (t <= ts && (!best || t > best.capturedAt.getTime())) {
      best = { price: parseNum(s.price), capturedAt: s.capturedAt };
    }
  }
  return best?.price ?? null;
}

/**
 * Compute metrics for one market/outcome. Momentum from MarketPriceSnapshot history.
 */
export async function computeMarketMetrics(
  input: MarketMetricsInput,
  funderAddress: string
): Promise<MarketMetrics> {
  const now = new Date();
  const marketPrice = priceFromRaw(input.rawJson, input.outcomeIndex) || 0.5;
  const category = classifyCategory(input.title);
  const theme = deriveTheme(input.title, category);

  const snapshots = await prisma.marketPriceSnapshot.findMany({
    where: { marketId: input.marketId, assetId: input.tokenId },
    orderBy: { capturedAt: "desc" },
    take: 100,
  });
  const sorted = [...snapshots].reverse();

  const p15 = priceAt(sorted, new Date(now.getTime() - MS_15M));
  const p1h = priceAt(sorted, new Date(now.getTime() - MS_1H));
  const p6h = priceAt(sorted, new Date(now.getTime() - MS_6H));
  const p24h = priceAt(sorted, new Date(now.getTime() - MS_24H));

  const priceChange15m = p15 != null && p15 > 0 ? (marketPrice - p15) / p15 : 0;
  const priceChange1h = p1h != null && p1h > 0 ? (marketPrice - p1h) / p1h : 0;
  const priceChange6h = p6h != null && p6h > 0 ? (marketPrice - p6h) / p6h : 0;
  const priceChange24h = p24h != null && p24h > 0 ? (marketPrice - p24h) / p24h : 0;

  const recentPrices = sorted.slice(-20).map((s) => parseNum(s.price));
  const volatilityEstimate =
    recentPrices.length >= 2
      ? Math.sqrt(
          recentPrices.reduce((s, p) => s + (p - marketPrice) ** 2, 0) / recentPrices.length
        )
      : 0;

  const avgChange = [priceChange15m, priceChange1h, priceChange6h, priceChange24h].filter(
    (c) => Number.isFinite(c)
  );
  const momentumScore =
    avgChange.length > 0
      ? Math.max(0, Math.min(1, 0.5 + (avgChange.reduce((a, b) => a + b, 0) / avgChange.length) * 3))
      : 0.5;

  const acceleration = priceChange1h - priceChange6h;
  const isChaseCondition =
    priceChange1h > 0.1 && acceleration > 0.05 && marketPrice > 0.2 && marketPrice < 0.8;

  const liquidityNorm = (input.liquidityNum ?? 0) / 1e6;
  const liquidityScore = Math.min(1, Math.max(0, liquidityNorm));

  const volumeNorm = (input.volumeNum ?? 0) / 1e6;
  const crowdingScore = Math.min(1, Math.max(0, 1 - volumeNorm * 0.1));

  let timeToResolutionDays: number | null = null;
  if (input.endDate) {
    const days = (input.endDate.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    timeToResolutionDays = Math.max(0, Math.round(days));
  }

  const positionsInTheme = await prisma.derivedPosition.findMany({
    where: { funderAddress, theme },
  });
  const userExposureInTheme = positionsInTheme.reduce(
    (s, p) => s + parseFloat(p.marketValue || "0"),
    0
  );

  const snapshot = await prisma.portfolioSnapshot.findFirst({
    where: { funderAddress },
    orderBy: { createdAt: "desc" },
  });
  const totalExposure = snapshot ? parseFloat(snapshot.totalOpenExposure || "0") : 0;
  const themeOverconcentrated =
    totalExposure > 0 && userExposureInTheme / totalExposure >= 0.4;

  return {
    marketPrice,
    priceChange15m,
    priceChange1h,
    priceChange6h,
    priceChange24h,
    volatilityEstimate,
    momentumScore,
    liquidityScore,
    crowdingScore,
    timeToResolutionDays,
    category,
    theme,
    userExposureInTheme,
    themeOverconcentrated,
    isChaseCondition,
  };
}
