/**
 * Read-only paper score ↔ realized outcome alignment (metadata + closed PnL + label proxy).
 * Does not change thresholds, gates, or live trading.
 */

import { prisma } from "@/lib/db";
import { getPaperTradingConfig } from "@/lib/paper-trading/config";
import { effectivePaperMinScoreFromConfig } from "@/lib/paper-trading/paper-roi-admission";
import type { PaperScoreBand } from "@/lib/paper-trading/paper-score-band";
import {
  parseOpenAttributionFromMetadataJson,
  resolveScoreBandForPaperTrade,
} from "@/lib/paper-trading/paper-trade-open-attribution";

const PRIMARY_LABEL = "labelGoodDecision12h";
const BANDS: PaperScoreBand[] = ["low", "medium", "high"];

export interface PaperBandAggregate {
  scoreBand: PaperScoreBand;
  openCount: number;
  closedCount: number;
  labeledCount: number;
  labelPositiveRate: number | null;
  meanPnlPct: number | null;
  medianPnlPct: number | null;
  hitRatePnl: number | null;
  meanMarkout12h: number | null;
  meanSpreadBps: number | null;
  meanSlippageBps: number | null;
  spreadSamples: number;
  slippageSamples: number;
}

export interface PaperThresholdSlice {
  hypotheticalMinScore: number;
  closedTradeCountWithScoreGte: number;
  meanPnlPct: number | null;
  hitRatePnl: number | null;
  labeledCount: number;
  labelPositiveRate: number | null;
}

export interface PaperThresholdStudy {
  note: string;
  configThreshold: number;
  configMinScoreBuffer: number;
  effectiveMinScoreDefault: number;
  /** Closed trades with open-time score ≥ effective default min score vs below (exploration admits may be below). */
  outcomesAboveVsBelowEffectiveMin: {
    aboveOrEqual: { count: number; meanPnlPct: number | null; hitRatePnl: number | null };
    below: { count: number; meanPnlPct: number | null; hitRatePnl: number | null };
  };
  lastTickAboveThresholdCount: number | null;
  lastTickCandidatesScored: number | null;
  lastTickAt: string | null;
  medianSplit: {
    medianScore: number | null;
    atOrAboveMedian: { count: number; meanPnlPct: number | null; hitRatePnl: number | null };
    belowMedian: { count: number; meanPnlPct: number | null; hitRatePnl: number | null };
  };
  thresholdGrid: PaperThresholdSlice[];
  bestByMeanPnl: { hypotheticalMinScore: number | null; minSamples: number; caveat: string };
  bestByHitRate: { hypotheticalMinScore: number | null; minSamples: number; caveat: string };
}

export interface PaperScoreMonotonicity {
  bandOrderCorrelationWithMeanPnl: number | null;
  highBandMeanPnlVsLowBandMeanPnl: number | null;
  interpretation: string;
}

export interface PaperScoreAlignmentReport {
  generatedAt: string;
  lookbackDays: number;
  primaryTrainingLabel: string;
  assumptions: string[];
  byScoreBand: PaperBandAggregate[];
  monotonicity: PaperScoreMonotonicity;
  thresholdStudy: PaperThresholdStudy;
  totals: {
    paperTradesInWindow: number;
    openInWindow: number;
    closedInWindow: number;
    withOpenAttributionJson: number;
  };
}

function parseNum(s: string | null | undefined): number | null {
  if (s == null || s === "") return null;
  const n = parseFloat(String(s).trim());
  return Number.isFinite(n) ? n : null;
}

function parseRecommendationId(metadataJson: string | null): string | null {
  if (!metadataJson) return null;
  try {
    const o = JSON.parse(metadataJson) as Record<string, unknown>;
    const id = o.recommendationId;
    return typeof id === "string" ? id : null;
  } catch {
    return null;
  }
}

