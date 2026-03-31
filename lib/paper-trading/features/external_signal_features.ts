import { prisma } from "@/lib/db";
import type { PaperTradingCandidate } from "../candidates";

export interface ExternalSignalFeatureVector {
  recommendationId: string;
  marketId: string;
  assetId: string;
  crossMarketConsistency: number;
  timeToResolutionSignal: number;
  priceDriftSignal: number;
  marketActivityProxy: number;
  eventTypeHeuristic: number;
}

export interface ExternalSignalFeatureBuildResult {
  vectors: ExternalSignalFeatureVector[];
  byRecommendationId: Record<string, ExternalSignalFeatureVector>;
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

function median(vals: number[]): number {
  if (vals.length === 0) return 0.5;
  const s = [...vals].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0.5;
}

/**
 * External/derived signals that introduce informational variation without touching engine scoring.
 * Outputs are normalized to [0,1].
 */
export async function buildExternalSignalFeatureVectors(
  candidates: PaperTradingCandidate[],
  opts?: { lookbackHours?: number }
): Promise<ExternalSignalFeatureBuildResult> {
  const lookbackHours = opts?.lookbackHours ?? 24;
  const since = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);

  const marketKeys = Array.from(new Set(candidates.map((c) => c.marketId)));
  const assetIds = Array.from(new Set(candidates.map((c) => c.assetId)));

  const syncedMarkets = await prisma.syncedMarket.findMany({
    where: { OR: [{ id: { in: marketKeys } }, { conditionId: { in: marketKeys } }] },
    select: { id: true, conditionId: true, endDate: true, category: true },
  });

  const resolvedIdsByKey = new Map<string, string[]>();
  for (const key of marketKeys) resolvedIdsByKey.set(key, [key]);
  for (const m of syncedMarkets) {
    const ids = [m.id];
    if (m.conditionId) ids.push(m.conditionId);
    for (const k of ids) {
      const cur = resolvedIdsByKey.get(k) ?? [k];
      if (!cur.includes(m.id)) cur.push(m.id);
      resolvedIdsByKey.set(k, cur);
    }
  }

  const allResolvedMarketIds = Array.from(
    new Set(
      [...resolvedIdsByKey.values()].flatMap((xs) => xs)
    )
  );
  const snapshots = await prisma.marketPriceSnapshot.findMany({
    where: {
      marketId: { in: allResolvedMarketIds },
      assetId: { in: assetIds },
      capturedAt: { gte: since },
    },
    orderBy: { capturedAt: "asc" },
    select: { marketId: true, assetId: true, price: true, volume: true, capturedAt: true },
  });

  const snapByMarketAsset = new Map<string, Array<{ price: number; volume: number | null }>>();
  for (const s of snapshots) {
    const k = `${s.marketId}\0${s.assetId}`;
    const arr = snapByMarketAsset.get(k) ?? [];
    arr.push({
      price: parseNum(s.price) ?? 0.5,
      volume: parseNum(s.volume),
    });
    snapByMarketAsset.set(k, arr);
  }

  const categoryByMarket = new Map<string, string>();
  const endByMarket = new Map<string, Date | null>();
  for (const m of syncedMarkets) {
    categoryByMarket.set(m.id, m.category ?? "unknown");
    endByMarket.set(m.id, m.endDate ?? null);
    if (m.conditionId) {
      categoryByMarket.set(m.conditionId, m.category ?? "unknown");
      endByMarket.set(m.conditionId, m.endDate ?? null);
    }
  }

  const pricesByCategory = new Map<string, number[]>();
  for (const c of candidates) {
    const p = parseNum(c.entryPrice) ?? parseNum(c.shadowInput.intendedPrice) ?? 0.5;
    const cat = c.category ?? categoryByMarket.get(c.marketId) ?? "unknown";
    const arr = pricesByCategory.get(cat) ?? [];
    arr.push(p);
    pricesByCategory.set(cat, arr);
  }
  const categoryMedian = new Map<string, number>();
  for (const [cat, vals] of pricesByCategory) categoryMedian.set(cat, median(vals));

