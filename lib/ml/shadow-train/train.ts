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

function parseMetadataRecommendationId(metadataJson: string | null): string | null {
  if (!metadataJson) return null;
  try {
    const obj = JSON.parse(metadataJson) as Record<string, unknown>;
    if (typeof obj.recommendationId === "string" && obj.recommendationId.trim()) return obj.recommendationId.trim();
    const oa = obj.openAttribution as Record<string, unknown> | undefined;
    if (oa && typeof oa.recommendationId === "string" && oa.recommendationId.trim()) return oa.recommendationId.trim();
  } catch {
    // ignore malformed metadata
  }
  return null;
}

function variance(values: number[]): number {
  if (values.length <= 1) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sq = values.reduce((a, b) => a + (b - mean) * (b - mean), 0);
  return sq / (values.length - 1);
}

export function computeActiveFeatureIndices(
  xTrain: number[][],
  nearConstantVarianceThreshold: number = 1e-8
): number[] {
  const d = xTrain[0]?.length ?? 0;
  const idxs: number[] = [];
  for (let j = 0; j < d; j++) {
    const col = xTrain.map((r) => r[j] ?? 0);
    const v = variance(col);
    if (v > nearConstantVarianceThreshold) idxs.push(j);
  }
  return idxs;
}

export function balancedClassWeights(yTrain: number[]): number[] {
  const n = yTrain.length;
  const pos = yTrain.filter((y) => y === 1).length;
  const neg = n - pos;
  if (n === 0 || pos === 0 || neg === 0) return new Array(n).fill(1);
  const wPos = n / (2 * pos);
  const wNeg = n / (2 * neg);
  return yTrain.map((y) => (y === 1 ? wPos : wNeg));
}