export type AlignmentTradeRow = {
  id: string;
  status: string;
  score: number;
  assetId: string;
  side: string;
  metadataJson: string | null;
  markout12h: string | null;
  pnlPct: string | null;
  threshold: number;
  entryTime: Date;
};

export type AlignmentLabeledRow = AlignmentTradeRow & { label12h: boolean | null };

function mean(nums: number[]): number | null {
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Aggregate closed (+ optional open counts) by score band. Exported for tests. */
export function aggregatePaperScoreBands(args: {
  openRows: AlignmentTradeRow[];
  closedLabeledRows: AlignmentLabeledRow[];
}): PaperBandAggregate[] {
  const openByBand: Record<PaperScoreBand, number> = { low: 0, medium: 0, high: 0 };
  for (const r of args.openRows) {
    const b = resolveScoreBandForPaperTrade(r.score, r.metadataJson);
    openByBand[b]++;
  }

  const closedByBand: Record<PaperScoreBand, AlignmentLabeledRow[]> = { low: [], medium: [], high: [] };
  for (const r of args.closedLabeledRows) {
    const b = resolveScoreBandForPaperTrade(r.score, r.metadataJson);
    closedByBand[b].push(r);
  }

  return BANDS.map((scoreBand) => {
    const closed = closedByBand[scoreBand];
    const pnls = closed.map((r) => parseNum(r.pnlPct)).filter((v): v is number => v != null);
    const markouts = closed.map((r) => parseNum(r.markout12h)).filter((v): v is number => v != null);
    const labeled = closed.filter((r) => r.label12h !== null);
    const positives = labeled.filter((r) => r.label12h === true);

    const spreads: number[] = [];
    const slips: number[] = [];
    for (const r of closed) {
      const a = parseOpenAttributionFromMetadataJson(r.metadataJson);
      const sp = a?.executionContext.spreadBps;
      const sl = a?.executionContext.estimatedSlippageBps;
      if (sp != null && Number.isFinite(sp)) spreads.push(sp);
      if (sl != null && Number.isFinite(sl)) slips.push(sl);
    }

    return {
      scoreBand,
      openCount: openByBand[scoreBand],
      closedCount: closed.length,
      labeledCount: labeled.length,
      labelPositiveRate: labeled.length ? positives.length / labeled.length : null,
      meanPnlPct: mean(pnls),
      medianPnlPct: median(pnls),
      hitRatePnl: pnls.length ? pnls.filter((x) => x > 0).length / pnls.length : null,
      meanMarkout12h: mean(markouts.length ? markouts : pnls),
      meanSpreadBps: mean(spreads),
      meanSlippageBps: mean(slips),
      spreadSamples: spreads.length,
      slippageSamples: slips.length,
    };
  });
}

function spearman(xs: number[], ys: number[]): number | null {
  if (xs.length !== ys.length || xs.length < 2) return null;
  const rank = (arr: number[]) => {
    const idx = arr.map((_, i) => i).sort((i, j) => arr[i]! - arr[j]!);
    const r = new Array(arr.length).fill(0);
    let p = 0;
    while (p < arr.length) {
      let q = p;
      while (q + 1 < arr.length && arr[idx[q + 1]!] === arr[idx[p]!]) q++;
      const avgRank = (p + q + 2) / 2;
      for (let k = p; k <= q; k++) r[idx[k]!] = avgRank;
      p = q + 1;
    }
    return r;
  };
  const rx = rank(xs);
  const ry = rank(ys);
  const mx = rx.reduce((a, b) => a + b, 0) / rx.length;
  const my = ry.reduce((a, b) => a + b, 0) / ry.length;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < xs.length; i++) {
    const vx = rx[i]! - mx;
    const vy = ry[i]! - my;
    num += vx * vy;
    dx += vx * vx;
    dy += vy * vy;
  }
  const den = Math.sqrt(dx * dy);
  return den > 0 ? num / den : null;
}

