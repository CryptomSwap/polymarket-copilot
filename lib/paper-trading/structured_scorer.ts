import { prisma } from "@/lib/db";
import type { PaperTradingCandidate } from "./candidates";
import { buildExternalSignalFeatureVectors, type ExternalSignalFeatureVector } from "./features/external_signal_features";

export type StructuredPriceBand = "0.2-0.35" | "0.35-0.5" | "0.5-0.65" | "0.65-0.8";
export type StructuredSpreadQuartile = "Q1" | "Q2" | "Q3" | "Q4";

export interface StructuredScoringModel {
  lookbackDays: number;
  midRangeMin: number;
  midRangeMax: number;
  sampleSize: number;
  globalMeanOutcome: number;
  globalStdOutcome: number;
  spreadCutoffs: [number, number, number];
  priceBandWeights: Record<StructuredPriceBand, number>;
  spreadQuartileWeights: Record<StructuredSpreadQuartile, number>;
  interactionWeights: Record<string, number>;
  optionalWeights: {
    crossMarketConsistency: number;
    priceDriftSignal: number;
  };
}

export interface StructuredScoredCandidate {
  candidate: PaperTradingCandidate;
  score: number;
  linear: number;
  priceBand: StructuredPriceBand;
  spreadQuartile: StructuredSpreadQuartile;
  external: Pick<ExternalSignalFeatureVector, "crossMarketConsistency" | "priceDriftSignal"> | null;
}

function parseNum(v: string | number | null | undefined): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

function parsePriceBoundEnv(key: string, fallback: number): number {
  const raw = process.env[key]?.trim();
  if (!raw) return fallback;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as unknown;
    return p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function extractSpreadBps(metaRaw: string | null | undefined): number | null {
  const m = parseJsonObject(metaRaw);
  if (!m) return null;
  const direct = parseNum(m.spreadBps as string | number | null | undefined);
  if (direct != null) return direct;
  const roi = m.paperRoiAdmission as Record<string, unknown> | undefined;
  const roiSpread = parseNum(roi?.spreadBpsAtAdmission as string | number | null | undefined);
  if (roiSpread != null) return roiSpread;
  const oa = m.openAttribution as Record<string, unknown> | undefined;
  const ctx = oa?.executionContext as Record<string, unknown> | undefined;
  return parseNum(ctx?.spreadBps as string | number | null | undefined);
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function std(values: number[], m: number): number {
  if (values.length === 0) return 0;
  const variance = values.reduce((a, b) => a + (b - m) ** 2, 0) / values.length;
  return Math.sqrt(Math.max(0, variance));
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * q)));
  return sorted[idx] ?? 0;
}

function sigmoid(x: number): number {
  if (x > 30) return 1;
  if (x < -30) return 0;
  return 1 / (1 + Math.exp(-x));
}

function resolvePriceBand(price: number): StructuredPriceBand {
  if (price < 0.35) return "0.2-0.35";
  if (price < 0.5) return "0.35-0.5";
  if (price < 0.65) return "0.5-0.65";
  return "0.65-0.8";
}

function resolveSpreadQuartile(spreadBps: number | null, cutoffs: [number, number, number]): StructuredSpreadQuartile {
  if (spreadBps == null) return "Q4";
  if (spreadBps <= cutoffs[0]) return "Q1";
  if (spreadBps <= cutoffs[1]) return "Q2";
  if (spreadBps <= cutoffs[2]) return "Q3";
  return "Q4";
}

function interactionKey(priceBand: StructuredPriceBand, spreadQ: StructuredSpreadQuartile): string {
  return `${priceBand}|${spreadQ}`;
}

function slopeWeight(xs: number[], ys: number[]): number {
  if (xs.length !== ys.length || xs.length < 3) return 0;
  const mx = mean(xs);
  const my = mean(ys);
  let cov = 0;
  let vx = 0;
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i]! - mx;
    cov += dx * (ys[i]! - my);
    vx += dx * dx;
  }
  if (vx <= 1e-12) return 0;
  return cov / vx;
}

type HistRow = {
  recommendationId: string;
  marketId: string;
  assetId: string;
  category: string | null;
  entryPrice: number;
  spreadBps: number | null;
  outcome: number;
};

