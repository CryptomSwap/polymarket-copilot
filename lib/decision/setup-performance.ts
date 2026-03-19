/**
 * Setup performance profiling from execution analytics.
 * Aggregates by signalType, category, theme, reviewStatus.
 * Persists SetupPerformanceProfile for use by the staged decision engine.
 */

import { prisma } from "@/lib/db";

function parseNum(s: string | null | undefined): number {
  if (s == null || s === "") return 0;
  const n = parseFloat(String(s).trim());
  return Number.isFinite(n) ? n : 0;
}

export interface ProfileRow {
  signalType: string | null;
  category: string | null;
  theme: string | null;
  reviewStatus: string | null;
  sampleCount: number;
  actedWinRate: number | null;
  ignoredWinRate: number | null;
  avgForwardReturn6h: number | null;
  avgForwardReturn24h: number | null;
  overrideWinRate: number | null;
}

/**
 * Build setup performance profiles from execution outcomes and evaluations.
 * Groups by signalType, category, theme, reviewStatus (each dimension separately).
 */
export async function buildSetupPerformanceProfiles(funderAddress?: string): Promise<{
  created: number;
  updated: number;
}> {
  const funderFilter = funderAddress ? { funderAddress: funderAddress.toLowerCase() } : {};

  const outcomes = await prisma.recommendationExecutionOutcome.findMany({
    where: funderFilter,
    include: {
      recommendation: {
        include: {
          marketSignal: true,
          review: true,
        },
      },
    },
  });

  const recIds = Array.from(new Set(outcomes.map((o) => o.recommendationId)));
  const allRecs = await prisma.recommendation.findMany({
    where: { marketSignal: funderFilter },
    include: { marketSignal: true, review: true },
  });

  const recsWithOutcome = new Set(outcomes.map((o) => o.recommendationId));
  const ignoredRecs = allRecs.filter((r) => !recsWithOutcome.has(r.id));

  const latestEvals = await prisma.recommendationEvaluation.findMany({
    where: { recommendationId: { in: allRecs.map((r) => r.id) } },
    orderBy: { evaluatedAt: "desc" },
  });
  const evalByRec = new Map<string, { priceChange6h: string | null; priceChange24h: string | null }>();
  for (const e of latestEvals) {
    if (!evalByRec.has(e.recommendationId)) {
      evalByRec.set(e.recommendationId, { priceChange6h: e.priceChange6h, priceChange24h: e.priceChange24h });
    }
  }

  function winRateFromReturns(returns: number[]): number | null {
    if (returns.length === 0) return null;
    const wins = returns.filter((r) => r > 0).length;
    return wins / returns.length;
  }

  function aggregateByDimension(
    key: "signalType" | "category" | "theme" | "reviewStatus"
  ): Map<string, ProfileRow> {
    const map = new Map<string, ProfileRow>();

    function getKey(rec: { marketSignal: { signalType: string | null; category: string | null; theme: string | null }; review: { status: string } | null }): string | null {
      switch (key) {
        case "signalType": return rec.marketSignal.signalType ?? null;
        case "category": return rec.marketSignal.category ?? null;
        case "theme": return rec.marketSignal.theme ?? null;
        case "reviewStatus": return rec.review?.status ?? "NEW";
        default: return null;
      }
    }

    for (const o of outcomes) {
      const rec = o.recommendation;
      const k = getKey(rec);
      if (k == null || k === "") continue;
      type Raw = ProfileRow & { actedReturns24?: number[]; actedReturns6?: number[]; overrideReturns24?: number[] };
      const existing = map.get(k) ?? ({
        signalType: key === "signalType" ? k : null,
        category: key === "category" ? k : null,
        theme: key === "theme" ? k : null,
        reviewStatus: key === "reviewStatus" ? k : null,
        sampleCount: 0,
        actedWinRate: null,
        ignoredWinRate: null,
        avgForwardReturn6h: null,
        avgForwardReturn24h: null,
        overrideWinRate: null,
      } as Raw);
      existing.sampleCount++;
      const ret24 = parseNum(o.forwardReturn24h);
      const ret6 = parseNum(o.forwardReturn6h);
      if (!(existing as Raw).actedReturns24) (existing as Raw).actedReturns24 = [];
      (existing as Raw).actedReturns24!.push(ret24);
      if (!(existing as Raw).actedReturns6) (existing as Raw).actedReturns6 = [];
      (existing as Raw).actedReturns6!.push(ret6);
      if (o.overridden) {
        if (!(existing as Raw).overrideReturns24) (existing as Raw).overrideReturns24 = [];
        (existing as Raw).overrideReturns24!.push(ret24);
      }
      map.set(k, existing);
    }

    for (const rec of ignoredRecs) {
      const k = getKey(rec);
      if (k == null || k === "") continue;
      type Raw = ProfileRow & { ignoredReturns24?: number[]; ignoredReturns6?: number[] };
      const existing = map.get(k) ?? ({
        signalType: key === "signalType" ? k : null,
        category: key === "category" ? k : null,
        theme: key === "theme" ? k : null,
        reviewStatus: key === "reviewStatus" ? k : null,
        sampleCount: 0,
        actedWinRate: null,
        ignoredWinRate: null,
        avgForwardReturn6h: null,
        avgForwardReturn24h: null,
        overrideWinRate: null,
      } as Raw);
      existing.sampleCount++;
      const ev = evalByRec.get(rec.id);
      const r24 = ev ? parseNum(ev.priceChange24h) : 0;
      const r6 = ev ? parseNum(ev.priceChange6h) : 0;
      if (!(existing as Raw).ignoredReturns24) (existing as Raw).ignoredReturns24 = [];
      (existing as Raw).ignoredReturns24!.push(r24);
      if (!(existing as Raw).ignoredReturns6) (existing as Raw).ignoredReturns6 = [];
      (existing as Raw).ignoredReturns6!.push(r6);
      map.set(k, existing);
    }

    const result = new Map<string, ProfileRow>();
    interface RawRow extends ProfileRow {
      actedReturns24?: number[];
      ignoredReturns24?: number[];
      actedReturns6?: number[];
      ignoredReturns6?: number[];
      overrideReturns24?: number[];
    }
    for (const [k, raw] of Array.from(map.entries())) {
      const r = raw as RawRow;
      const acted24 = r.actedReturns24 ?? [];
      const ignored24 = r.ignoredReturns24 ?? [];
      const acted6 = r.actedReturns6 ?? [];
      const ignored6 = r.ignoredReturns6 ?? [];
      const override24 = r.overrideReturns24 ?? [];
      const all24 = [...acted24, ...ignored24];
      const all6 = [...acted6, ...ignored6];
      result.set(k, {
        signalType: raw.signalType,
        category: raw.category,
        theme: raw.theme,
        reviewStatus: raw.reviewStatus,
        sampleCount: raw.sampleCount,
        actedWinRate: winRateFromReturns(acted24),
        ignoredWinRate: winRateFromReturns(ignored24),
        avgForwardReturn6h: all6.length > 0 ? all6.reduce((a, b) => a + b, 0) / all6.length : null,
        avgForwardReturn24h: all24.length > 0 ? all24.reduce((a, b) => a + b, 0) / all24.length : null,
        overrideWinRate: override24.length > 0 ? winRateFromReturns(override24) : null,
      });
    }
    return result;
  }

  const bySignal = aggregateByDimension("signalType");
  const byCategory = aggregateByDimension("category");
  const byTheme = aggregateByDimension("theme");
  const byReview = aggregateByDimension("reviewStatus");

  const allProfiles: ProfileRow[] = [];
  allProfiles.push(...Array.from(bySignal.values()));
  allProfiles.push(...Array.from(byCategory.values()));
  allProfiles.push(...Array.from(byTheme.values()));
  allProfiles.push(...Array.from(byReview.values()));

  let created = 0;
  let updated = 0;
  for (const row of allProfiles) {
    const existing = await prisma.setupPerformanceProfile.findFirst({
      where: {
        signalType: row.signalType,
        category: row.category,
        theme: row.theme,
        reviewStatus: row.reviewStatus,
      },
    });
    const data = {
      sampleCount: row.sampleCount,
      actedWinRate: row.actedWinRate,
      ignoredWinRate: row.ignoredWinRate,
      avgForwardReturn6h: row.avgForwardReturn6h,
      avgForwardReturn24h: row.avgForwardReturn24h,
      overrideWinRate: row.overrideWinRate,
    };
    if (existing) {
      await prisma.setupPerformanceProfile.update({ where: { id: existing.id }, data });
      updated++;
    } else {
      await prisma.setupPerformanceProfile.create({
        data: {
          ...data,
          signalType: row.signalType ?? undefined,
          category: row.category ?? undefined,
          theme: row.theme ?? undefined,
          reviewStatus: row.reviewStatus ?? undefined,
        },
      });
      created++;
    }
  }
  return { created, updated };
}