export function scoreMonotonicityFromBands(byScoreBand: PaperBandAggregate[]): PaperScoreMonotonicity {
  const order: Record<PaperScoreBand, number> = { low: 1, medium: 2, high: 3 };
  const valid = byScoreBand.filter((b) => b.meanPnlPct != null && b.closedCount > 0);
  if (valid.length < 2) {
    return {
      bandOrderCorrelationWithMeanPnl: null,
      highBandMeanPnlVsLowBandMeanPnl: null,
      interpretation: "Insufficient closed samples per band to assess monotonicity.",
    };
  }
  const xs2 = valid.map((b) => order[b.scoreBand]);
  const ys2 = valid.map((b) => b.meanPnlPct!);
  const rho = spearman(xs2, ys2);
  const low = byScoreBand.find((b) => b.scoreBand === "low")?.meanPnlPct;
  const high = byScoreBand.find((b) => b.scoreBand === "high")?.meanPnlPct;
  const diff =
    low != null && high != null && Number.isFinite(low) && Number.isFinite(high) ? high - low : null;
  let interpretation = "Compare high vs low band mean PnL and Spearman ρ (band order vs mean PnL).";
  if (rho != null && rho > 0.3) interpretation = "Higher score bands associate with higher mean paper PnL in this window (ρ > 0.3).";
  else if (rho != null && rho < -0.3) interpretation = "Higher score bands associate with lower mean paper PnL in this window (ρ < -0.3).";
  else interpretation = "Weak or mixed relationship between band order and mean paper PnL in this window.";
  return {
    bandOrderCorrelationWithMeanPnl: rho,
    highBandMeanPnlVsLowBandMeanPnl: diff,
    interpretation,
  };
}

export function computeThresholdGrid(
  closedLabeled: AlignmentLabeledRow[],
  grid: number[],
  minSamplesForBest: number
): {
  slices: PaperThresholdSlice[];
  bestByMeanPnl: PaperThresholdStudy["bestByMeanPnl"];
  bestByHitRate: PaperThresholdStudy["bestByHitRate"];
} {
  const slices: PaperThresholdSlice[] = [];
  for (const t of grid) {
    const subset = closedLabeled.filter((r) => r.score >= t);
    const pnls = subset.map((r) => parseNum(r.pnlPct)).filter((v): v is number => v != null);
    const labeled = subset.filter((r) => r.label12h !== null);
    const pos = labeled.filter((r) => r.label12h === true);
    slices.push({
      hypotheticalMinScore: t,
      closedTradeCountWithScoreGte: subset.length,
      meanPnlPct: mean(pnls),
      hitRatePnl: pnls.length ? pnls.filter((x) => x > 0).length / pnls.length : null,
      labeledCount: labeled.length,
      labelPositiveRate: labeled.length ? pos.length / labeled.length : null,
    });
  }

  let bestPnlT: number | null = null;
  let bestPnlVal = -Infinity;
  for (const s of slices) {
    if (s.closedTradeCountWithScoreGte >= minSamplesForBest && s.meanPnlPct != null && s.meanPnlPct > bestPnlVal) {
      bestPnlVal = s.meanPnlPct;
      bestPnlT = s.hypotheticalMinScore;
    }
  }

  let bestHitT: number | null = null;
  let bestHitVal = -Infinity;
  for (const s of slices) {
    if (
      s.closedTradeCountWithScoreGte >= minSamplesForBest &&
      s.hitRatePnl != null &&
      s.hitRatePnl > bestHitVal
    ) {
      bestHitVal = s.hitRatePnl;
      bestHitT = s.hypotheticalMinScore;
    }
  }

  return {
    slices,
    bestByMeanPnl: {
      hypotheticalMinScore: bestPnlT,
      minSamples: minSamplesForBest,
      caveat: "Report-only counterfactual on observed closes; does not include trades never opened. Not applied automatically.",
    },
    bestByHitRate: {
      hypotheticalMinScore: bestHitT,
      minSamples: minSamplesForBest,
      caveat: "Report-only; subset is trades that actually opened. Not applied automatically.",
    },
  };
}

