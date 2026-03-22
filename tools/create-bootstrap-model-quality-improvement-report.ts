import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import { trainLogisticRegression, predictBatchLogistic } from "../lib/ml/baseline";
import { computeMetrics } from "../lib/ml/evaluate";
import { toShadowFeatureVector, SHADOW_FEATURE_NAMES } from "../lib/ml/shadow-train/features";
import { balancedClassWeights, computeActiveFeatureIndices } from "../lib/ml/shadow-train/train";

const DUMP_DIR = path.join(process.cwd(), "dump");
const JSON_PATH = path.join(DUMP_DIR, "bootstrap-model-quality-improvement-report.json");
const MD_PATH = path.join(DUMP_DIR, "bootstrap-model-quality-improvement-report.md");

function summarizeByClass(scores: number[], labels: number[]) {
  const pos = scores.filter((_, i) => labels[i] === 1);
  const neg = scores.filter((_, i) => labels[i] === 0);
  const mean = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
  return {
    posMean: mean(pos),
    negMean: mean(neg),
    separation: (mean(pos) ?? 0) - (mean(neg) ?? 0),
  };
}

function toFeatureInput(r: Awaited<ReturnType<typeof prisma.mlShadowTrainingExample.findMany>>[number]) {
  const ex = r as {
    momentum1hBps?: string | null;
    momentum6hBps?: string | null;
    volatility1hBps?: string | null;
    volatility6hBps?: string | null;
    distanceFromMid?: string | null;
    timeToCloseHours?: string | null;
    liquidityTrend?: string | null;
  };
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
    momentum1hBps: ex.momentum1hBps,
    momentum6hBps: ex.momentum6hBps,
    volatility1hBps: ex.volatility1hBps,
    volatility6hBps: ex.volatility6hBps,
    distanceFromMid: ex.distanceFromMid,
    timeToCloseHours: ex.timeToCloseHours,
    liquidityTrend: ex.liquidityTrend,
  };
}

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });
  const generatedAt = new Date().toISOString();
  const limit = 500;
  const trainRatio = 0.8;

  const rows = await prisma.mlShadowTrainingExample.findMany({
    where: { labelGoodDecision12h: { not: null } },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
  const valid = rows.filter((r) => r.labelGoodDecision12h === true || r.labelGoodDecision12h === false);
  const splitIdx = Math.max(1, Math.floor(valid.length * trainRatio));
  const trainRows = valid.slice(0, splitIdx);
  const valRows = valid.slice(splitIdx);

  const xTrain = trainRows.map((r) => toShadowFeatureVector(toFeatureInput(r)));
  const yTrain = trainRows.map((r) => (r.labelGoodDecision12h ? 1 : 0));
  const xVal = valRows.map((r) => toShadowFeatureVector(toFeatureInput(r)));
  const yVal = valRows.map((r) => (r.labelGoodDecision12h ? 1 : 0));

  const baseline = trainLogisticRegression(xTrain, yTrain, { learningRate: 0.1, maxIter: 500, l2Lambda: 0.01 });
  const baselineScores = predictBatchLogistic(baseline, xVal);
  const baselineMetrics = computeMetrics(baselineScores, yVal);

  const activeFeatureIdxs = computeActiveFeatureIndices(xTrain, 1e-8);
  const improved = trainLogisticRegression(xTrain, yTrain, {
    learningRate: 0.1,
    maxIter: 500,
    l2Lambda: 0.01,
    featureIndices: activeFeatureIdxs.length > 0 ? activeFeatureIdxs : SHADOW_FEATURE_NAMES.map((_, i) => i),
    sampleWeights: balancedClassWeights(yTrain),
  });
  const improvedScores = predictBatchLogistic(improved, xVal);
  const improvedMetrics = computeMetrics(improvedScores, yVal);

  const report = {
    generatedAt,
    chosenImprovement: {
      dropConstantNearConstantFeatures: true,
      classWeighting: "balanced",
      activationGuardrailsChanged: false,
      liveTradingChanged: false,
    },
    whySaferThanThresholdRelaxation:
      "Improves ranking/training signal at model build time while preserving existing fail-closed activation quality gates.",
    sample: {
      total: valid.length,
      train: yTrain.length,
      validation: yVal.length,
      trainPos: yTrain.filter((y) => y === 1).length,
      trainNeg: yTrain.filter((y) => y === 0).length,
      valPos: yVal.filter((y) => y === 1).length,
      valNeg: yVal.filter((y) => y === 0).length,
    },
    before: {
      metrics: baselineMetrics,
      predictedPositiveRateAt05: baselineScores.filter((s) => s >= 0.5).length / Math.max(1, baselineScores.length),
      rankQualityByClass: summarizeByClass(baselineScores, yVal),
    },
    after: {
      metrics: improvedMetrics,
      predictedPositiveRateAt05: improvedScores.filter((s) => s >= 0.5).length / Math.max(1, improvedScores.length),
      rankQualityByClass: summarizeByClass(improvedScores, yVal),
      activeFeatureCount: improved.activeFeatureIdxs?.length ?? SHADOW_FEATURE_NAMES.length,
      droppedFeatureCount:
        SHADOW_FEATURE_NAMES.length - (improved.activeFeatureIdxs?.length ?? SHADOW_FEATURE_NAMES.length),
      droppedFeatureNames: SHADOW_FEATURE_NAMES.filter((_, i) => !(improved.activeFeatureIdxs ?? []).includes(i)),
    },
    activationPlausibility: {
      minAuc: 0.5,
      beforeAuc: baselineMetrics.rocAuc,
      afterAuc: improvedMetrics.rocAuc,
      improvedEnoughForAucGate: improvedMetrics.rocAuc >= 0.5,
    },
  };

  await fs.writeFile(JSON_PATH, JSON.stringify(report, null, 2), "utf8");
  const md = `# Bootstrap model quality improvement report

Generated: ${generatedAt}

## Exact chosen improvement
- Drop constant/near-constant features during shadow training: **true**
- Balanced class weighting during logistic regression training: **true**
- Activation guardrails changed: **false**
- Live trading changed: **false**

## Why safer than threshold relaxation
- ${report.whySaferThanThresholdRelaxation}

## Before/after metrics (same bootstrap sample)
- Before rocAuc: **${baselineMetrics.rocAuc.toFixed(4)}**
- After rocAuc: **${improvedMetrics.rocAuc.toFixed(4)}**
- Before F1: **${baselineMetrics.f1.toFixed(4)}**
- After F1: **${improvedMetrics.f1.toFixed(4)}**
- Before predicted-positive-rate@0.5: **${report.before.predictedPositiveRateAt05.toFixed(4)}**
- After predicted-positive-rate@0.5: **${report.after.predictedPositiveRateAt05.toFixed(4)}**
- Dropped features: **${report.after.droppedFeatureCount}**

## Rank quality by class
- Before separation (posMean-negMean): **${report.before.rankQualityByClass.separation.toFixed(6)}**
- After separation (posMean-negMean): **${report.after.rankQualityByClass.separation.toFixed(6)}**

## Activation plausibility
- AUC gate: minAuc=${report.activationPlausibility.minAuc}
- AUC before: ${report.activationPlausibility.beforeAuc.toFixed(4)}
- AUC after: ${report.activationPlausibility.afterAuc.toFixed(4)}
- Plausible now: **${report.activationPlausibility.improvedEnoughForAucGate}**
`;
  await fs.writeFile(MD_PATH, md, "utf8");
  console.log(`Wrote ${JSON_PATH}`);
  console.log(`Wrote ${MD_PATH}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

