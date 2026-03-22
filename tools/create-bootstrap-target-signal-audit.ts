/**
 * Bootstrap target + feature signal audit for labelGoodDecision12h (report-only).
 * No training persistence, no threshold/activation changes.
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import { toShadowFeatureVector, SHADOW_FEATURE_NAMES } from "../lib/ml/shadow-train/features";
import {
  trainLogisticRegression,
  predictBatchLogistic,
} from "../lib/ml/baseline";
import { computeMetrics } from "../lib/ml/evaluate";
import {
  computeActiveFeatureIndices,
  balancedClassWeights,
} from "../lib/ml/shadow-train/train";

const DUMP_DIR = path.join(process.cwd(), "dump");
const JSON_PATH = path.join(DUMP_DIR, "bootstrap-target-signal-audit.json");
const MD_PATH = path.join(DUMP_DIR, "bootstrap-target-signal-audit.md");

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function pearsonCorr(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 2) return 0;
  const mx = mean(x);
  const my = mean(y);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const vx = x[i] - mx;
    const vy = y[i] - my;
    num += vx * vy;
    dx += vx * vx;
    dy += vy * vy;
  }
  const den = Math.sqrt(dx * dy);
  return den > 1e-14 ? num / den : 0;
}

/** Average precision (binary), positive class y=1, higher score = more positive. */
function averagePrecision(scores: number[], y: number[]): number {
  const P = y.filter((v) => v === 1).length;
  if (P === 0) return 0;
  const order = Array.from({ length: scores.length }, (_, i) => i).sort(
    (a, b) => (scores[b] ?? 0) - (scores[a] ?? 0)
  );
  let tpSeen = 0;
  let sumPrecAtPos = 0;
  for (let k = 0; k < order.length; k++) {
    const i = order[k];
    if (y[i] === 1) {
      tpSeen++;
      sumPrecAtPos += tpSeen / (k + 1);
    }
  }
  return sumPrecAtPos / P;
}

function prCurveSamples(scores: number[], y: number[], numPoints: number): Array<{ recall: number; precision: number }> {
  const P = y.filter((v) => v === 1).length;
  const N = y.length - P;
  if (P === 0 || N === 0) return [];
  const order = Array.from({ length: scores.length }, (_, i) => i).sort(
    (a, b) => (scores[b] ?? 0) - (scores[a] ?? 0)
  );
  const out: Array<{ recall: number; precision: number }> = [];
  let tp = 0;
  let fp = 0;
  for (let step = 1; step <= numPoints; step++) {
    const k = Math.min(order.length, Math.ceil((step / numPoints) * order.length));
    tp = 0;
    fp = 0;
    for (let j = 0; j < k; j++) {
      if (y[order[j]] === 1) tp++;
      else fp++;
    }
    const prec = tp + fp > 0 ? tp / (tp + fp) : 0;
    const rec = tp / P;
    out.push({ recall: rec, precision: prec });
  }
  return out;
}

function bestF1Threshold(scores: number[], y: number[]): { threshold: number; f1: number; tp: number; fp: number; tn: number; fn: number } {
  let best = { threshold: 0.5, f1: 0, tp: 0, fp: 0, tn: 0, fn: 0 };
  for (let t = 1; t < 100; t++) {
    const th = t / 100;
    const m = computeMetrics(scores, y, th);
    if (m.f1 > best.f1) {
      best = { threshold: th, f1: m.f1, tp: m.tp, fp: m.fp, tn: m.tn, fn: m.fn };
    }
  }
  return best;
}