export async function runPaperScoreAlignmentReport(options: {
  lookbackDays?: number;
  thresholdGridStep?: number;
  minSamplesForThresholdBest?: number;
}): Promise<PaperScoreAlignmentReport> {
  const lookbackDays = options.lookbackDays ?? 90;
  const thresholdGridStep = options.thresholdGridStep ?? 0.025;
  const minSamplesForThresholdBest = options.minSamplesForThresholdBest ?? 8;
  const from = new Date();
  from.setDate(from.getDate() - lookbackDays);

  const assumptions = [
    "Paper-only analytics: no changes to admission, live trading, or ACTIVE/APPROVED gates.",
    "Effective default min score includes `PAPER_TRADING_MIN_SCORE_OVERRIDE` when set (paper-only floor; not applied to live).",
    "Score bands use openAttribution.scoreBand when present, else cutoffs 0.4 / 0.6 on PaperTrade.score (same as shadow score-live).",
    "Realized PnL proxy: PaperTrade.pnlPct / markout12h at 12h close.",
    `Training label proxy: MlShadowTrainingExample.${PRIMARY_LABEL} joined via metadata.recommendationId + assetId + side; null = unlabeled.`,
    "Threshold grid is counterfactual on closed trades only (survivorship: all rows were admitted under historical gates).",
  ];

  const trades = await prisma.paperTrade.findMany({
    where: { entryTime: { gte: from } },
    select: {
      id: true,
      status: true,
      score: true,
      assetId: true,
      side: true,
      metadataJson: true,
      markout12h: true,
      pnlPct: true,
      threshold: true,
      entryTime: true,
    },
  });

  const shadowExamples = await prisma.mlShadowTrainingExample.findMany({
    where: {},
    select: {
      recommendationId: true,
      assetId: true,
      side: true,
      labelGoodDecision12h: true,
      updatedAt: true,
    },
    orderBy: { updatedAt: "desc" },
  });

  const labelByKey = new Map<string, boolean>();
  for (const row of shadowExamples) {
    const recId = row.recommendationId ?? "";
    const key = `${recId}|${row.assetId}|${row.side}`;
    if (labelByKey.has(key)) continue;
    if (row.labelGoodDecision12h === null) continue;
    labelByKey.set(key, row.labelGoodDecision12h);
  }

  const labeledRows: AlignmentLabeledRow[] = trades.map((t) => {
    const recId = parseRecommendationId(t.metadataJson);
    const key = recId != null ? `${recId}|${t.assetId}|${t.side}` : null;
    const label12h = key != null && labelByKey.has(key) ? labelByKey.get(key)! : null;
    return {
      id: t.id,
      status: t.status,
      score: t.score,
      assetId: t.assetId,
      side: t.side,
      metadataJson: t.metadataJson,
      markout12h: t.markout12h,
      pnlPct: t.pnlPct,
      threshold: t.threshold,
      entryTime: t.entryTime,
      label12h,
    };
  });

  const openRows = labeledRows.filter((r) => r.status === "open");
  const closedLabeledRows = labeledRows.filter((r) => r.status === "closed");

  const withAttr = labeledRows.filter((r) => parseOpenAttributionFromMetadataJson(r.metadataJson) != null);

  const byScoreBand = aggregatePaperScoreBands({ openRows, closedLabeledRows });
  const monotonicity = scoreMonotonicityFromBands(byScoreBand);

  const cfg = getPaperTradingConfig();
  const effectiveMinScoreDefault = effectivePaperMinScoreFromConfig(cfg);

  let lastTickAboveThresholdCount: number | null = null;
  let lastTickCandidatesScored: number | null = null;
  let lastTickAt: string | null = null;
  try {
    const st = await prisma.paperTradingState.findUnique({ where: { id: "default" } });
    if (st?.lastOpenTickResultJson) {
      const j = JSON.parse(st.lastOpenTickResultJson) as Record<string, unknown>;
      lastTickAboveThresholdCount = typeof j.aboveThresholdCount === "number" ? j.aboveThresholdCount : null;
      lastTickCandidatesScored = typeof j.candidatesScored === "number" ? j.candidatesScored : null;
      lastTickAt = typeof j.lastScoringTime === "string" ? j.lastScoringTime : null;
    }
  } catch {
    /* ignore */
  }

  const closedScores = closedLabeledRows.map((r) => r.score).filter((s) => Number.isFinite(s));
  const med = median(closedScores);

  const atOrAbove = closedLabeledRows.filter((r) => med != null && r.score >= med);
  const below = closedLabeledRows.filter((r) => med != null && r.score < med);
  const pnlAt = atOrAbove.map((r) => parseNum(r.pnlPct)).filter((v): v is number => v != null);
  const pnlBelow = below.map((r) => parseNum(r.pnlPct)).filter((v): v is number => v != null);

  const aboveEff = closedLabeledRows.filter((r) => r.score >= effectiveMinScoreDefault);
  const belowEff = closedLabeledRows.filter((r) => r.score < effectiveMinScoreDefault);
  const pnlAboveEff = aboveEff.map((r) => parseNum(r.pnlPct)).filter((v): v is number => v != null);
  const pnlBelowEff = belowEff.map((r) => parseNum(r.pnlPct)).filter((v): v is number => v != null);

  const grid: number[] = [];
  for (let t = 0.15; t <= 0.85 + 1e-9; t += thresholdGridStep) {
    grid.push(Math.round(t * 1000) / 1000);
  }
  const { slices, bestByMeanPnl, bestByHitRate } = computeThresholdGrid(
    closedLabeledRows,
    grid,
    minSamplesForThresholdBest
  );

  const thresholdStudy: PaperThresholdStudy = {
    note:
      "aboveThresholdCount / candidatesScored reflect the last persisted paper open tick only. Threshold grid is hypothetical on closed trades in the lookback window.",
    configThreshold: cfg.threshold,
    configMinScoreBuffer: cfg.minScoreBuffer,
    effectiveMinScoreDefault,
    outcomesAboveVsBelowEffectiveMin: {
      aboveOrEqual: {
        count: aboveEff.length,
        meanPnlPct: mean(pnlAboveEff),
        hitRatePnl: pnlAboveEff.length ? pnlAboveEff.filter((x) => x > 0).length / pnlAboveEff.length : null,
      },
      below: {
        count: belowEff.length,
        meanPnlPct: mean(pnlBelowEff),
        hitRatePnl: pnlBelowEff.length ? pnlBelowEff.filter((x) => x > 0).length / pnlBelowEff.length : null,
      },
    },
    lastTickAboveThresholdCount,
    lastTickCandidatesScored,
    lastTickAt,
    medianSplit: {
      medianScore: med,
      atOrAboveMedian: {
        count: atOrAbove.length,
        meanPnlPct: mean(pnlAt),
        hitRatePnl: pnlAt.length ? pnlAt.filter((x) => x > 0).length / pnlAt.length : null,
      },
      belowMedian: {
        count: below.length,
        meanPnlPct: mean(pnlBelow),
        hitRatePnl: pnlBelow.length ? pnlBelow.filter((x) => x > 0).length / pnlBelow.length : null,
      },
    },
    thresholdGrid: slices,
    bestByMeanPnl,
    bestByHitRate,
  };

  return {
    generatedAt: new Date().toISOString(),
    lookbackDays,
    primaryTrainingLabel: PRIMARY_LABEL,
    assumptions,
    byScoreBand,
    monotonicity,
    thresholdStudy,
    totals: {
      paperTradesInWindow: labeledRows.length,
      openInWindow: openRows.length,
      closedInWindow: closedLabeledRows.length,
      withOpenAttributionJson: withAttr.length,
    },
  };
}
