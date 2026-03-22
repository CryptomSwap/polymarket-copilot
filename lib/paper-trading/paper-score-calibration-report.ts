/**
 * Read-only diagnostics for shadow logistic saturation + paper logit-temperature calibration.
 * Writes dump/paper-score-calibration-report.{json,md} via tools/create-paper-score-calibration-report.ts
 */

import { prisma } from "@/lib/db";
import { getPaperTradingConfig } from "@/lib/paper-trading/config";
import { effectivePaperMinScoreFromConfig } from "@/lib/paper-trading/paper-roi-admission";
import { applyPaperShadowLogitTemperature } from "@/lib/paper-trading/paper-shadow-logit-calibration";
import { parseOpenAttributionFromMetadataJson } from "@/lib/paper-trading/paper-trade-open-attribution";

const PIPELINE_AUDIT = [
  "**Inference path:** `toShadowFeatureVector` â†’ `logisticLinearTerm` (z = intercept + Î£ coef_j Ã— normalized_j) â†’ `sigmoid(z)` with z clipped to [-20, 20] in `lib/ml/baseline.ts`.",
  "**Normalization:** Each feature uses training `means`/`stds` from `metricsJson` (same as training in `trainLogisticRegression`).",
  "**Saturation:** If |z| â‰« 0, sigmoid(z) â‰ˆ 0 or 1. Coefficient scale + feature scale after standardization can still yield large |z| on live candidates (distribution shift or dominant features).",
  "**Paper calibration:** Optional `sigmoid(logit(p)/T)` via `PAPER_SHADOW_LOGIT_TEMPERATURE` (T>1 spreads probabilities toward 0.5). Not Platt/isotonic calibrationâ€”diagnostic + mild de-saturation only.",
].join("\n\n");

export interface ScoreBatchStats {
  n: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  stdev: number | null;
  p50: number | null;
  p90: number | null;
  countGte095: number;
  countGte09: number;
}

export interface PaperScoreCalibrationReport {
  generatedAt: string;
  lookbackDays: number;
  pipelineAudit: string;
  dominantIssueHypothesis: string;
  configEcho: {
    paperShadowLogitTemperature: number;
    paperShadowUseCalibratedScoreForPaper: boolean;
    effectiveMinScoreWithOverride: number;
  };
  logitFromMetadata: {
    note: string;
    n: number;
    stats: ScoreBatchStats;
  };
  rawFromPaperTradeColumn: ScoreBatchStats;
  counterfactualCalibrated: {
    note: string;
    temperature: number;
    stats: ScoreBatchStats;
  };
  rankingSeparation: {
    rawStdev: number | null;
    calibratedStdev: number | null;
    ratioCalibratedOverRaw: number | null;
    interpretation: string;
  };
  thresholdSelectivity: {
    hypotheticalMinScore: number;
    fractionRawGte: number | null;
    fractionCalibratedGte: number | null;
    note: string;
  };
  recommendedNextSteps: string[];
  recommendedPaperThresholdAfterCalibration: {
    suggestedMinScore: number | null;
    rationale: string;
    caveat: string;
  };
}