  const categoryCounts = new Map<string, number>();
  for (const c of candidates) {
    const cat = c.category ?? categoryByMarket.get(c.marketId) ?? "unknown";
    categoryCounts.set(cat, (categoryCounts.get(cat) ?? 0) + 1);
  }

  const rawCross: number[] = [];
  const rawTtr: number[] = [];
  const rawDrift: number[] = [];
  const rawActivity: number[] = [];
  const rawEventType: number[] = [];

  const base = candidates.map((c) => {
    const cat = c.category ?? categoryByMarket.get(c.marketId) ?? "unknown";
    const currentPrice = parseNum(c.entryPrice) ?? parseNum(c.shadowInput.intendedPrice) ?? 0.5;
    const catMed = categoryMedian.get(cat) ?? 0.5;
    const crossRaw = Math.abs(currentPrice - catMed);

    const marketEnd = endByMarket.get(c.marketId) ?? null;
    let ttrRaw = 0.5;
    if (marketEnd) {
      const hours = (marketEnd.getTime() - Date.now()) / (60 * 60 * 1000);
      // Closer-to-resolution markets get higher signal value.
      ttrRaw = clamp01(1 - hours / (14 * 24));
    }

    const ids = resolvedIdsByKey.get(c.marketId) ?? [c.marketId];
    const snaps = ids.flatMap((id) => snapByMarketAsset.get(`${id}\0${c.assetId}`) ?? []);

    let driftRaw = 0;
    let activityRaw = 0;
    if (snaps.length >= 2) {
      const first = snaps[0]!;
      const last = snaps[snaps.length - 1]!;
      driftRaw = last.price - first.price;

      const mid = Math.floor(snaps.length / 2);
      const older = snaps.slice(0, mid).map((s) => s.volume).filter((v): v is number => v != null);
      const newer = snaps.slice(mid).map((s) => s.volume).filter((v): v is number => v != null);
      const olderAvg = older.length > 0 ? older.reduce((a, b) => a + b, 0) / older.length : null;
      const newerAvg = newer.length > 0 ? newer.reduce((a, b) => a + b, 0) / newer.length : null;
      if (olderAvg != null && olderAvg > 0 && newerAvg != null) {
        activityRaw = (newerAvg - olderAvg) / olderAvg;
      } else if (newerAvg != null) {
        activityRaw = newerAvg > 0 ? 1 : 0;
      }
    }

    const count = categoryCounts.get(cat) ?? 1;
    // Rarer category in current universe => higher heuristic signal.
    const eventTypeRaw = 1 / count;

    rawCross.push(crossRaw);
    rawTtr.push(ttrRaw);
    rawDrift.push(driftRaw);
    rawActivity.push(activityRaw);
    rawEventType.push(eventTypeRaw);

    return { c, crossRaw, ttrRaw, driftRaw, activityRaw, eventTypeRaw };
  });

  const nCross = minMax(rawCross);
  const nTtr = minMax(rawTtr);
  const nDrift = minMax(rawDrift);
  const nActivity = minMax(rawActivity);
  const nEvent = minMax(rawEventType);

  const vectors: ExternalSignalFeatureVector[] = base.map((r, i) => ({
    recommendationId: r.c.recommendationId,
    marketId: r.c.marketId,
    assetId: r.c.assetId,
    crossMarketConsistency: nCross[i] ?? 0.5,
    timeToResolutionSignal: nTtr[i] ?? 0.5,
    priceDriftSignal: nDrift[i] ?? 0.5,
    marketActivityProxy: nActivity[i] ?? 0.5,
    eventTypeHeuristic: nEvent[i] ?? 0.5,
  }));

  const byRecommendationId: Record<string, ExternalSignalFeatureVector> = {};
  for (const v of vectors) byRecommendationId[v.recommendationId] = v;
  return { vectors, byRecommendationId };
}