/**
 * Get profile adjustments for a recommendation (signalType, category, theme, reviewStatus).
 * Returns average acted/ignored win rate and forward return for matching profiles.
 */
export async function getSetupAdjustment(params: {
  signalType: string | null;
  category: string | null;
  theme: string | null;
  reviewStatus: string | null;
}): Promise<{
  actedWinRate: number | null;
  ignoredWinRate: number | null;
  avgForwardReturn24h: number | null;
  overrideWinRate: number | null;
  sampleCount: number;
}> {
  const profiles: { actedWinRate: number | null; ignoredWinRate: number | null; avgForwardReturn24h: number | null; overrideWinRate: number | null; sampleCount: number }[] = [];
  if (params.signalType) {
    const p = await prisma.setupPerformanceProfile.findFirst({
      where: { signalType: params.signalType },
    });
    if (p) profiles.push(p);
  }
  if (params.category) {
    const p = await prisma.setupPerformanceProfile.findFirst({
      where: { category: params.category },
    });
    if (p) profiles.push(p);
  }
  if (params.theme) {
    const p = await prisma.setupPerformanceProfile.findFirst({
      where: { theme: params.theme },
    });
    if (p) profiles.push(p);
  }
  if (params.reviewStatus) {
    const p = await prisma.setupPerformanceProfile.findFirst({
      where: { reviewStatus: params.reviewStatus },
    });
    if (p) profiles.push(p);
  }
  if (profiles.length === 0) {
    return { actedWinRate: null, ignoredWinRate: null, avgForwardReturn24h: null, overrideWinRate: null, sampleCount: 0 };
  }
  const acted = profiles.map((p) => p.actedWinRate).filter((v): v is number => v != null);
  const ignored = profiles.map((p) => p.ignoredWinRate).filter((v): v is number => v != null);
  const ret24 = profiles.map((p) => p.avgForwardReturn24h).filter((v): v is number => v != null);
  const over = profiles.map((p) => p.overrideWinRate).filter((v): v is number => v != null);
  const totalSamples = profiles.reduce((s, p) => s + p.sampleCount, 0);
  return {
    actedWinRate: acted.length > 0 ? acted.reduce((a, b) => a + b, 0) / acted.length : null,
    ignoredWinRate: ignored.length > 0 ? ignored.reduce((a, b) => a + b, 0) / ignored.length : null,
    avgForwardReturn24h: ret24.length > 0 ? ret24.reduce((a, b) => a + b, 0) / ret24.length : null,
    overrideWinRate: over.length > 0 ? over.reduce((a, b) => a + b, 0) / over.length : null,
    sampleCount: totalSamples,
  };
}
