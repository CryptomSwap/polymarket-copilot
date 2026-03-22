/**
 * Report-only experiment: production labelGoodDecision12h (mixed semantics) vs
 * submitted/allowed-only slice with y = (markout12h > 0).
 * No schema, activation, live trading, or production label changes.
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import { toShadowFeatureVector, SHADOW_FEATURE_NAMES } from "../lib/ml/shadow-train/features";
import { trainLogisticRegression, predictBatchLogistic } from "../lib/ml/baseline";
import { computeMetrics } from "../lib/ml/evaluate";
import { computeActiveFeatureIndices, balancedClassWeights } from "../lib/ml/shadow-train/train";

const DUMP_DIR = path.join(process.cwd(), "dump");
const JSON_PATH = path.join(DUMP_DIR, "bootstrap-clean-target-audit.json");
const MD_PATH = path.join(DUMP_DIR, "bootstrap-clean-target-audit.md");

type Row = {
  createdAt: Date;
  labelGoodDecision12h: boolean | null;
  blockedIndicator: boolean;
  outcomeBlockedVsAllowedVsSubmitted: string | null;
  markout12h: string | null;
  policyState: string | null;
  sizeMultiplier: string | null;
  finalSuggestedSize: string | null;
  eligibilityBlockersCount: number;
  reducedSizeIndicator: boolean;
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
  momentum1hBps: string | null;
  momentum6hBps: string | null;
  volatility1hBps: string | null;
  volatility6hBps: string | null;
  distanceFromMid: string | null;
  timeToCloseHours: string | null;
  liquidityTrend: string | null;
};

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

function parseMarkout12(s: string | null): number | null {
  if (s == null || s === "") return null;
  const n = parseFloat(String(s).trim());
  return Number.isFinite(n) ? n : null;
}

/** Trade path only: allowed or submitted outcome, and not blocked (defensive vs inconsistent rows). */
function isSubmittedOrAllowedTradePath(r: Row): boolean {
  const o = r.outcomeBlockedVsAllowedVsSubmitted;
  if (o !== "allowed" && o !== "submitted") return false;
  if (r.blockedIndicator === true) return false;
  return true;
}