export async function buildStructuredScoringModel(
  lookbackDays = 30
): Promise<StructuredScoringModel> {
  const minCfg = parsePriceBoundEnv("PAPER_TRADING_PRICE_MIN", 0.2);
  const maxCfg = parsePriceBoundEnv("PAPER_TRADING_PRICE_MAX", 0.8);
  const midRangeMin = Math.min(minCfg, maxCfg);
  const midRangeMax = Math.max(minCfg, maxCfg);

  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
  const trades = await prisma.paperTrade.findMany({
    where: {
      status: "closed",
      createdAt: { gte: since },
      OR: [{ markout12h: { not: null } }, { pnlPct: { not: null } }],
    },
    select: {
      id: true,
      marketId: true,
      assetId: true,
      category: true,
      entryPrice: true,
      markout12h: true,
      pnlPct: true,
      metadataJson: true,
    } as any,
  });

  const rows: HistRow[] = trades
    .map((t) => {
      const outcome = parseNum((t as any).markout12h) ?? parseNum((t as any).pnlPct);
      const entryPrice = parseNum((t as any).entryPrice);
      if (outcome == null || entryPrice == null) return null;
      if (entryPrice < midRangeMin || entryPrice > midRangeMax) return null;
      const meta = parseJsonObject((t as any).metadataJson);
      const recommendationId =
        (typeof meta?.recommendationId === "string" && meta.recommendationId) || `paper:${(t as any).id}`;
      return {
        recommendationId: String(recommendationId),
        marketId: (t as any).marketId,
        assetId: (t as any).assetId,
        category: (t as any).category ?? null,
        entryPrice,
        spreadBps: extractSpreadBps((t as any).metadataJson),
        outcome,
      };
    })
    .filter((x): x is HistRow => x != null);

  const outcomes = rows.map((r) => r.outcome);
  const globalMeanOutcome = mean(outcomes);
  const globalStdOutcome = Math.max(1e-6, std(outcomes, globalMeanOutcome));

  const spreads = rows.map((r) => r.spreadBps).filter((x): x is number => x != null).sort((a, b) => a - b);
  const spreadCutoffs: [number, number, number] =
    spreads.length >= 4
      ? [quantile(spreads, 0.25), quantile(spreads, 0.5), quantile(spreads, 0.75)]
      : [75, 150, 300];

  const bandMeans = new Map<StructuredPriceBand, number[]>();
  const spreadMeans = new Map<StructuredSpreadQuartile, number[]>();
  const comboMeans = new Map<string, number[]>();
  for (const r of rows) {
    const b = resolvePriceBand(r.entryPrice);
    const q = resolveSpreadQuartile(r.spreadBps, spreadCutoffs);
    const k = interactionKey(b, q);
    (bandMeans.get(b) ?? (bandMeans.set(b, []), bandMeans.get(b)!)).push(r.outcome);
    (spreadMeans.get(q) ?? (spreadMeans.set(q, []), spreadMeans.get(q)!)).push(r.outcome);
    (comboMeans.get(k) ?? (comboMeans.set(k, []), comboMeans.get(k)!)).push(r.outcome);
  }

  const allBands: StructuredPriceBand[] = ["0.2-0.35", "0.35-0.5", "0.5-0.65", "0.65-0.8"];
  const allQs: StructuredSpreadQuartile[] = ["Q1", "Q2", "Q3", "Q4"];

  const priceBandWeights: Record<StructuredPriceBand, number> = {
    "0.2-0.35": 0,
    "0.35-0.5": 0,
    "0.5-0.65": 0,
    "0.65-0.8": 0,
  };
  for (const b of allBands) {
    const m = mean(bandMeans.get(b) ?? []);
    priceBandWeights[b] = m - globalMeanOutcome;
  }

  const spreadQuartileWeights: Record<StructuredSpreadQuartile, number> = {
    Q1: 0,
    Q2: 0,
    Q3: 0,
    Q4: 0,
  };
  for (const q of allQs) {
    const m = mean(spreadMeans.get(q) ?? []);
    spreadQuartileWeights[q] = m - globalMeanOutcome;
  }

  const interactionWeights: Record<string, number> = {};
  for (const b of allBands) {
    for (const q of allQs) {
      const k = interactionKey(b, q);
      const m = mean(comboMeans.get(k) ?? []);
      interactionWeights[k] = m - globalMeanOutcome - priceBandWeights[b] - spreadQuartileWeights[q];
    }
  }

  // Optional term weights derived from historical outcomes when data is available.
  let crossMarketConsistencyWeight = 0;
  let priceDriftSignalWeight = 0;
  if (rows.length >= 10) {
    const pseudoCandidates: PaperTradingCandidate[] = rows.map((r) => ({
      recommendationId: r.recommendationId,
      marketId: r.marketId,
      assetId: r.assetId,
      outcome: "",
      side: "BUY",
      entryPrice: String(r.entryPrice),
      intendedSize: "1",
      theme: null,
      category: r.category,
      shadowInput: {
        policyState: null,
        sizeMultiplier: null,
        finalSuggestedSize: null,
        eligibilityBlockersCount: 0,
        reducedSizeIndicator: false,
        blockedIndicator: false,
        executionAllow: null,
        executionWarningCount: 0,
        qualityState: null,
        spreadBps: r.spreadBps == null ? null : String(r.spreadBps),
        estimatedSlippage: null,
        tradable: null,
        grossExposure: null,
        totalOpenExposure: null,
        maxSingleMarketConcentrationPct: null,
        maxSingleThemeConcentrationPct: null,
        portfolioRiskFlagsCount: 0,
        runtimeWarningCount: 0,
        runtimeBlockingCount: 0,
        intendedPrice: String(r.entryPrice),
        intendedSize: "1",
        recommendationPresent: true,
        side: "BUY",
      },
    }));
    const ex = await buildExternalSignalFeatureVectors(pseudoCandidates);
    const ys = rows.map((r) => r.outcome);
    const xCross = rows.map((r) => ex.byRecommendationId[r.recommendationId]?.crossMarketConsistency ?? 0.5);
    const xDrift = rows.map((r) => ex.byRecommendationId[r.recommendationId]?.priceDriftSignal ?? 0.5);
    crossMarketConsistencyWeight = slopeWeight(xCross, ys);
    priceDriftSignalWeight = slopeWeight(xDrift, ys);
  }

  return {
    lookbackDays,
    midRangeMin,
    midRangeMax,
    sampleSize: rows.length,
    globalMeanOutcome,
    globalStdOutcome,
    spreadCutoffs,
    priceBandWeights,
    spreadQuartileWeights,
    interactionWeights,
    optionalWeights: {
      crossMarketConsistency: crossMarketConsistencyWeight,
      priceDriftSignal: priceDriftSignalWeight,
    },
  };
}

