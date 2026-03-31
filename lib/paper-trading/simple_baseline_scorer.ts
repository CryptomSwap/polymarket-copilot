import type { PaperTradingCandidate } from "./candidates";

export interface SimpleBaselineWeights {
  w1Spread: number;
  w2PricePos: number;
  w3Momentum: number;
  w4Liquidity: number;
}

export interface SimpleBaselineFeatureBreakdown {
  spreadNormalized: number;
  pricePosition: number;
  momentum: number;
  liquidity: number;
  usedMomentumSignal: boolean;
  usedLiquiditySignal: boolean;
}

export interface SimpleBaselineScoredCandidate {
  candidate: PaperTradingCandidate;
  scoreRaw: number;
  score: number;
  features: SimpleBaselineFeatureBreakdown;
}

export interface SimpleBaselineDistributionStats {
  min: number;
  max: number;
  mean: number;
  std: number;
}

export interface SimpleBaselineScoreResult {
  scored: SimpleBaselineScoredCandidate[];
  weights: SimpleBaselineWeights;
  statsRaw: SimpleBaselineDistributionStats;
  statsNormalized: SimpleBaselineDistributionStats;
}

const DEFAULT_WEIGHTS: SimpleBaselineWeights = {
  w1Spread: 0.35,
  w2PricePos: 0.25,
  w3Momentum: 0.2,
  w4Liquidity: 0.2,
};

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

function stats(values: number[]): SimpleBaselineDistributionStats {
  if (values.length === 0) {
    return { min: 0, max: 0, mean: 0, std: 0 };
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / values.length;
  return { min, max, mean, std: Math.sqrt(Math.max(0, variance)) };
}

function minMaxNormalize(vals: number[]): number[] {
  if (vals.length === 0) return [];
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  if (hi - lo <= 1e-12) return vals.map(() => 0.5);
  return vals.map((v) => clamp01((v - lo) / (hi - lo)));
}

/**
 * If normalized scores collapse too tightly, blend with deterministic rank percentile
 * to widen range while preserving ordering.
 */
function widenIfCollapsed(values01: number[]): number[] {
  const s = stats(values01);
  if (s.std >= 0.12 || values01.length <= 2) return values01;

  const indexed = values01.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => (a.v === b.v ? a.i - b.i : a.v - b.v));

  const rankPct = new Array<number>(values01.length).fill(0);
  for (let r = 0; r < indexed.length; r++) {
    rankPct[indexed[r]!.i] = indexed.length === 1 ? 0.5 : r / (indexed.length - 1);
  }

  return values01.map((v, i) => clamp01(0.5 * v + 0.5 * rankPct[i]!));
}

function deriveFeatures(c: PaperTradingCandidate): SimpleBaselineFeatureBreakdown {
  const intendedPrice = parseNum(c.entryPrice) ?? parseNum(c.shadowInput.intendedPrice) ?? 0.5;
  const spreadBps = parseNum(c.shadowInput.spreadBps);
  const spreadNormalized = spreadBps == null ? 0.5 : clamp01(spreadBps / 500);

  // Distance from fair coin price, normalized to [0,1] by max distance 0.5.
  const pricePosition = clamp01(Math.abs(intendedPrice - 0.5) / 0.5);

  const momentum1hBps = parseNum(c.shadowInput.momentum1hBps);
  const momentum6hBps = parseNum(c.shadowInput.momentum6hBps);
  let momentum = 0.5;
  let usedMomentumSignal = false;
  if (momentum1hBps != null || momentum6hBps != null) {
    const m = momentum1hBps ?? momentum6hBps ?? 0;
    momentum = clamp01((m + 300) / 600);
    usedMomentumSignal = true;
  } else {
    // Fallback proxy: current intended vs quote mid.
    const mid = c.shadowInput.quoteMidPrice;
    if (mid != null && Number.isFinite(mid)) {
      momentum = clamp01(((intendedPrice - mid) + 0.15) / 0.3);
      usedMomentumSignal = true;
    }
  }

  const liquidityTrend = parseNum(c.shadowInput.liquidityTrend);
  let liquidity = 0.5;
  let usedLiquiditySignal = false;
  if (liquidityTrend != null) {
    liquidity = clamp01((liquidityTrend + 1) / 2);
    usedLiquiditySignal = true;
  } else {
    // Fallback proxy: combine tradable flag and quote availability.
    const tradable = c.shadowInput.tradable === true ? 1 : 0;
    const quoteReady =
      c.shadowInput.quoteBestBid != null && c.shadowInput.quoteBestAsk != null && c.shadowInput.quoteBestAsk > c.shadowInput.quoteBestBid
        ? 1
        : 0;
    liquidity = 0.4 * tradable + 0.6 * quoteReady;
  }

  return {
    spreadNormalized,
    pricePosition,
    momentum,
    liquidity,
    usedMomentumSignal,
    usedLiquiditySignal,
  };
}

export function computeSimpleBaselineScores(
  candidates: PaperTradingCandidate[],
  weights?: Partial<SimpleBaselineWeights>
): SimpleBaselineScoreResult {
  const w: SimpleBaselineWeights = { ...DEFAULT_WEIGHTS, ...(weights ?? {}) };
  const weightSum = w.w1Spread + w.w2PricePos + w.w3Momentum + w.w4Liquidity;
  const normWeight = weightSum > 0 ? weightSum : 1;

  const prelim = candidates.map((candidate) => {
    const f = deriveFeatures(candidate);
    const raw =
      (w.w1Spread * (1 - f.spreadNormalized) +
        w.w2PricePos * f.pricePosition +
        w.w3Momentum * f.momentum +
        w.w4Liquidity * f.liquidity) /
      normWeight;
    return { candidate, features: f, scoreRaw: clamp01(raw) };
  });

  const rawVals = prelim.map((x) => x.scoreRaw);
  const normalized = widenIfCollapsed(minMaxNormalize(rawVals));
  const scored: SimpleBaselineScoredCandidate[] = prelim.map((x, i) => ({
    candidate: x.candidate,
    features: x.features,
    scoreRaw: x.scoreRaw,
    score: normalized[i] ?? 0,
  }));

  return {
    scored,
    weights: w,
    statsRaw: stats(rawVals),
    statsNormalized: stats(scored.map((x) => x.score)),
  };
}