function toInput(r: {
  policyState: string | null;
  sizeMultiplier: string | null;
  finalSuggestedSize: string | null;
  eligibilityBlockersCount: number;
  reducedSizeIndicator: boolean;
  blockedIndicator: boolean;
  executionAllow: boolean | null;
  executionWarningCount: number;
  qualityState: string | null;
  spreadBps: string | null;
  estimatedSlippage: string | null;
  tradable: boolean | null;
  grossExposure: string | null;
  totalOpenExposure: string | null;
  maxSingleMarketConcentrationPct: string | null;
  maxSingleThemeConcentrationPct: string | null;
  portfolioRiskFlagsCount: number;
  runtimeWarningCount: number;
  runtimeBlockingCount: number;
  intendedPrice: string;
  intendedSize: string;
  recommendationPresent: boolean;
  side: string;
  outcomeBlockedVsAllowedVsSubmitted: string | null;
  momentum1hBps: string | null;
  momentum6hBps: string | null;
  volatility1hBps: string | null;
  volatility6hBps: string | null;
  distanceFromMid: string | null;
  timeToCloseHours: string | null;
  liquidityTrend: string | null;
}) {
  return {
    policyState: r.policyState,
    sizeMultiplier: r.sizeMultiplier,
    finalSuggestedSize: r.finalSuggestedSize,
    eligibilityBlockersCount: r.eligibilityBlockersCount,
    reducedSizeIndicator: r.reducedSizeIndicator,
    blockedIndicator: r.blockedIndicator,
    executionAllow: r.executionAllow,
    executionWarningCount: r.executionWarningCount,
    qualityState: r.qualityState,
    spreadBps: r.spreadBps,
    estimatedSlippage: r.estimatedSlippage,
    tradable: r.tradable,
    grossExposure: r.grossExposure,
    totalOpenExposure: r.totalOpenExposure,
    maxSingleMarketConcentrationPct: r.maxSingleMarketConcentrationPct,
    maxSingleThemeConcentrationPct: r.maxSingleThemeConcentrationPct,
    portfolioRiskFlagsCount: r.portfolioRiskFlagsCount,
    runtimeWarningCount: r.runtimeWarningCount,
    runtimeBlockingCount: r.runtimeBlockingCount,
    intendedPrice: r.intendedPrice,
    intendedSize: r.intendedSize,
    recommendationPresent: r.recommendationPresent,
    side: r.side,
    outcomeBlockedVsAllowedVsSubmitted: r.outcomeBlockedVsAllowedVsSubmitted as
      | "blocked"
      | "allowed"
      | "submitted"
      | null,
    momentum1hBps: r.momentum1hBps,
    momentum6hBps: r.momentum6hBps,
    volatility1hBps: r.volatility1hBps,
    volatility6hBps: r.volatility6hBps,
    distanceFromMid: r.distanceFromMid,
    timeToCloseHours: r.timeToCloseHours,
    liquidityTrend: r.liquidityTrend,
  };
}

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });
  const generatedAt = new Date().toISOString();
  const limit = Math.min(
    50_000,
    Math.max(500, parseInt(process.env.BOOTSTRAP_SIGNAL_AUDIT_LIMIT ?? "5000", 10) || 5000)
  );
  const trainRatio = 0.8;

  try {
    const total12hLabeled = await prisma.mlShadowTrainingExample.count({
      where: { labelGoodDecision12h: { not: null } },
    });
    const total6hLabeled = await prisma.mlShadowTrainingExample.count({
      where: { labelGoodDecision6h: { not: null } },
    });

    const rows = await prisma.mlShadowTrainingExample.findMany({
      where: { labelGoodDecision12h: { not: null } },
      orderBy: { createdAt: "asc" },
      take: limit,
      select: {
        createdAt: true,
        labelGoodDecision12h: true,
        labelGoodDecision6h: true,
        wasBlocked: true,
        blockedIndicator: true,
        outcomeBlockedVsAllowedVsSubmitted: true,
        markout12h: true,
        policyState: true,
        sizeMultiplier: true,
        finalSuggestedSize: true,
        eligibilityBlockersCount: true,
        reducedSizeIndicator: true,
        executionAllow: true,
        executionWarningCount: true,
        qualityState: true,
        spreadBps: true,
        estimatedSlippage: true,
        tradable: true,
        grossExposure: true,
        totalOpenExposure: true,
        maxSingleMarketConcentrationPct: true,
        maxSingleThemeConcentrationPct: true,
        portfolioRiskFlagsCount: true,
        runtimeWarningCount: true,
        runtimeBlockingCount: true,
        intendedPrice: true,
        intendedSize: true,
        recommendationPresent: true,
        side: true,
        outcomeBlockedVsAllowedVsSubmitted: true,
        momentum1hBps: true,
        momentum6hBps: true,
        volatility1hBps: true,
        volatility6hBps: true,
        distanceFromMid: true,
        timeToCloseHours: true,
        liquidityTrend: true,
      },
    });

    const valid = rows.filter((r) => r.labelGoodDecision12h === true || r.labelGoodDecision12h === false);
    const splitIdx = Math.max(1, Math.floor(valid.length * trainRatio));
    const trainRows = valid.slice(0, splitIdx);
    const valRows = valid.slice(splitIdx);

    const yTrain = trainRows.map((r) => (r.labelGoodDecision12h ? 1 : 0));
    const yVal = valRows.map((r) => (r.labelGoodDecision12h ? 1 : 0));
    const XTrain = trainRows.map((r) => toShadowFeatureVector(toInput(r as Parameters<typeof toInput>[0])));
    const XVal = valRows.map((r) => toShadowFeatureVector(toInput(r as Parameters<typeof toInput>[0])));

    const posRateTrain = yTrain.length ? yTrain.filter((y) => y === 1).length / yTrain.length : 0;
    const posRateVal = yVal.length ? yVal.filter((y) => y === 1).length / yVal.length : 0;

    const activeIdx = computeActiveFeatureIndices(XTrain, 1e-8);
    const constantIdx = SHADOW_FEATURE_NAMES.map((_, j) => j).filter((j) => !activeIdx.includes(j));

    const yTrainF = yTrain.map((v) => v as number);
    const univariate: Array<{
      name: string;
      idx: number;
      trainVariance: number;
      meanPos: number;
      meanNeg: number;
      meanDiff: number;
      absPearsonWithLabel: number;
    }> = [];
    for (const j of activeIdx) {
      const col = XTrain.map((row) => row[j] ?? 0);
      const n = col.length;
      let sumsq = 0;
      const m = mean(col);
      for (const v of col) sumsq += (v - m) * (v - m);
      const trainVariance = n > 1 ? sumsq / (n - 1) : 0;
      const posVals = col.filter((_, i) => yTrain[i] === 1);
      const negVals = col.filter((_, i) => yTrain[i] === 0);
      const meanPos = mean(posVals);
      const meanNeg = mean(negVals);
      const r = Math.abs(pearsonCorr(col, yTrainF));
      univariate.push({
        name: SHADOW_FEATURE_NAMES[j] ?? `f${j}`,
        idx: j,
        trainVariance,
        meanPos,
        meanNeg,
        meanDiff: meanPos - meanNeg,
        absPearsonWithLabel: r,
      });
    }
    univariate.sort((a, b) => b.absPearsonWithLabel - a.absPearsonWithLabel);

    const model = trainLogisticRegression(XTrain, yTrain, {
      learningRate: 0.1,
      maxIter: 500,
      l2Lambda: 0.01,
      featureIndices: activeIdx.length > 0 ? activeIdx : SHADOW_FEATURE_NAMES.map((_, i) => i),
      sampleWeights: balancedClassWeights(yTrain),
    });
    const valScores = predictBatchLogistic(model, XVal);
    const metrics05 = computeMetrics(valScores, yVal, 0.5);
    const predPositiveRateAt05 = valScores.length
      ? valScores.filter((s) => s >= 0.5).length / valScores.length
      : 0;
    const bestF1 = bestF1Threshold(valScores, yVal);
    const ap = averagePrecision(valScores, yVal);
    const prSamples = prCurveSamples(valScores, yVal, 10);

    const scorePos = valScores.filter((_, i) => yVal[i] === 1);
    const scoreNeg = valScores.filter((_, i) => yVal[i] === 0);

    /** Stratified positive rates (target leakage check vs blocked path). */
    function stratumStats(
      _label: string,
      subset: typeof valid
    ): { n: number; posRate: number; pos: number; neg: number } {
      const y = subset.map((r) => (r.labelGoodDecision12h ? 1 : 0));
      const pos = y.filter((v) => v === 1).length;
      return {
        n: subset.length,
        pos,
        neg: y.length - pos,
        posRate: y.length ? pos / y.length : 0,
      };
    }

    const byBlocked = {
      blocked: stratumStats(
        "blockedIndicator true",
        valid.filter((r) => r.blockedIndicator === true)
      ),
      notBlocked: stratumStats(
        "blockedIndicator false",
        valid.filter((r) => r.blockedIndicator === false)
      ),
    };

    const byOutcome = {
      blocked: stratumStats("outcome blocked", valid.filter((r) => r.outcomeBlockedVsAllowedVsSubmitted === "blocked")),
      allowed: stratumStats("outcome allowed", valid.filter((r) => r.outcomeBlockedVsAllowedVsSubmitted === "allowed")),
      submitted: stratumStats(
        "outcome submitted",
        valid.filter((r) => r.outcomeBlockedVsAllowedVsSubmitted === "submitted")
      ),
      unknown: stratumStats(
        "outcome null/other",
        valid.filter(
          (r) =>
            r.outcomeBlockedVsAllowedVsSubmitted !== "blocked" &&
            r.outcomeBlockedVsAllowedVsSubmitted !== "allowed" &&
            r.outcomeBlockedVsAllowedVsSubmitted !== "submitted"
        )
      ),
    };

    const both6h12h = valid.filter(
      (r) => (r.labelGoodDecision6h === true || r.labelGoodDecision6h === false) && (r.labelGoodDecision12h === true || r.labelGoodDecision12h === false)
    );
    let agree6h12 = 0;
    for (const r of both6h12h) {
      if (Boolean(r.labelGoodDecision6h) === Boolean(r.labelGoodDecision12h)) agree6h12++;
    }
    const agreement6h12h = both6h12h.length ? agree6h12 / both6h12h.length : null;

    const maxAbsUnivar = univariate.length ? Math.max(...univariate.map((u) => u.absPearsonWithLabel)) : 0;
    const maxMeanDiffAbs = univariate.length ? Math.max(...univariate.map((u) => Math.abs(u.meanDiff))) : 0;

    const allPositiveScores = yVal.map(() => 1);
    const f1AlwaysPredictPositive = computeMetrics(allPositiveScores, yVal, 0.5).f1;
    const f1AlwaysPredictNegative = computeMetrics(yVal.map(() => 0), yVal, 0.5).f1;
    /** Low threshold + F1 ≈ "always positive" => not meaningful threshold tuning (matches majority class). */
    const degenerateBestF1 =
      bestF1.threshold <= 0.05 &&
      Math.abs(bestF1.f1 - f1AlwaysPredictPositive) < 0.04 &&
      posRateVal >= 0.55;
    const meaningfulThresholdImprovement =
      !degenerateBestF1 &&
      bestF1.f1 > metrics05.f1 + 0.08 &&
      bestF1.threshold >= 0.08 &&
      bestF1.threshold <= 0.92;

    const diagnosis = {
      primary:
        metrics05.rocAuc < 0.53 || degenerateBestF1
          ? "feature_weakness_dominant"
          : meaningfulThresholdImprovement
            ? "threshold_at_0.5_masks_some_ranking_signal"
            : "target_noise_and_or_weak_features_combined",
      targetVsFeatureEvidence: {
        labelRule:
          "labelGoodDecision12h = deriveGoodDecisionLabelFromMarkout(wasBlocked, markout12h): allowed+>0 / blocked+<=0 => good; symmetric for unfavorable.",
        baseRateTrain: posRateTrain,
        baseRateVal: posRateVal,
        trivialAlwaysPositiveAccuracy: Math.max(posRateTrain, 1 - posRateTrain),
        stratifiedPosRate: { byBlocked, byOutcome },
        agreement6h12hWhenBothLabeled: agreement6h12h,
        rowsWithBoth6hAnd12h: both6h12h.length,
      },
      featureEvidence: {
        constantFeatureCount: constantIdx.length,
        activeFeatureCount: activeIdx.length,
        maxAbsPearsonLabelOnTrain: maxAbsUnivar,
        maxAbsMeanDiffPosVsNeg: maxMeanDiffAbs,
        topFeaturesByAbsCorr: univariate.slice(0, 8),
      },
      thresholdEvidence: {
        metricsAt05: metrics05,
        predictedPositiveRateAt05: predPositiveRateAt05,
        bestF1OnValidation: bestF1,
        degenerateBestF1Suspected: degenerateBestF1,
        degenerateBestF1Explanation: degenerateBestF1
          ? `Best F1 at thr=${bestF1.threshold.toFixed(2)} ≈ always-predict-positive F1=${f1AlwaysPredictPositive.toFixed(4)} (val posRate=${posRateVal.toFixed(3)}); not evidence of ranking, only class imbalance.`
          : null,
        f1MajorityBaselines: {
          alwaysPredictPositive: f1AlwaysPredictPositive,
          alwaysPredictNegative: f1AlwaysPredictNegative,
        },
        averagePrecisionValidation: ap,
        prCurveDeciles: prSamples,
        valScoreMeanPos: scorePos.length ? mean(scorePos) : null,
        valScoreMeanNeg: scoreNeg.length ? mean(scoreNeg) : null,
        valScoreSeparation: scorePos.length && scoreNeg.length ? mean(scorePos) - mean(scoreNeg) : null,
      },
    };

    const rankedNextSteps: Array<{ priority: number; action: string; type: "a" | "b" | "c" | "d"; rationale: string }> = [
      {
        priority: 1,
        type: "b",
        action:
          "Add decision-time features that proxy forward 12h price path (or coarser market regime) — current active features show very weak univariate correlation with label.",
        rationale: `max |Pearson(feature,label)| ≈ ${maxAbsUnivar.toFixed(4)} on train among non-constant columns; AUC≈${metrics05.rocAuc.toFixed(4)}.`,
      },
      {
        priority: 2,
        type: "a",
        action:
          "Consider stratified or separate models / targets for blocked vs allowed/submitted, or a target defined only on one path — mixed semantics inflate label noise.",
        rationale: `Pos rates differ by outcome stratum; label mixes 'good trade' vs 'good block' in one binary.`,
      },
      {
        priority: 3,
        type: "c",
        action:
          "If governance allows later: tune decision threshold using validation PR/F1 — not a substitute for signal; report-only best F1 here for diagnostics.",
        rationale: degenerateBestF1
          ? `Ignore extreme-threshold F1: best thr=${bestF1.threshold.toFixed(2)} matches always-positive baseline (${f1AlwaysPredictPositive.toFixed(4)}); AUC=${metrics05.rocAuc.toFixed(4)}.`
          : `best validation F1=${bestF1.f1.toFixed(4)} at threshold=${bestF1.threshold.toFixed(2)} vs F1@0.5=${metrics05.f1.toFixed(4)}.`,
      },
      {
        priority: 4,
        type: "d",
        action:
          "Only if 6h labels are materially more stable vs features: pilot labelGoodDecision6h bootstrap target (policy unchanged until explicitly switched).",
        rationale: `6h/12h agreement=${agreement6h12h == null ? "n/a" : (agreement6h12h * 100).toFixed(1) + "%"} on rows with both (shorter horizon can be noisier too).`,
      },
    ];

    const recommendedLetter: "a" | "b" | "c" | "d" =
      diagnosis.primary === "feature_weakness_dominant"
        ? "b"
        : diagnosis.primary === "threshold_at_0.5_masks_some_ranking_signal"
          ? "c"
          : "a";

    const report = {
      generatedAt,
      sample: {
        dbTotalLabelGoodDecision12hNonNull: total12hLabeled,
        dbTotalLabelGoodDecision6hNonNull: total6hLabeled,
        limitRequested: limit,
        rowsLoaded: rows.length,
        validBinaryRows: valid.length,
        trainSize: trainRows.length,
        validationSize: valRows.length,
        trainPos: yTrain.filter((y) => y === 1).length,
        trainNeg: yTrain.filter((y) => y === 0).length,
        valPos: yVal.filter((y) => y === 1).length,
        valNeg: yVal.filter((y) => y === 0).length,
      },
      labelDefinition: {
        module: "lib/ml/shadow-dataset/build.ts",
        function: "deriveGoodDecisionLabelFromMarkout",
        semantics: {
          positive_class_y1: "labelGoodDecision12h === true (good decision under 12h markout rule)",
          negative_class_y0: "labelGoodDecision12h === false",
          blockedPath:
            "favorable markout (>0) => label false (missed opportunity); unfavorable (<=0) => label true (good block).",
          allowedOrSubmittedPath: "favorable markout => true; unfavorable => false.",
        },
        note: "Features are pre-trade snapshots; 12h markout is post-trade path — high base rate does not imply learnable linear boundary in this feature space.",
      },
      diagnosis: {
        exactDiagnosis: `${diagnosis.primary}: ${
          diagnosis.primary === "feature_weakness_dominant"
            ? "pre-trade features have near-zero marginal association with 12h markout-derived label; ranking ~random (AUC~0.5)."
            : diagnosis.primary === "threshold_at_0.5_masks_some_ranking_signal"
              ? "scores carry weak but non-trivial ordering; default 0.5 is suboptimal for F1 though overall signal remains limited."
              : "single binary mixes block-quality and trade-quality semantics; combined with weak features yields unlearnable boundary at current capacity."
        }`,
        targetNoiseVsFeatureVsThresholding: {
          targetNoise: "Mixed blocked/allowed semantics and markout-driven label; check stratified pos rates.",
          featureWeakness: `Low max |corr| with label (${maxAbsUnivar.toFixed(4)}) among active features.`,
          thresholding: degenerateBestF1
            ? `Best F1 at thr=${bestF1.threshold.toFixed(2)} is explained by majority-class predictions (F1≈always-positive=${f1AlwaysPredictPositive.toFixed(4)}); not a ranking fix. AP=${ap.toFixed(4)} reflects score ordering but AUC≈${metrics05.rocAuc.toFixed(4)} is near random.`
            : bestF1.f1 > metrics05.f1 + 0.05
              ? `Some calibration gain possible (best F1 thr=${bestF1.threshold.toFixed(2)}); AP=${ap.toFixed(4)}.`
              : "Threshold sweep does not rescue F1 materially — ranking is weak.",
        },
        evidence: diagnosis,
      },
      rankedNextSteps,
      recommendedNextStepLetter: recommendedLetter,
      modulesReferenced: [
        "lib/ml/shadow-dataset/build.ts#deriveGoodDecisionLabelFromMarkout",
        "lib/ml/shadow-train/features.ts#toShadowFeatureVector",
        "lib/ml/shadow-train/train.ts#trainShadowModel (mirrored for audit)",
        "lib/ml/evaluate.ts#computeMetrics",
      ],
    };

    await fs.writeFile(JSON_PATH, JSON.stringify(report, null, 2), "utf8");

    const md = `# Bootstrap target + signal audit (labelGoodDecision12h)

Generated: ${generatedAt}

## Sample

- DB totals: labelGoodDecision12h non-null **${total12hLabeled}**, labelGoodDecision6h non-null **${total6hLabeled}**
- Valid rows: **${valid.length}** (limit=${limit}, time split ${(trainRatio * 100).toFixed(0)}% / ${((1 - trainRatio) * 100).toFixed(0)}%)
- Train pos/neg: **${report.sample.trainPos}** / **${report.sample.trainNeg}** (posRate=${posRateTrain.toFixed(4)})
- Val pos/neg: **${report.sample.valPos}** / **${report.sample.valNeg}** (posRate=${posRateVal.toFixed(4)})

## Label definition (exact)

- **Rule:** \`deriveGoodDecisionLabelFromMarkout(wasBlocked, markout12h)\` in \`lib/ml/shadow-dataset/build.ts\`
- **Blocked:** favorable markout (>0) → **bad** (false); unfavorable → **good** (true)
- **Allowed/submitted:** favorable → **good** (true); unfavorable → **bad** (false)

## Diagnosis

**${report.diagnosis.exactDiagnosis}**

### Evidence summary

| Axis | Conclusion |
|------|------------|
| Target / noise | Stratified pos rates: blocked ${byBlocked.blocked.posRate.toFixed(3)} (${byBlocked.blocked.n}), not blocked ${byBlocked.notBlocked.posRate.toFixed(3)} (${byBlocked.notBlocked.n}) |
| Features | Active=${activeIdx.length}, constant=${constantIdx.length}; max \\|Pearson(feature,label)\\| ≈ **${maxAbsUnivar.toFixed(4)}** |
| Threshold @0.5 | F1=${metrics05.f1.toFixed(4)}, predPos@0.5=${predPositiveRateAt05.toFixed(4)} |
| Best F1 thr (val) | F1=${bestF1.f1.toFixed(4)} @ threshold=${bestF1.threshold.toFixed(2)} ${degenerateBestF1 ? "_(degenerate: ≈ always-positive)_" : ""} |
| Always-predict-positive F1 (val) | ${f1AlwaysPredictPositive.toFixed(4)} |
| Average precision (val) | **${ap.toFixed(4)}** |
| 6h vs 12h agreement | ${agreement6h12h == null ? "n/a" : (agreement6h12h * 100).toFixed(1) + "%"} (${both6h12h.length} rows both labeled) |

### Validation metrics @0.5 (mirrors training pipeline)

- rocAuc=${metrics05.rocAuc.toFixed(4)}, acc=${metrics05.accuracy.toFixed(4)}
- TP=${metrics05.tp} FP=${metrics05.fp} TN=${metrics05.tn} FN=${metrics05.fn}

## Top separable features (non-constant train, by |Pearson(y)|)

${univariate
  .slice(0, 10)
  .map((u) => `- **${u.name}**: |r|=${u.absPearsonWithLabel.toFixed(4)}, meanPos−meanNeg=${u.meanDiff.toFixed(6)}`)
  .join("\n")}

## PR curve summary (10 steps by rank depth)

${prSamples.map((p) => `- recall=${p.recall.toFixed(4)} precision=${p.precision.toFixed(4)}`).join("\n")}

## Ranked next steps (safest first)

${rankedNextSteps.map((s) => `${s.priority}. **[${s.type}]** ${s.action} — _${s.rationale}_`).join("\n\n")}

## Recommended letter (a/b/c/d)

- **${recommendedLetter}** (${recommendedLetter === "a" ? "cleaner target" : recommendedLetter === "b" ? "feature set" : recommendedLetter === "c" ? "threshold calibration only" : "alternate bootstrap target"})

_Constraint: report-only; no live trading, activation, or production threshold changes._
`;

    await fs.writeFile(MD_PATH, md, "utf8");
    console.log(`Wrote ${JSON_PATH}`);
    console.log(`Wrote ${MD_PATH}`);
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    await fs.writeFile(JSON_PATH, JSON.stringify({ generatedAt, error: err }, null, 2), "utf8");
    await fs.writeFile(MD_PATH, `# Bootstrap target signal audit\n\nError: ${err}\n`, "utf8");
    throw e;
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