export function scoreStructuredCandidates(
  candidates: PaperTradingCandidate[],
  model: StructuredScoringModel,
  externalByRecommendationId?: Record<string, ExternalSignalFeatureVector>
): StructuredScoredCandidate[] {
  return candidates.map((c) => {
    const price = parseNum(c.entryPrice) ?? parseNum(c.shadowInput.intendedPrice) ?? 0.5;
    const spread = parseNum(c.shadowInput.spreadBps);
    const band = resolvePriceBand(Math.max(model.midRangeMin, Math.min(model.midRangeMax, price)));
    const q = resolveSpreadQuartile(spread, model.spreadCutoffs);
    const inter = model.interactionWeights[interactionKey(band, q)] ?? 0;

    const ext = externalByRecommendationId?.[c.recommendationId] ?? null;
    const extCross = ext ? ext.crossMarketConsistency - 0.5 : 0;
    const extDrift = ext ? ext.priceDriftSignal - 0.5 : 0;

    const linear =
      model.globalMeanOutcome +
      model.priceBandWeights[band] +
      model.spreadQuartileWeights[q] +
      inter +
      model.optionalWeights.crossMarketConsistency * extCross +
      model.optionalWeights.priceDriftSignal * extDrift;

    const z = (linear - model.globalMeanOutcome) / model.globalStdOutcome;
    const score = sigmoid(z);
    return {
      candidate: c,
      score,
      linear,
      priceBand: band,
      spreadQuartile: q,
      external: ext
        ? {
            crossMarketConsistency: ext.crossMarketConsistency,
            priceDriftSignal: ext.priceDriftSignal,
          }
        : null,
    };
  });
}