function toInput(r: Row) {
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

function bestF1Threshold(scores: number[], y: number[]): {
  threshold: number;
  f1: number;
  tp: number;
  fp: number;
  tn: number;
  fn: number;
} {
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

interface ArmResult {
  armId: "mixed_labelGoodDecision12h" | "clean_submitted_allowed_markout12h_positive";
  labelDefinition: string;
  datasetSize: number;
  trainSize: number;
  validationSize: number;
  trainPos: number;
  trainNeg: number;
  valPos: number;
  valNeg: number;
  trainPosRate: number;
  valPosRate: number;
  activeFeatureCount: number;
  constantFeatureCount: number;
  validation: {
    rocAuc: number;
    metricsAt05: ReturnType<typeof computeMetrics>;
    predictedPositiveRateAt05: number;
    bestF1: ReturnType<typeof bestF1Threshold>;
    degenerateBestF1: boolean;
    f1AlwaysPredictPositive: number;
  };
  topUnivariateByAbsCorr: Array<{
    name: string;
    absPearsonWithLabel: number;
    meanDiffPosMinusNeg: number;
  }>;
  skippedReason?: string;
}

function runArm(
  armId: ArmResult["armId"],
  labelDefinition: string,
  rows: Row[],
  yLabels: number[],
  trainRatio: number
): ArmResult {
  if (rows.length !== yLabels.length) {
    return {
      armId,
      labelDefinition,
      datasetSize: 0,
      trainSize: 0,
      validationSize: 0,
      trainPos: 0,
      trainNeg: 0,
      valPos: 0,
      valNeg: 0,
      trainPosRate: 0,
      valPosRate: 0,
      activeFeatureCount: 0,
      constantFeatureCount: SHADOW_FEATURE_NAMES.length,
      validation: {
        rocAuc: 0.5,
        metricsAt05: computeMetrics([], [], 0.5),
        predictedPositiveRateAt05: 0,
        bestF1: { threshold: 0.5, f1: 0, tp: 0, fp: 0, tn: 0, fn: 0 },
        degenerateBestF1: false,
        f1AlwaysPredictPositive: 0,
      },
      topUnivariateByAbsCorr: [],
      skippedReason: "row_label_length_mismatch",
    };
  }

  if (rows.length < 20) {
    return {
      armId,
      labelDefinition,
      datasetSize: rows.length,
      trainSize: 0,
      validationSize: 0,
      trainPos: yLabels.filter((y) => y === 1).length,
      trainNeg: yLabels.filter((y) => y === 0).length,
      valPos: 0,
      valNeg: 0,
      trainPosRate: 0,
      valPosRate: 0,
      activeFeatureCount: 0,
      constantFeatureCount: SHADOW_FEATURE_NAMES.length,
      validation: {
        rocAuc: 0.5,
        metricsAt05: computeMetrics([], [], 0.5),
        predictedPositiveRateAt05: 0,
        bestF1: { threshold: 0.5, f1: 0, tp: 0, fp: 0, tn: 0, fn: 0 },
        degenerateBestF1: false,
        f1AlwaysPredictPositive: 0,
      },
      topUnivariateByAbsCorr: [],
      skippedReason: `insufficient_rows_need_at_least_20_got_${rows.length}`,
    };
  }

  const splitIdx = Math.max(1, Math.floor(rows.length * trainRatio));
  const trainRows = rows.slice(0, splitIdx);
  const valRows = rows.slice(splitIdx);
  const yTrain = yLabels.slice(0, splitIdx);
  const yVal = yLabels.slice(splitIdx);
  const trP = yTrain.filter((y) => y === 1).length;
  const trN = yTrain.length - trP;
  const vP = yVal.filter((y) => y === 1).length;
  const vN = yVal.length - vP;
  if (trP === 0 || trN === 0 || vP === 0 || vN === 0) {
    return {
      armId,
      labelDefinition,
      datasetSize: rows.length,
      trainSize: trainRows.length,
      validationSize: valRows.length,
      trainPos: trP,
      trainNeg: trN,
      valPos: vP,
      valNeg: vN,
      trainPosRate: yTrain.length ? trP / yTrain.length : 0,
      valPosRate: yVal.length ? vP / yVal.length : 0,
      activeFeatureCount: 0,
      constantFeatureCount: SHADOW_FEATURE_NAMES.length,
      validation: {
        rocAuc: 0.5,
        metricsAt05: computeMetrics([], [], 0.5),
        predictedPositiveRateAt05: 0,
        bestF1: { threshold: 0.5, f1: 0, tp: 0, fp: 0, tn: 0, fn: 0 },
        degenerateBestF1: false,
        f1AlwaysPredictPositive: 0,
      },
      topUnivariateByAbsCorr: [],
      skippedReason: `single_class_split_train_${trP}_${trN}_val_${vP}_${vN}`,
    };
  }

  if (trainRows.length < 10 || valRows.length < 4) {
    return {
      armId,
      labelDefinition,
      datasetSize: rows.length,
      trainSize: trainRows.length,
      validationSize: valRows.length,
      trainPos: yTrain.filter((y) => y === 1).length,
      trainNeg: yTrain.filter((y) => y === 0).length,
      valPos: yVal.filter((y) => y === 1).length,
      valNeg: yVal.filter((y) => y === 0).length,
      trainPosRate: yTrain.length ? yTrain.filter((y) => y === 1).length / yTrain.length : 0,
      valPosRate: yVal.length ? yVal.filter((y) => y === 1).length / yVal.length : 0,
      activeFeatureCount: 0,
      constantFeatureCount: SHADOW_FEATURE_NAMES.length,
      validation: {
        rocAuc: 0.5,
        metricsAt05: computeMetrics([], [], 0.5),
        predictedPositiveRateAt05: 0,
        bestF1: { threshold: 0.5, f1: 0, tp: 0, fp: 0, tn: 0, fn: 0 },
        degenerateBestF1: false,
        f1AlwaysPredictPositive: 0,
      },
      topUnivariateByAbsCorr: [],
      skippedReason: "split_too_small_for_stable_val",
    };
  }

  const XTrain = trainRows.map((r) => toShadowFeatureVector(toInput(r)));
  const XVal = valRows.map((r) => toShadowFeatureVector(toInput(r)));

  const activeIdx = computeActiveFeatureIndices(XTrain, 1e-8);
  const constantCount = SHADOW_FEATURE_NAMES.length - activeIdx.length;

  const yTrainF = yTrain.map((v) => v as number);
  const univariate: ArmResult["topUnivariateByAbsCorr"] = [];
  for (const j of activeIdx) {
    const col = XTrain.map((row) => row[j] ?? 0);
    const posVals = col.filter((_, i) => yTrain[i] === 1);
    const negVals = col.filter((_, i) => yTrain[i] === 0);
    const meanPos = mean(posVals);
    const meanNeg = mean(negVals);
    univariate.push({
      name: SHADOW_FEATURE_NAMES[j] ?? `f${j}`,
      absPearsonWithLabel: Math.abs(pearsonCorr(col, yTrainF)),
      meanDiffPosMinusNeg: meanPos - meanNeg,
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
  const predPosAt05 = valScores.length ? valScores.filter((s) => s >= 0.5).length / valScores.length : 0;
  const bestF1 = bestF1Threshold(valScores, yVal);
  const posRateVal = yVal.length ? yVal.filter((y) => y === 1).length / yVal.length : 0;
  const allPosF1 = computeMetrics(yVal.map(() => 1), yVal, 0.5).f1;
  const degenerateBestF1 =
    bestF1.threshold <= 0.05 &&
    Math.abs(bestF1.f1 - allPosF1) < 0.04 &&
    posRateVal >= 0.55;

  return {
    armId,
    labelDefinition,
    datasetSize: rows.length,
    trainSize: trainRows.length,
    validationSize: valRows.length,
    trainPos: yTrain.filter((y) => y === 1).length,
    trainNeg: yTrain.filter((y) => y === 0).length,
    valPos: yVal.filter((y) => y === 1).length,
    valNeg: yVal.filter((y) => y === 0).length,
    trainPosRate: yTrain.length ? yTrain.filter((y) => y === 1).length / yTrain.length : 0,
    valPosRate: posRateVal,
    activeFeatureCount: activeIdx.length,
    constantFeatureCount: constantCount,
    validation: {
      rocAuc: metrics05.rocAuc,
      metricsAt05: metrics05,
      predictedPositiveRateAt05: predPosAt05,
      bestF1,
      degenerateBestF1,
      f1AlwaysPredictPositive: allPosF1,
    },
    topUnivariateByAbsCorr: univariate.slice(0, 12),
  };
}

function buildConclusion(mixed: ArmResult, clean: ArmResult): {
  removingBlockedMateriallyImprovesLearnability: boolean;
  summary: string;
  recommendDedicatedBootstrapTargetPath: "yes" | "no" | "insufficient_data";
  rationale: string;
  sampleReliabilityNote: string;
} {
  const minCleanRows = 200;
  const minValRows = 80;
  if (
    clean.skippedReason ||
    clean.datasetSize < minCleanRows ||
    clean.validationSize < minValRows
  ) {
    return {
      removingBlockedMateriallyImprovesLearnability: false,
      summary:
        "Cannot conclude at scale: trade-path (allowed/submitted) slice is too small for stable validation metrics; re-run when more non-blocked examples exist in the 12h-labeled pool.",
      recommendDedicatedBootstrapTargetPath: "insufficient_data",
      rationale:
        clean.skippedReason ??
        `clean_datasetSize=${clean.datasetSize} (need >=${minCleanRows}), validationSize=${clean.validationSize} (need >=${minValRows})`,
      sampleReliabilityNote:
        "ROC-AUC / F1 on tiny validation sets (e.g. <80) are not reliable; ignore apparent AUC gains when n is small.",
    };
  }

  if (mixed.skippedReason) {
    return {
      removingBlockedMateriallyImprovesLearnability: false,
      summary: "Mixed arm failed to run; compare aborted.",
      recommendDedicatedBootstrapTargetPath: "no",
      rationale: mixed.skippedReason,
      sampleReliabilityNote: "n/a",
    };
  }

  const aucDelta = clean.validation.rocAuc - mixed.validation.rocAuc;
  const cleanAuc = clean.validation.rocAuc;
  const mixedAuc = mixed.validation.rocAuc;
  const maxCorrDelta =
    (clean.topUnivariateByAbsCorr[0]?.absPearsonWithLabel ?? 0) -
    (mixed.topUnivariateByAbsCorr[0]?.absPearsonWithLabel ?? 0);

  /** Material if AUC lifts clearly above chance and beats mixed by a margin, and best F1 is not purely degenerate. */
  const materialAuc =
    cleanAuc >= 0.56 &&
    aucDelta >= 0.04 &&
    (!clean.validation.degenerateBestF1 || cleanAuc >= 0.62);

  const marginalAuc =
    cleanAuc > mixedAuc + 0.02 &&
    cleanAuc >= 0.53 &&
    cleanAuc < 0.56 &&
    maxCorrDelta > 0.02;

  const improves = materialAuc || marginalAuc;

  if (materialAuc) {
    return {
      removingBlockedMateriallyImprovesLearnability: true,
      summary: `Clean trade-path target shows meaningfully higher validation ROC-AUC (${cleanAuc.toFixed(4)} vs ${mixedAuc.toFixed(4)}, Δ=${aucDelta.toFixed(4)}).`,
      recommendDedicatedBootstrapTargetPath: "yes",
      rationale:
        "Single-semantics label (favorable 12h markout on allowed/submitted only) improves ranking enough to justify a separate experimental column or training path next (still paper-only / governance-gated).",
      sampleReliabilityNote: "Sample sizes meet minimum thresholds for a coarse read; confirm with holdout / more data.",
    };
  }

  if (marginalAuc) {
    return {
      removingBlockedMateriallyImprovesLearnability: true,
      summary: `Modest AUC gain (${aucDelta.toFixed(4)}) and slightly stronger top univariate signal; not yet strong production evidence.`,
      recommendDedicatedBootstrapTargetPath: "no",
      rationale:
        "Prefer more data on the clean slice and richer features before a dedicated bootstrap target; optionally add a report-only or offline column after schema review.",
      sampleReliabilityNote: "n/a",
    };
  }

  return {
    removingBlockedMateriallyImprovesLearnability: false,
    summary: `Clean slice AUC ${cleanAuc.toFixed(4)} remains near mixed ${mixedAuc.toFixed(4)} (Δ=${aucDelta.toFixed(4)}); feature weakness likely dominant.`,
    recommendDedicatedBootstrapTargetPath: "no",
    rationale:
      "Target cleanup alone does not rescue learnability with shadow_v1; invest in features (and/or more trade-path rows) before a new production target.",
    sampleReliabilityNote: "n/a",
  };
}

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });
  const generatedAt = new Date().toISOString();
  const limit = Math.min(
    50_000,
    Math.max(500, parseInt(process.env.BOOTSTRAP_CLEAN_TARGET_AUDIT_LIMIT ?? "9500", 10) || 9500)
  );
  const trainRatio = 0.8;

  const select = {
    createdAt: true,
    labelGoodDecision12h: true,
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
    momentum1hBps: true,
    momentum6hBps: true,
    volatility1hBps: true,
    volatility6hBps: true,
    distanceFromMid: true,
    timeToCloseHours: true,
    liquidityTrend: true,
  } as const;

  try {
    const pool = await prisma.mlShadowTrainingExample.findMany({
      where: { labelGoodDecision12h: { not: null } },
      orderBy: { createdAt: "asc" },
      take: limit,
      select,
    });

    const baseRows = pool as Row[];

    const mixedRows: Row[] = [];
    const mixedY: number[] = [];
    for (const r of baseRows) {
      if (r.labelGoodDecision12h === true || r.labelGoodDecision12h === false) {
        mixedRows.push(r);
        mixedY.push(r.labelGoodDecision12h ? 1 : 0);
      }
    }

    const cleanRows: Row[] = [];
    const cleanY: number[] = [];
    for (const r of baseRows) {
      if (!isSubmittedOrAllowedTradePath(r)) continue;
      const m12 = parseMarkout12(r.markout12h);
      if (m12 == null) continue;
      cleanRows.push(r);
      cleanY.push(m12 > 0 ? 1 : 0);
    }

    const inPoolAllowedSubmitted = baseRows.filter(isSubmittedOrAllowedTradePath).length;
    const inPoolWithMarkout = baseRows.filter((r) => parseMarkout12(r.markout12h) != null).length;

    const mixed = runArm(
      "mixed_labelGoodDecision12h",
      "Production MlShadowTrainingExample.labelGoodDecision12h (deriveGoodDecisionLabelFromMarkout; blocked vs allowed semantics).",
      mixedRows,
      mixedY,
      trainRatio
    );

    const clean = runArm(
      "clean_submitted_allowed_markout12h_positive",
      "Experimental report-only: outcomeBlockedVsAllowedVsSubmitted in {allowed,submitted}, blockedIndicator=false, y=1 iff markout12h>0.",
      cleanRows,
      cleanY,
      trainRatio
    );

    const conclusion = buildConclusion(mixed, clean);

    const report = {
      generatedAt,
      constraints: {
        reportOnly: true,
        noActivationChanges: true,
        noLiveTradingChanges: true,
        noProductionLabelOrSchemaChanges: true,
      },
      source: {
        table: "MlShadowTrainingExample",
        poolFilter: "labelGoodDecision12h IS NOT NULL",
        limit,
        trainRatio,
        poolRowCount: baseRows.length,
        mixedEligibleCount: mixedRows.length,
        cleanEligibleCount: cleanRows.length,
        poolAllowedOrSubmittedCount: inPoolAllowedSubmitted,
        poolWithParseableMarkout12h: inPoolWithMarkout,
      },
      experimentalDefinition: {
        include: "outcomeBlockedVsAllowedVsSubmitted === 'allowed' | 'submitted' AND blockedIndicator === false",
        exclude: "blocked path; missing or non-finite markout12h",
        positiveClass: "markout12h > 0",
        negativeClass: "markout12h <= 0",
        moduleReference: "tools/create-bootstrap-clean-target-audit.ts (this report only)",
      },
      arms: { mixed, clean },
      conclusion,
      conclusionThresholds: {
        minCleanDatasetRows: 200,
        minCleanValidationRows: 80,
        materialAucMin: 0.56,
        materialAucDeltaVsMixed: 0.04,
        marginalAucMin: 0.53,
        marginalAucDeltaVsMixed: 0.02,
      },
      trainingMirrorsProductionShadowTrain: {
        timeSplitOldestFirst: true,
        balancedClassWeights: true,
        dropConstantFeatures: true,
        nearConstantVarianceThreshold: 1e-8,
        model: "trainLogisticRegression (lib/ml/baseline.ts) same hyperparameters as shadow train",
      },
    };

    await fs.writeFile(JSON_PATH, JSON.stringify(report, null, 2), "utf8");

    const md = `# Bootstrap clean-target audit (report-only experiment)

Generated: ${generatedAt}

## Experimental target (not production)

- **Include:** allowed or submitted trade path, \`blockedIndicator === false\`
- **Label:** \`markout12h > 0\` → positive (requires parseable markout)
- **Pool:** same as canonical 12h bootstrap pool (\`labelGoodDecision12h\` non-null), limit=${limit}

## Dataset counts

| Metric | Count |
|--------|------:|
| Pool rows | ${baseRows.length} |
| Mixed arm (binary labelGoodDecision12h) | ${mixedRows.length} |
| Clean arm (trade-path + markout12h) | ${cleanRows.length} |
| Pool allowed/submitted rows | ${inPoolAllowedSubmitted} |
| Pool parseable markout12h | ${inPoolWithMarkout} |

## Side-by-side validation

| Arm | n | val ROC-AUC | F1@0.5 | predPos@0.5 | best F1 (thr) | active features |
|-----|---|------------|--------|-------------|---------------|-----------------|
| Mixed (labelGoodDecision12h) | ${mixed.datasetSize} | ${mixed.validation.rocAuc.toFixed(4)} | ${mixed.validation.metricsAt05.f1.toFixed(4)} | ${mixed.validation.predictedPositiveRateAt05.toFixed(4)} | ${mixed.validation.bestF1.f1.toFixed(4)} (${mixed.validation.bestF1.threshold.toFixed(2)})${mixed.validation.degenerateBestF1 ? " ‡" : ""} | ${mixed.activeFeatureCount} |
| Clean (markout12h>0 trade-path) | ${clean.datasetSize} | ${clean.validation.rocAuc.toFixed(4)} | ${clean.validation.metricsAt05.f1.toFixed(4)} | ${clean.validation.predictedPositiveRateAt05.toFixed(4)} | ${clean.validation.bestF1.f1.toFixed(4)} (${clean.validation.bestF1.threshold.toFixed(2)})${clean.validation.degenerateBestF1 ? " ‡" : ""} | ${clean.activeFeatureCount} |

‡ Best F1 at extreme threshold ≈ always-positive baseline (see JSON \`degenerateBestF1\`).

### Mixed @0.5 confusion: TP=${mixed.validation.metricsAt05.tp} FP=${mixed.validation.metricsAt05.fp} TN=${mixed.validation.metricsAt05.tn} FN=${mixed.validation.metricsAt05.fn}

### Clean @0.5 confusion: TP=${clean.validation.metricsAt05.tp} FP=${clean.validation.metricsAt05.fp} TN=${clean.validation.metricsAt05.tn} FN=${clean.validation.metricsAt05.fn}

## Top univariate |corr| (train, active features only)

### Mixed — top 5

${mixed.topUnivariateByAbsCorr
  .slice(0, 5)
  .map((u) => `- ${u.name}: |r|=${u.absPearsonWithLabel.toFixed(4)}`)
  .join("\n")}

### Clean — top 5

${clean.topUnivariateByAbsCorr
  .slice(0, 5)
  .map((u) => `- ${u.name}: |r|=${u.absPearsonWithLabel.toFixed(4)}`)
  .join("\n")}

## Required conclusion

**Does removing blocked / using single-semantics markout sign materially improve learnability?**  
→ **${conclusion.removingBlockedMateriallyImprovesLearnability ? "Yes (per report thresholds)" : "No"}**

**Recommend dedicated bootstrap target path?** → **${conclusion.recommendDedicatedBootstrapTargetPath}**

${conclusion.summary}

_${conclusion.rationale}_

**Sample reliability:** ${conclusion.sampleReliabilityNote}
`;

    await fs.writeFile(MD_PATH, md, "utf8");
    console.log(`Wrote ${JSON_PATH}`);
    console.log(`Wrote ${MD_PATH}`);
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    await fs.writeFile(JSON_PATH, JSON.stringify({ generatedAt, error: err }, null, 2), "utf8");
    await fs.writeFile(MD_PATH, `# Bootstrap clean-target audit\n\nError: ${err}\n`, "utf8");
    throw e;
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