function mean(nums: number[]): number | null {
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function stdev(nums: number[]): number | null {
  if (nums.length < 2) return null;
  const m = mean(nums);
  if (m == null) return null;
  const v = nums.reduce((s, x) => s + (x - m) * (x - m), 0) / (nums.length - 1);
  return Math.sqrt(v);
}

function quantileSorted(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

export function summarizeScores(values: number[]): ScoreBatchStats {
  const nums = values.filter((x) => Number.isFinite(x));
  const sorted = [...nums].sort((a, b) => a - b);
  return {
    n: nums.length,
    min: nums.length ? sorted[0]! : null,
    max: nums.length ? sorted[sorted.length - 1]! : null,
    mean: mean(nums),
    stdev: stdev(nums),
    p50: quantileSorted(sorted, 0.5),
    p90: quantileSorted(sorted, 0.9),
    countGte095: nums.filter((x) => x >= 0.95).length,
    countGte09: nums.filter((x) => x >= 0.9).length,
  };
}

function dominantIssueFromStats(raw: ScoreBatchStats, logitN: number): string {
  if (raw.n === 0) {
    return "No paper trades in window â€” cannot assess saturation from DB.";
  }
  if (raw.p90 != null && raw.p90 > 0.999 && raw.stdev != null && raw.stdev < 0.001) {
    return "Dominant pattern: raw probabilities are extremely tight near 1.0 with tiny cross-sample variance â€” consistent with logistic saturation (large positive linear scores z) and/or insufficient calibration layer; rank-based admission would require within-tick or historical rank, not implemented in this report.";
  }
  if (logitN >= 10 && raw.countGte095 / raw.n > 0.9) {
    return "Most samples â‰¥0.95 raw; logit metadata available for a subset â€” inspect logit distribution in JSON for |z| magnitude.";
  }
  return "Mixed or moderate spread; raw logistic may still be usable. Use stdev and p90 to decide if temperature helps.";
}

/** Suggested min score so roughly `targetUpperPassRate` of calibrated scores would pass (order statistics). */
export function suggestMinScoreFromCalibratedDistribution(
  calibrated: number[],
  targetUpperPassRate = 0.35
): number | null {
  const nums = calibrated.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (nums.length < 8) return null;
  const rate = Math.min(0.95, Math.max(0.05, targetUpperPassRate));
  const idx = Math.floor((1 - rate) * (nums.length - 1));
  return nums[Math.max(0, idx)]!;
}

export async function runPaperScoreCalibrationReport(options: {
  lookbackDays?: number;
  hypotheticalMinScore?: number;
}): Promise<PaperScoreCalibrationReport> {
  const lookbackDays = options.lookbackDays ?? 30;
  const hypotheticalMinScore = options.hypotheticalMinScore ?? 0.95;
  const from = new Date();
  from.setDate(from.getDate() - lookbackDays);

  const cfg = getPaperTradingConfig();
  const T = cfg.paperShadowLogitTemperature;
  const effectiveMin = effectivePaperMinScoreFromConfig(cfg);

  const trades = await prisma.paperTrade.findMany({
    where: { entryTime: { gte: from } },
    select: { score: true, metadataJson: true },
  });

  const raws = trades.map((t) => Number(t.score)).filter((x) => Number.isFinite(x));
  const rawStats = summarizeScores(raws);

  const calibratedCounterfactual = raws.map((p) => applyPaperShadowLogitTemperature(p, T));
  const calStats = summarizeScores(calibratedCounterfactual);

  const logits: number[] = [];
  for (const t of trades) {
    const a = parseOpenAttributionFromMetadataJson(t.metadataJson);
    const z = a?.paperShadowScoreCalibration?.shadowMlLogit;
    if (z != null && Number.isFinite(z)) logits.push(z);
  }
  const logitStats = summarizeScores(logits);

  const rawSd = rawStats.stdev;
  const calSd = calStats.stdev;
  let ratio: number | null =
    rawSd != null && calSd != null && rawSd > 1e-12 ? calSd / rawSd : null;

  let separationInterp = "Compare calibrated vs raw stdev; ratio > 1 means more spread after temperature.";
  if (rawSd != null && rawSd <= 1e-12 && calSd != null && calSd > 1e-12) {
    separationInterp =
      "Raw stdev is ~0 (saturated flat scores); calibrated stdev > 0 implies temperature introduces measurable spread for ranking.";
    ratio = null;
  } else if (ratio != null && ratio > 1.2) {
    separationInterp = "Calibrated distribution is materially wider (better ranking separation in probability space).";
  } else if (ratio != null && ratio < 1.05 && ratio >= 0) {
    separationInterp =
      "Temperature has little effect on spread â€” try larger T or investigate logit scale (metadata logits).";
  }

  const rawGteHyp = raws.filter((x) => x >= hypotheticalMinScore).length;
  const calGteHyp = calibratedCounterfactual.filter((x) => x >= hypotheticalMinScore).length;
  const fracRaw = rawStats.n > 0 ? rawGteHyp / rawStats.n : null;
  const fracCal = rawStats.n > 0 ? calGteHyp / rawStats.n : null;

  const suggested = suggestMinScoreFromCalibratedDistribution(calibratedCounterfactual, 0.35);

  const recommendedPaperThresholdAfterCalibration = {
    suggestedMinScore: suggested,
    rationale:
      suggested != null
        ? `Order-statistic target: ~35% of window trades would meet or exceed this value on counterfactual calibrated scores (T=${T}). Tune PAPER_TRADING_MIN_SCORE_OVERRIDE to taste.`
        : "Insufficient samples for automatic suggestion; use raw/calibrated histograms manually.",
    caveat:
      "Suggestion is descriptive on historical opens only; it does not include candidates that never opened. Not applied automatically.",
  };

  return {
    generatedAt: new Date().toISOString(),
    lookbackDays,
    pipelineAudit: PIPELINE_AUDIT,
    dominantIssueHypothesis: dominantIssueFromStats(rawStats, logits.length),
    configEcho: {
      paperShadowLogitTemperature: T,
      paperShadowUseCalibratedScoreForPaper: cfg.paperShadowUseCalibratedScoreForPaper,
      effectiveMinScoreWithOverride: effectiveMin,
    },
    logitFromMetadata: {
      note: "Logits parsed from openAttribution.paperShadowScoreCalibration when present (newer rows only).",
      n: logits.length,
      stats: logitStats,
    },
    rawFromPaperTradeColumn: rawStats,
    counterfactualCalibrated: {
      note: `Each PaperTrade.score (raw) re-mapped with applyPaperShadowLogitTemperature(p, ${T}).`,
      temperature: T,
      stats: calStats,
    },
    rankingSeparation: {
      rawStdev: rawSd,
      calibratedStdev: calSd,
      ratioCalibratedOverRaw: ratio,
      interpretation: separationInterp,
    },
    thresholdSelectivity: {
      hypotheticalMinScore,
      fractionRawGte: fracRaw,
      fractionCalibratedGte: fracCal,
      note: `Fraction of window rows with score â‰¥ ${hypotheticalMinScore} (raw uses DB column; calibrated uses counterfactual T).`,
    },
    recommendedNextSteps: [
      "If saturated: raise PAPER_SHADOW_LOGIT_TEMPERATURE (e.g. 3â€“8) and set PAPER_SHADOW_USE_CALIBRATED_SCORE_FOR_PAPER=1, then lower PAPER_TRADING_MIN_SCORE_OVERRIDE toward the suggested band.",
      "For proper calibration: fit Platt or isotonic on a labeled holdout and persist parameters (future workâ€”not in this temperature-only path).",
      "Inspect logit stats when metadata exists; very large mean logit confirms raw logistic saturation rather than a parsing bug.",
    ],
    recommendedPaperThresholdAfterCalibration,
  };
}
