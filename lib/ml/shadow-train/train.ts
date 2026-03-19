/**
 * Shadow ML training: load MlShadowTrainingExample, train logistic regression, persist MlModelRun.
 * Model type "logistic_regression_shadow" keeps it separate from recommendation ML. Advisory only.
 */

import { prisma } from "@/lib/db";
import { trainLogisticRegression, predictBatchLogistic, getLogisticFeatureImportance } from "@/lib/ml/baseline";
import { computeMetrics } from "@/lib/ml/evaluate";
import { validateTargetForTraining } from "@/lib/ml/targets/validate";
import { toShadowFeatureVector, SHADOW_FEATURE_NAMES, SHADOW_FEATURE_SET_V1 } from "./features";
import type { ShadowTargetLabel, TrainShadowOptions, TrainShadowResult } from "./types";

/** Model type for shadow-trained runs; recommendation ML uses "logistic_regression". */
export const SHADOW_MODEL_TYPE = "logistic_regression_shadow";

export async function trainShadowModel(
  targetLabel: ShadowTargetLabel = "labelGoodDecision",
  options: TrainShadowOptions = {}
): Promise<TrainShadowResult> {
  const { funderAddress, candidateSource, limit = 2000, createdAfter, createdBefore, trainRatio = 0.8, debug = false } = options;

  const where: { funderAddress?: string; candidateSource?: string; createdAt?: { gte?: Date; lte?: Date }; [k: string]: unknown } = {};
  if (funderAddress) where.funderAddress = funderAddress.toLowerCase().trim();
  if (candidateSource) where.candidateSource = candidateSource;
  if (createdAfter) where.createdAt = { ...where.createdAt, gte: createdAfter };
  if (createdBefore) where.createdAt = { ...where.createdAt, lte: createdBefore };
  // Only rows with a non-null label for the chosen target
  where[targetLabel] = { not: null };

  const rows = await prisma.mlShadowTrainingExample.findMany({
    where,
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  const valid = rows.filter((r) => (r[targetLabel] === true || r[targetLabel] === false));
  const validation = validateTargetForTraining(targetLabel, { populatedCount: valid.length });
  for (const w of validation.warnings) {
    console.warn(`[train-shadow] ${w}`);
  }
  for (const e of validation.errors) {
    console.warn(`[train-shadow] ${e}`);
  }
  if (valid.length < 10) {
    return {
      success: false,
      targetLabel,
      datasetSize: valid.length,
      trainCount: 0,
      validationCount: 0,
      error: `Insufficient shadow training data (${valid.length} with ${targetLabel}). Need at least 10.`,
    };
  }

  const splitIdx = Math.max(1, Math.floor(valid.length * trainRatio));
  const trainRows = valid.slice(0, splitIdx);
  const valRows = valid.slice(splitIdx);

  if (trainRows.length < 5 || valRows.length < 2) {
    return {
      success: false,
      targetLabel,
      datasetSize: valid.length,
      trainCount: trainRows.length,
      validationCount: valRows.length,
      error: "Time split left too few train or validation examples. Need at least 5 train and 2 val.",
    };
  }

  const toInput = (r: (typeof valid)[0]) => ({
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
    outcomeBlockedVsAllowedVsSubmitted: r.outcomeBlockedVsAllowedVsSubmitted as "blocked" | "allowed" | "submitted" | null,
    momentum1hBps: (r as { momentum1hBps?: string | null }).momentum1hBps,
    momentum6hBps: (r as { momentum6hBps?: string | null }).momentum6hBps,
    volatility1hBps: (r as { volatility1hBps?: string | null }).volatility1hBps,
    volatility6hBps: (r as { volatility6hBps?: string | null }).volatility6hBps,
    distanceFromMid: (r as { distanceFromMid?: string | null }).distanceFromMid,
    timeToCloseHours: (r as { timeToCloseHours?: string | null }).timeToCloseHours,
    liquidityTrend: (r as { liquidityTrend?: string | null }).liquidityTrend,
  });

  const XTrain = trainRows.map((r) => toShadowFeatureVector(toInput(r)));
  const yTrain = trainRows.map((r) => (r[targetLabel] === true ? 1 : 0));
  const XVal = valRows.map((r) => toShadowFeatureVector(toInput(r)));
  const yVal = valRows.map((r) => (r[targetLabel] === true ? 1 : 0));

  if (debug && XTrain.length > 0) {
    console.log("[train] feature names (same order as toShadowFeatureVector):", SHADOW_FEATURE_NAMES.join(", "));
    XTrain.slice(0, 3).forEach((vec, idx) => {
      console.log(`[train] vector ${idx + 1}:`, JSON.stringify(vec));
    });
  }

  const model = trainLogisticRegression(XTrain, yTrain, {
    learningRate: 0.1,
    maxIter: 500,
    l2Lambda: 0.01,
  });

  const valProbas = predictBatchLogistic(model, XVal);
  const metrics = computeMetrics(valProbas, yVal);
  const featureImportance = getLogisticFeatureImportance(model, SHADOW_FEATURE_NAMES);

  const trainedFrom = trainRows[0]?.createdAt ?? null;
  const trainedTo = trainRows[trainRows.length - 1]?.createdAt ?? null;
  const validatedFrom = valRows[0]?.createdAt ?? null;
  const validatedTo = valRows[valRows.length - 1]?.createdAt ?? null;

  const metricsJson = JSON.stringify({
    accuracy: metrics.accuracy,
    precision: metrics.precision,
    recall: metrics.recall,
    f1: metrics.f1,
    rocAuc: metrics.rocAuc,
    threshold: metrics.threshold,
    coefficients: model.coefficients,
    intercept: model.intercept,
    means: model.means,
    stds: model.stds,
  });

  const run = await prisma.mlModelRun.create({
    data: {
      modelType: SHADOW_MODEL_TYPE,
      targetLabel,
      featureSetName: SHADOW_FEATURE_SET_V1,
      status: "TRAINED",
      trainCount: XTrain.length,
      validationCount: XVal.length,
      trainedFrom: trainedFrom ?? undefined,
      trainedTo: trainedTo ?? undefined,
      validatedFrom: validatedFrom ?? undefined,
      validatedTo: validatedTo ?? undefined,
      metricsJson,
      artifactPath: null,
      leakageCheckPassed: null,
    },
  });

  return {
    success: true,
    modelRunId: run.id,
    targetLabel,
    datasetSize: valid.length,
    trainCount: XTrain.length,
    validationCount: XVal.length,
    trainedFrom: trainedFrom?.toISOString() ?? null,
    trainedTo: trainedTo?.toISOString() ?? null,
    validatedFrom: validatedFrom?.toISOString() ?? null,
    validatedTo: validatedTo?.toISOString() ?? null,
    metrics: {
      accuracy: metrics.accuracy,
      precision: metrics.precision,
      recall: metrics.recall,
      f1: metrics.f1,
      rocAuc: metrics.rocAuc,
    },
    featureImportance,
  };
}
