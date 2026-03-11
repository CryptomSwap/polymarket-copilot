/**
 * Train baseline model with time-based train/validation split, leakage check, persist MlModelRun.
 * Does not write Recommendation.mlScore — use score-live pipeline for out-of-sample scoring. No autonomous trading.
 */

import { prisma } from "@/lib/db";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";
import { loadTrainingDataTimeSplit } from "./dataset";
import { FEATURE_NAMES, FEATURE_SET_V1 } from "./features";
import {
  trainLogisticRegression,
  predictBatchLogistic,
  getLogisticFeatureImportance,
} from "./baseline";
import { computeMetrics, type ClassificationMetrics } from "./evaluate";
import { calibrationReport, type CalibrationSummaryReport } from "./calibration";
import { compareHeuristicVsMl, type HeuristicVsMlComparison } from "./heuristic-vs-ml";
import { checkFeatureSetLeakage } from "./leakage-check";

export type TargetLabel = "labelPositive6h" | "labelPositive24h";

export interface TrainBaselineResult {
  success: boolean;
  modelRunId?: string;
  targetLabel: TargetLabel;
  datasetSize: number;
  trainCount: number;
  validationCount: number;
  trainedFrom?: string | null;
  trainedTo?: string | null;
  validatedFrom?: string | null;
  validatedTo?: string | null;
  leakageCheckPassed?: boolean;
  leakageErrors?: string[];
  metrics?: ClassificationMetrics;
  calibration?: CalibrationSummaryReport;
  comparison?: HeuristicVsMlComparison;
  featureImportance?: Array<{ name: string; coefficient: number; absCoefficient: number }>;
  error?: string;
}

export interface TrainBaselineOptions {
  trainRatio?: number; // default 0.8 (oldest 80% train, newest 20% val)
}

/**
 * Train logistic regression baseline with time-based split, evaluate on validation window, persist run.
 * Status is TRAINED; use approve/activate and score-live for production scoring.
 */
export async function trainAndPersistBaseline(
  funderAddress?: string,
  targetLabel: TargetLabel = "labelPositive24h",
  options?: TrainBaselineOptions
): Promise<TrainBaselineResult> {
  const funder = funderAddress?.toLowerCase() ?? (await getFunderForRecompute());
  if (!funder) {
    return { success: false, targetLabel, datasetSize: 0, trainCount: 0, validationCount: 0, error: "No funder address." };
  }

  const trainRatio = options?.trainRatio ?? 0.8;
  const splitResult = await loadTrainingDataTimeSplit(funder, targetLabel, trainRatio);
  const { XTrain, yTrain, XVal, yVal, trainRecommendationIds, valRecommendationIds, trainedFrom, trainedTo, validatedFrom, validatedTo } = splitResult;

  const totalSize = XTrain.length + XVal.length;
  if (totalSize < 10) {
    return {
      success: false,
      targetLabel,
      datasetSize: totalSize,
      trainCount: XTrain.length,
      validationCount: XVal.length,
      error: `Insufficient training data (${totalSize} examples). Need at least 10.`,
    };
  }
  if (XTrain.length < 5 || XVal.length < 2) {
    return {
      success: false,
      targetLabel,
      datasetSize: totalSize,
      trainCount: XTrain.length,
      validationCount: XVal.length,
      error: "Time split left too few train or validation examples. Need at least 5 train and 2 val.",
    };
  }

  const leakage = checkFeatureSetLeakage();
  if (!leakage.passed) {
    return {
      success: false,
      targetLabel,
      datasetSize: totalSize,
      trainCount: XTrain.length,
      validationCount: XVal.length,
      leakageCheckPassed: false,
      leakageErrors: leakage.errors,
      error: `Leakage check failed: ${leakage.errors.join("; ")}`,
    };
  }

  const model = trainLogisticRegression(XTrain, yTrain, {
    learningRate: 0.1,
    maxIter: 500,
    l2Lambda: 0.01,
  });

  const valProbas = predictBatchLogistic(model, XVal);
  const metrics = computeMetrics(valProbas, yVal);
  const calibration = calibrationReport(valProbas, yVal, 10);

  const examplesById = new Map<string, { priorityScore: string | null; forwardReturn6h: string | null; forwardReturn24h: string | null }>();
  const allValIds = [...trainRecommendationIds, ...valRecommendationIds];
  const examplesList = await prisma.mlTrainingExample.findMany({
    where: { recommendationId: { in: allValIds } },
    select: { recommendationId: true, priorityScore: true, forwardReturn6h: true, forwardReturn24h: true },
  });
  for (const e of examplesList) {
    examplesById.set(e.recommendationId, {
      priorityScore: e.priorityScore,
      forwardReturn6h: e.forwardReturn6h,
      forwardReturn24h: e.forwardReturn24h,
    });
  }
  const valHeuristicScores = valRecommendationIds.map((id) =>
    parseFloat(examplesById.get(id)?.priorityScore ?? "0")
  );
  const valForwardReturns = valRecommendationIds.map((id) => {
    const ex = examplesById.get(id);
    const raw = targetLabel === "labelPositive6h" ? ex?.forwardReturn6h : ex?.forwardReturn24h;
    return raw ? parseFloat(raw) : 0;
  });
  const comparison = compareHeuristicVsMl(
    {
      recommendationIds: valRecommendationIds,
      heuristicScores: valHeuristicScores,
      mlProbas: valProbas,
      labels: yVal,
      forwardReturns: valForwardReturns,
    },
    [5, 10, 20],
    5
  );

  const featureImportance = getLogisticFeatureImportance(model, FEATURE_NAMES);

  const metricsJson = JSON.stringify({
    accuracy: metrics.accuracy,
    precision: metrics.precision,
    recall: metrics.recall,
    f1: metrics.f1,
    rocAuc: metrics.rocAuc,
    threshold: metrics.threshold,
    tp: metrics.tp,
    fp: metrics.fp,
    tn: metrics.tn,
    fn: metrics.fn,
    calibrationMae: calibration.mae,
    comparison: comparison,
    coefficients: model.coefficients,
    intercept: model.intercept,
    means: model.means,
    stds: model.stds,
  });

  const run = await prisma.mlModelRun.create({
    data: {
      modelType: "logistic_regression",
      targetLabel,
      featureSetName: FEATURE_SET_V1,
      status: "TRAINED",
      trainCount: XTrain.length,
      validationCount: XVal.length,
      trainedFrom: trainedFrom ?? undefined,
      trainedTo: trainedTo ?? undefined,
      validatedFrom: validatedFrom ?? undefined,
      validatedTo: validatedTo ?? undefined,
      metricsJson,
      artifactPath: null,
      leakageCheckPassed: true,
    },
  });

  return {
    success: true,
    modelRunId: run.id,
    targetLabel,
    datasetSize: totalSize,
    trainCount: XTrain.length,
    validationCount: XVal.length,
    trainedFrom: trainedFrom?.toISOString() ?? null,
    trainedTo: trainedTo?.toISOString() ?? null,
    validatedFrom: validatedFrom?.toISOString() ?? null,
    validatedTo: validatedTo?.toISOString() ?? null,
    leakageCheckPassed: true,
    metrics,
    calibration,
    comparison,
    featureImportance,
  };
}
