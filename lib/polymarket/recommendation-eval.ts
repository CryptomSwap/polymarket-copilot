/**
 * Recommendation evaluation: compare current price vs recommendation creation, persist evaluations.
 * Computes 1h / 6h / 24h forward performance when snapshots allow. Read-only; no trading.
 * TODO: Manual-trade review flow can use evaluation history for accountability.
 */

import { prisma } from "@/lib/db";
import { getFunderForRecompute } from "./recompute";

const MS_1H = 60 * 60 * 1000;
const MS_6H = 6 * 60 * 60 * 1000;
const MS_24H = 24 * 60 * 60 * 1000;

function parseNum(s: string): number {
  const n = parseFloat(String(s).trim());
  return Number.isFinite(n) ? n : 0;
}

function toStr(n: number): string {
  return String(Number.isFinite(n) ? n : 0);
}

/**
 * Get latest price for a market/outcome from MarketPriceSnapshot or from signal's market (SyncedMarket raw).
 */
async function getCurrentPriceForSignal(marketId: string, outcome: string): Promise<number | null> {
  const asset = await prisma.syncedAsset.findFirst({
    where: { syncedMarketId: marketId, outcome },
  });
  if (!asset) return null;
  const snap = await prisma.marketPriceSnapshot.findFirst({
    where: { marketId, assetId: asset.tokenId },
    orderBy: { capturedAt: "desc" },
  });
  if (snap) return parseNum(snap.price);
  const market = await prisma.syncedMarket.findUnique({
    where: { id: marketId },
    include: { assets: true },
  });
  if (!market?.raw) return null;
  try {
    const raw = JSON.parse(market.raw) as Record<string, unknown>;
    const prices = raw.outcomePrices ?? raw.prices;
    const arr = Array.isArray(prices) ? prices : typeof prices === "string" ? JSON.parse(prices) : [];
    const idx = market.assets.findIndex((a) => a.outcome === outcome);
    return idx >= 0 ? parseNum(arr[idx]) : null;
  } catch {
    return null;
  }
}

/**
 * Get price at a given time from MarketPriceSnapshot (latest snapshot at or before `at`).
 */
async function getPriceAt(marketId: string, assetId: string, at: Date): Promise<number | null> {
  const before = await prisma.marketPriceSnapshot.findFirst({
    where: { marketId, assetId, capturedAt: { lte: at } },
    orderBy: { capturedAt: "desc" },
  });
  if (!before) return null;
  return parseNum(before.price);
}

export interface EvaluationResult {
  evaluated: number;
  errors: string[];
}

/**
 * Evaluate recent recommendations: create RecommendationEvaluation rows with current price and forward returns when possible.
 */
export async function evaluateRecommendations(
  funderAddress?: string
): Promise<EvaluationResult> {
  const errors: string[] = [];
  const resolved = funderAddress?.toLowerCase() ?? (await getFunderForRecompute());
  if (!resolved) {
    return { evaluated: 0, errors: ["No funder address."] };
  }

  const recent = await prisma.recommendation.findMany({
    where: { marketSignal: { funderAddress: resolved } },
    include: { marketSignal: true },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  const assetByMarketOutcome = new Map<string, string>();
  for (const r of recent) {
    const key = `${r.marketSignal.marketId}:${r.marketSignal.outcome}`;
    if (!assetByMarketOutcome.has(key)) {
      const asset = await prisma.syncedAsset.findFirst({
        where: { syncedMarketId: r.marketSignal.marketId, outcome: r.marketSignal.outcome },
      });
      if (asset) assetByMarketOutcome.set(key, asset.tokenId);
    }
  }

  let evaluated = 0;
  for (const rec of recent) {
    try {
      const priceAtCreation = parseNum(rec.marketSignal.marketPrice);
      const currentPrice = await getCurrentPriceForSignal(
        rec.marketSignal.marketId,
        rec.marketSignal.outcome
      );
      if (currentPrice == null) continue;

      const createdAt = rec.createdAt;
      const assetId = assetByMarketOutcome.get(
        `${rec.marketSignal.marketId}:${rec.marketSignal.outcome}`
      );

      let priceChange1h: string | null = null;
      let priceChange6h: string | null = null;
      let priceChange24h: string | null = null;
      if (assetId && rec.marketSignal.marketId) {
        const t1h = new Date(createdAt.getTime() + MS_1H);
        const t6h = new Date(createdAt.getTime() + MS_6H);
        const t24h = new Date(createdAt.getTime() + MS_24H);
        if (t1h <= new Date()) {
          const p1h = await getPriceAt(rec.marketSignal.marketId, assetId, t1h);
          if (p1h != null && priceAtCreation > 0)
            priceChange1h = toStr((p1h - priceAtCreation) / priceAtCreation);
        }
        if (t6h <= new Date()) {
          const p6h = await getPriceAt(rec.marketSignal.marketId, assetId, t6h);
          if (p6h != null && priceAtCreation > 0)
            priceChange6h = toStr((p6h - priceAtCreation) / priceAtCreation);
        }
        if (t24h <= new Date()) {
          const p24h = await getPriceAt(rec.marketSignal.marketId, assetId, t24h);
          if (p24h != null && priceAtCreation > 0)
            priceChange24h = toStr((p24h - priceAtCreation) / priceAtCreation);
        }
      }

      const change = priceAtCreation > 0 ? (currentPrice - priceAtCreation) / priceAtCreation : 0;
      const wasPositive = change > 0;

      await prisma.recommendationEvaluation.create({
        data: {
          recommendationId: rec.id,
          marketPriceAtEval: toStr(currentPrice),
          priceChange1h,
          priceChange6h,
          priceChange24h,
          wasPositive,
          metadata: {
            priceAtCreation,
            action: rec.action,
            signalType: rec.marketSignal.signalType,
          } as object,
        },
      });
      evaluated++;
    } catch (e) {
      errors.push(e instanceof Error ? e.message : "Eval create failed");
    }
  }

  return { evaluated, errors };
}
