import { prisma } from "@/lib/db";
import type { PaperTradingCandidate } from "../candidates";

export interface MispricingFeatureVector {
  recommendationId: string;
  marketId: string;
  assetId: string;
  meanReversionSignal: number;
  priceVelocityChange: number;
  marketDisagreementProxy: number;
  spreadAdjustedConfidence: number;
  crossMarketComparison: number;
}

export interface MispricingFeatureBuildResult {
  vectors: MispricingFeatureVector[];
  byRecommendationId: Record<string, MispricingFeatureVector>;
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return x;
}

function parseNum(v: string | number | null | undefined): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

function minMax(values: number[]): number[] {
  if (values.length === 0) return [];
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  if (hi - lo <= 1e-12) return values.map(() => 0.5);
  return values.map((v) => clamp01((v - lo) / (hi - lo)));
}

/**
 * Mispricing features from candidate + recent snapshot context.
 * All outputs are normalized to [0,1].
 */
export async function buildMispricingFeatureVectors(
  candidates: PaperTradingCandidate[],
  opts?: { lookbackHours?: number; minSnapshotsForVelocity?: number }
): Promise<MispricingFeatureBuildResult> {
  const lookbackHours = opts?.lookbackHours ?? 24;
  const minSnapshotsForVelocity = opts?.minSnapshotsForVelocity ?? 3;
  const since = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);

  const marketIds = Array.from(new Set(candidates.map((c) => c.marketId)));
  const assetIds = Array.from(new Set(candidates.map((c) => c.assetId)));
  const snapshots = await prisma.marketPriceSnapshot.findMany({
    where: {
      marketId: { in: marketIds },
      assetId: { in: assetIds },
      capturedAt: { gte: since },
    },
    orderBy: { capturedAt: "asc" },
    select: {
      marketId: true,
      assetId: true,
      price: true,
      liquidity: true,
      capturedAt: true,
    },
  });

  const snapByKey = new Map<string, Array<{ price: number; liquidity: number | null }>>();
  for (const s of snapshots) {
    const k = `${s.marketId}\0${s.assetId}`;
    const arr = snapByKey.get(k) ?? [];
    arr.push({
      price: parseNum(s.price) ?? 0.5,
      liquidity: parseNum(s.liquidity),
    });
    snapByKey.set(k, arr);
  }

  // Optional cross-market comparison baseline by category.
  const byCategory = new Map<string, number[]>();
  for (const c of candidates) {
    const p = parseNum(c.entryPrice) ?? parseNum(c.shadowInput.intendedPrice) ?? 0.5;
    const cat = c.category ?? "__unknown__";
    const arr = byCategory.get(cat) ?? [];
    arr.push(p);
    byCategory.set(cat, arr);
  }
  const categoryMedian = new Map<string, number>();
  for (const [cat, prices] of byCategory) {
    const sorted = [...prices].sort((a, b) => a - b);
    const mid = sorted[Math.floor(sorted.length / 2)] ?? 0.5;
    categoryMedian.set(cat, mid);
  }

  const rawMeanRev: number[] = [];
  const rawVelChange: number[] = [];
  const rawDisagreement: number[] = [];
  const rawSpreadConf: number[] = [];
  const rawCrossMarket: number[] = [];

  const baseRows = candidates.map((c) => {
    const key = `${c.marketId}\0${c.assetId}`;
    const snaps = snapByKey.get(key) ?? [];
    const currentPrice = parseNum(c.entryPrice) ?? parseNum(c.shadowInput.intendedPrice) ?? 0.5;
    const spreadBps = parseNum(c.shadowInput.spreadBps);
    const spreadNorm = spreadBps == null ? 0.5 : clamp01(spreadBps / 500);

    const recentPrices = snaps.length > 0 ? snaps.map((x) => x.price) : [currentPrice];
    const avgRecent = recentPrices.reduce((a, b) => a + b, 0) / recentPrices.length;
    const meanReversionRaw = Math.abs(currentPrice - avgRecent);

    let velChangeRaw = 0;
    if (recentPrices.length >= minSnapshotsForVelocity) {
      const p2 = recentPrices[recentPrices.length - 3]!;
      const p1 = recentPrices[recentPrices.length - 2]!;
      const p0 = recentPrices[recentPrices.length - 1]!;
      const vOld = p1 - p2;
      const vNew = p0 - p1;
      velChangeRaw = Math.abs(vNew - vOld);
    }

    const distFromMid = Math.abs(currentPrice - 0.5) / 0.5;
    const disagreementRaw = clamp01(distFromMid) * (1 - spreadNorm);

    const latestLiquidity = snaps.length > 0 ? snaps[snaps.length - 1]!.liquidity : null;
    const liqNorm = latestLiquidity == null ? 0.5 : clamp01(latestLiquidity / 50_000);
    const spreadConfRaw = (1 - spreadNorm) * liqNorm;

    const cat = c.category ?? "__unknown__";
    const peerMedian = categoryMedian.get(cat);
    const crossRaw =
      peerMedian != null && (byCategory.get(cat)?.length ?? 0) >= 3
        ? Math.abs(currentPrice - peerMedian)
        : 0;

    rawMeanRev.push(meanReversionRaw);
    rawVelChange.push(velChangeRaw);
    rawDisagreement.push(disagreementRaw);
    rawSpreadConf.push(spreadConfRaw);
    rawCrossMarket.push(crossRaw);

    return {
      c,
      meanReversionRaw,
      velChangeRaw,
      disagreementRaw,
      spreadConfRaw,
      crossRaw,
    };
  });

  const nMean = minMax(rawMeanRev);
  const nVel = minMax(rawVelChange);
  const nDis = minMax(rawDisagreement);
  const nConf = minMax(rawSpreadConf);
  const nCross = minMax(rawCrossMarket);

  const vectors: MispricingFeatureVector[] = baseRows.map((r, i) => ({
    recommendationId: r.c.recommendationId,
    marketId: r.c.marketId,
    assetId: r.c.assetId,
    meanReversionSignal: nMean[i] ?? 0.5,
    priceVelocityChange: nVel[i] ?? 0.5,
    marketDisagreementProxy: nDis[i] ?? 0.5,
    spreadAdjustedConfidence: nConf[i] ?? 0.5,
    crossMarketComparison: nCross[i] ?? 0.5,
  }));

  const byRecommendationId: Record<string, MispricingFeatureVector> = {};
  for (const v of vectors) byRecommendationId[v.recommendationId] = v;
  return { vectors, byRecommendationId };
}