export async function trainShadowModel(
  targetLabel: ShadowTargetLabel = "labelGoodDecision",
  options: TrainShadowOptions = {}
): Promise<TrainShadowResult> {
  const {
    funderAddress,
    candidateSource,
    limit = 2000,
    createdAfter,
    createdBefore,
    trainRatio = 0.8,
    debug = false,
    dropConstantFeatures = true,
    nearConstantVarianceThreshold = 1e-8,
    classWeighting = "balanced",
  } = options;

  const filterWithoutLabel: {
    funderAddress?: string;
    candidateSource?: string;
    createdAt?: { gte?: Date; lte?: Date };
  } = {};
  if (funderAddress) filterWithoutLabel.funderAddress = funderAddress.toLowerCase().trim();
  if (candidateSource) filterWithoutLabel.candidateSource = candidateSource;
  if (createdAfter) filterWithoutLabel.createdAt = { ...filterWithoutLabel.createdAt, gte: createdAfter };
  if (createdBefore) filterWithoutLabel.createdAt = { ...filterWithoutLabel.createdAt, lte: createdBefore };

  const where: typeof filterWithoutLabel & { [k: string]: unknown } = { ...filterWithoutLabel };
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
    let error = `Insufficient shadow training data (${valid.length} with ${targetLabel}). Need at least 10.`;
    if (targetLabel === "labelGoodDecision") {
      try {
        const [totalRows, with12h] = await Promise.all([
          prisma.mlShadowTrainingExample.count({ where: filterWithoutLabel }),
          prisma.mlShadowTrainingExample.count({
            where: { ...filterWithoutLabel, labelGoodDecision12h: { not: null } },
          }),
        ]);
        if (totalRows > 0) {
          error += ` MlShadowTrainingExample rows (same filters): ${totalRows}.`;
        }
        if (with12h >= 10) {
          error += ` ${with12h} rows have labelGoodDecision12h — try: --target labelGoodDecision12h (24h outcomeClassification requires evaluateShadowCandidates + 24h prices).`;
        } else if (totalRows === 0) {
          error +=
            " No MlShadowTrainingExample rows — run shadow_evaluation then POST /api/ops/ml-shadow-dataset (or wait for scheduled ml_shadow_dataset_build).";
        }
      } catch {
        /* keep short error */
      }
    }
    return {
      success: false,
      targetLabel,
      datasetSize: valid.length,
      trainCount: 0,
      validationCount: 0,
      error,
    };
  }

  const splitIdx = Math.max(1, Math.floor(valid.length * trainRatio));
  const trainRows = valid.slice(0, splitIdx);
  const valRows = valid.slice(splitIdx);

  const minCreatedAt = valid[0]?.createdAt ?? null;
  const maxCreatedAt = valid[valid.length - 1]?.createdAt ?? null;
  const strictJoinLagMs = 60 * 60 * 1000;
  const paperRows =
    minCreatedAt && maxCreatedAt
      ? await prisma.paperTrade.findMany({
          where: {
            entryTime: {
              gte: new Date(minCreatedAt.getTime() - strictJoinLagMs),
              lte: new Date(maxCreatedAt.getTime() + strictJoinLagMs),
            },
          },
          orderBy: [{ entryTime: "asc" }, { id: "asc" }],
          select: {
            metadataJson: true,
            assetId: true,
            side: true,
            entryTime: true,
            score: true,
            threshold: true,
            botType: true,
            entryPriceBand: true,
            entryPrice: true,
          },
        })
      : [];

  const paperByRecAssetSide = new Map<string, typeof paperRows>();
  for (const p of paperRows) {
    const recId = parseMetadataRecommendationId(p.metadataJson);
    if (!recId) continue;
    const k = `${recId}|${p.assetId}|${p.side}`;
    const arr = paperByRecAssetSide.get(k) ?? [];
    arr.push(p);
    paperByRecAssetSide.set(k, arr);
  }

  function paperContextForRow(r: (typeof valid)[0]): {
    scoreThresholdGap?: number;
    botType?: string | null;
    entryPriceBand?: string | null;
    probabilityBand?: string | null;
  } {
    if (!r.recommendationId) return {};
    const k = `${r.recommendationId}|${r.assetId}|${r.side}`;
    const options = paperByRecAssetSide.get(k) ?? [];
    const hit =
      options.find((p) => {
        const dt = Math.abs(p.entryTime.getTime() - r.createdAt.getTime());
        return dt <= strictJoinLagMs;
      }) ?? null;
    if (!hit) return {};
    const gap = Number.isFinite(hit.score - hit.threshold) ? hit.score - hit.threshold : undefined;
    const price = Number.isFinite(Number(hit.entryPrice)) ? Number(hit.entryPrice) : null;
    const probabilityBand =
      price == null ? null : price <= 0.2 ? "low" : price >= 0.8 ? "high" : "mid";
    return {
      scoreThresholdGap: gap,
      botType: hit.botType ?? null,
      entryPriceBand: hit.entryPriceBand ?? null,
      probabilityBand,
    };
  }

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

  const toInput = (r: (typeof valid)[0]) => {
    const paperCtx = paperContextForRow(r);
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
    outcomeBlockedVsAllowedVsSubmitted: r.outcomeBlockedVsAllowedVsSubmitted as "blocked" | "allowed" | "submitted" | null,
    momentum1hBps: (r as { momentum1hBps?: string | null }).momentum1hBps,
    momentum6hBps: (r as { momentum6hBps?: string | null }).momentum6hBps,
    volatility1hBps: (r as { volatility1hBps?: string | null }).volatility1hBps,
    volatility6hBps: (r as { volatility6hBps?: string | null }).volatility6hBps,
    distanceFromMid: (r as { distanceFromMid?: string | null }).distanceFromMid,
    timeToCloseHours: (r as { timeToCloseHours?: string | null }).timeToCloseHours,
    liquidityTrend: (r as { liquidityTrend?: string | null }).liquidityTrend,
    scoreThresholdGap: paperCtx.scoreThresholdGap ?? null,
    probabilityBand: paperCtx.probabilityBand ?? null,
    entryPriceBand: paperCtx.entryPriceBand ?? null,
    botType: paperCtx.botType ?? null,
    };
  };

  const XTrain = trainRows.map((r) => toShadowFeatureVector(toInput(r)));
  const yTrain = trainRows.map((r) => (r[targetLabel] === true ? 1 : 0));
  const XVal = valRows.map((r) => toShadowFeatureVector(toInput(r)));
  const yVal = valRows.map((r) => (r[targetLabel] === true ? 1 : 0));
  const activeFeatureIdxs = dropConstantFeatures ? computeActiveFeatureIndices(XTrain, nearConstantVarianceThreshold) : null;
  const featureIndices = activeFeatureIdxs && activeFeatureIdxs.length > 0
    ? activeFeatureIdxs
    : SHADOW_FEATURE_NAMES.map((_, idx) => idx);
  const featureNames = featureIndices.map((idx) => SHADOW_FEATURE_NAMES[idx] ?? `f${idx}`);
  const classWeights = classWeighting === "balanced" ? balancedClassWeights(yTrain) : undefined;

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
    featureIndices,
    sampleWeights: classWeights,
  });

  const valProbas = predictBatchLogistic(model, XVal);
  const metrics = computeMetrics(valProbas, yVal);
  const featureImportance = getLogisticFeatureImportance(model, featureNames);

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
    activeFeatureIdxs: model.activeFeatureIdxs ?? null,
    droppedFeatureCount: SHADOW_FEATURE_NAMES.length - featureIndices.length,
    classWeighting,
    classBalance: {
      trainPos: yTrain.filter((y) => y === 1).length,
      trainNeg: yTrain.filter((y) => y === 0).length,
    },
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
    trainingDiagnostics: {
      classWeighting,
      activeFeatureCount: featureIndices.length,
      droppedFeatureCount: SHADOW_FEATURE_NAMES.length - featureIndices.length,
    },
  };
}
