/**
 * ML training dataset builder from recommendations, signals, evaluations, portfolio, and news.
 * One example per recommendation; forward returns and labels from RecommendationEvaluation.
 * No autonomous trading; dataset for baseline model training only.
 */

import { prisma } from "@/lib/db";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";
import { getNewsInfluenceByMarket } from "@/lib/news/recommendation-influence";
import { toFeatureVector, FEATURE_NAMES } from "./features";

function parseNum(s: string | null | undefined): number {
  if (s == null || s === "") return 0;
  const n = parseFloat(String(s).trim());
  return Number.isFinite(n) ? n : 0;
}

function toStr(n: number): string {
  return String(Number.isFinite(n) ? n : 0);
}

export interface BuildDatasetResult {
  examplesCreated: number;
  examplesSkipped: number;
  errors: string[];
}

/**
 * Build training examples from recommendations that have at least one evaluation with 6h or 24h outcome.
 * Persists MlTrainingExample (upsert by recommendationId). Uses current portfolio/news state as proxy for context.
 */
export async function buildDataset(funderAddress?: string): Promise<BuildDatasetResult> {
  const errors: string[] = [];
  const funder = funderAddress?.toLowerCase() ?? (await getFunderForRecompute());
  if (!funder) {
    return { examplesCreated: 0, examplesSkipped: 0, errors: ["No funder address."] };
  }

  const recs = await prisma.recommendation.findMany({
    where: { marketSignal: { funderAddress: funder } },
    include: {
      marketSignal: true,
      review: true,
      evaluations: { orderBy: { evaluatedAt: "desc" }, take: 1 },
    },
  });

  const snapshot = await prisma.portfolioSnapshot.findFirst({
    where: { funderAddress: funder },
    orderBy: { createdAt: "desc" },
  });
  const totalExposure = snapshot ? parseNum(snapshot.totalOpenExposure) : 0;
  const topConcentrationPct = snapshot ? parseNum(snapshot.topConcentrationPct) : 0;

  const positions = await prisma.derivedPosition.findMany({
    where: { funderAddress: funder },
  });
  const themeExposure = new Map<string, number>();
  for (const p of positions) {
    const theme = p.theme ?? "Other";
    themeExposure.set(theme, (themeExposure.get(theme) ?? 0) + parseNum(p.marketValue));
  }
  const marketIds = Array.from(new Set(recs.map((r) => r.marketSignal.marketId)));
  const newsByMarket = await getNewsInfluenceByMarket(marketIds);

  let created = 0;
  let skipped = 0;

  for (const rec of recs) {
    const eval_ = rec.evaluations[0];
    const has6h = eval_?.priceChange6h != null && eval_?.priceChange6h !== "";
    const has24h = eval_?.priceChange24h != null && eval_?.priceChange24h !== "";
    if (!has6h && !has24h) {
      skipped++;
      continue;
    }

    const theme = rec.marketSignal.theme ?? "Other";
    const themeExp = themeExposure.get(theme) ?? 0;
    const themeExposurePct = totalExposure > 0 ? (themeExp / totalExposure) * 100 : 0;

    const asset = await prisma.syncedAsset.findFirst({
      where: { syncedMarketId: rec.marketSignal.marketId, outcome: rec.marketSignal.outcome },
    });
    let hasExistingPosition = false;
    let reservedExposure = 0;
    if (asset) {
      const pos = await prisma.derivedPosition.findUnique({
        where: { funderAddress_assetId: { funderAddress: funder, assetId: asset.tokenId } },
      });
      if (pos) {
        hasExistingPosition = true;
        reservedExposure = parseNum(pos.reservedOrderValue);
      }
    }

    const news = newsByMarket[rec.marketSignal.marketId];
    const linkedNewsCount = news?.linkedNewsCount ?? 0;
    const newsFreshness = 0.5;
    const newsCredibility = linkedNewsCount > 0 ? (news?.catalystBoost ?? 0) * 10 : 0;
    const noveltyScore = 0.5;
    const saturationScore = news?.saturationPenalty ? news.saturationPenalty * 5 : 0;
    const catalystBoost = news?.catalystBoost ?? 0;

    const forwardReturn1h = eval_?.priceChange1h != null ? parseNum(eval_.priceChange1h) : null;
    const forwardReturn6h = eval_?.priceChange6h != null ? parseNum(eval_.priceChange6h) : null;
    const forwardReturn24h = eval_?.priceChange24h != null ? parseNum(eval_.priceChange24h) : null;
    const labelPositive1h = eval_?.wasPositive ?? (forwardReturn1h != null ? forwardReturn1h > 0 : null);
    const labelPositive6h = eval_?.wasPositive ?? (forwardReturn6h != null ? forwardReturn6h > 0 : null);
    const labelPositive24h = eval_?.wasPositive ?? (forwardReturn24h != null ? forwardReturn24h > 0 : null);

    try {
      await prisma.mlTrainingExample.upsert({
        where: { recommendationId: rec.id },
        create: {
          recommendationId: rec.id,
          funderAddress: funder,
          signalType: rec.marketSignal.signalType,
          action: rec.action,
          reviewStatus: rec.review?.status ?? null,
          category: rec.marketSignal.category,
          theme: rec.marketSignal.theme,
          marketPrice: rec.marketSignal.marketPrice,
          fairPrice: rec.marketSignal.fairPrice,
          edge: rec.marketSignal.edge,
          confidence: rec.marketSignal.confidence,
          momentumComponent: rec.marketSignal.momentumComponent,
          liquidityComponent: rec.marketSignal.liquidityComponent,
          crowdingComponent: rec.marketSignal.crowdingComponent,
          portfolioComponent: rec.marketSignal.portfolioComponent,
          behaviorComponent: rec.marketSignal.behaviorComponent,
          longshotComponent: rec.marketSignal.longshotComponent,
          timeComponent: rec.marketSignal.timeComponent,
          themeExposurePct: toStr(themeExposurePct),
          topConcentrationPct: toStr(topConcentrationPct),
          hasExistingPosition,
          reservedExposure: toStr(reservedExposure),
          linkedNewsCount,
          newsFreshnessScore: toStr(newsFreshness),
          newsCredibilityScore: toStr(newsCredibility),
          noveltyScore: toStr(noveltyScore),
          saturationScore: toStr(saturationScore),
          catalystBoost: toStr(catalystBoost),
          forwardReturn1h: forwardReturn1h != null ? toStr(forwardReturn1h) : null,
          forwardReturn6h: forwardReturn6h != null ? toStr(forwardReturn6h) : null,
          forwardReturn24h: forwardReturn24h != null ? toStr(forwardReturn24h) : null,
          labelPositive1h,
          labelPositive6h: labelPositive6h ?? null,
          labelPositive24h: labelPositive24h ?? null,
          priorityScore: rec.priorityScore,
        },
        update: {
          signalType: rec.marketSignal.signalType,
          action: rec.action,
          reviewStatus: rec.review?.status ?? null,
          marketPrice: rec.marketSignal.marketPrice,
          fairPrice: rec.marketSignal.fairPrice,
          edge: rec.marketSignal.edge,
          confidence: rec.marketSignal.confidence,
          themeExposurePct: toStr(themeExposurePct),
          topConcentrationPct: toStr(topConcentrationPct),
          hasExistingPosition,
          linkedNewsCount,
          newsFreshnessScore: toStr(newsFreshness),
          newsCredibilityScore: toStr(newsCredibility),
          noveltyScore: toStr(noveltyScore),
          saturationScore: toStr(saturationScore),
          catalystBoost: toStr(catalystBoost),
          forwardReturn1h: forwardReturn1h != null ? toStr(forwardReturn1h) : null,
          forwardReturn6h: forwardReturn6h != null ? toStr(forwardReturn6h) : null,
          forwardReturn24h: forwardReturn24h != null ? toStr(forwardReturn24h) : null,
          labelPositive1h,
          labelPositive6h: labelPositive6h ?? null,
          labelPositive24h: labelPositive24h ?? null,
          priorityScore: rec.priorityScore,
        },
      });
      created++;
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  return { examplesCreated: created, examplesSkipped: skipped, errors };
}

/**
 * Load training rows for a target label. Returns X (features), y (labels), recommendationIds.
 */
export async function loadTrainingData(
  funderAddress: string,
  targetLabel: "labelPositive6h" | "labelPositive24h"
): Promise<{ X: number[][]; y: number[]; recommendationIds: string[] }> {
  const where: { funderAddress: string; labelPositive6h?: { not: null }; labelPositive24h?: { not: null } } = {
    funderAddress,
  };
  if (targetLabel === "labelPositive6h") where.labelPositive6h = { not: null };
  else where.labelPositive24h = { not: null };

  const examples = await prisma.mlTrainingExample.findMany({
    where,
  });

  const X: number[][] = [];
  const y: number[] = [];
  const recommendationIds: string[] = [];

  for (const ex of examples) {
    const label = targetLabel === "labelPositive6h" ? ex.labelPositive6h : ex.labelPositive24h;
    if (label == null) continue;
    const vec = toFeatureVector({
      marketPrice: ex.marketPrice,
      fairPrice: ex.fairPrice,
      edge: ex.edge,
      confidence: ex.confidence,
      momentumComponent: ex.momentumComponent,
      liquidityComponent: ex.liquidityComponent,
      portfolioComponent: ex.portfolioComponent,
      behaviorComponent: ex.behaviorComponent,
      themeExposurePct: ex.themeExposurePct,
      topConcentrationPct: ex.topConcentrationPct,
      hasExistingPosition: ex.hasExistingPosition,
      linkedNewsCount: ex.linkedNewsCount,
      newsFreshnessScore: ex.newsFreshnessScore,
      newsCredibilityScore: ex.newsCredibilityScore,
      noveltyScore: ex.noveltyScore,
      saturationScore: ex.saturationScore,
      catalystBoost: ex.catalystBoost,
      signalType: ex.signalType,
      action: ex.action,
      reviewStatus: ex.reviewStatus,
      priorityScore: ex.priorityScore ?? "",
    });
    X.push(vec);
    y.push(label ? 1 : 0);
    recommendationIds.push(ex.recommendationId);
  }

  return { X, y, recommendationIds };
}

export interface TimeSplitResult {
  XTrain: number[][];
  yTrain: number[];
  trainRecommendationIds: string[];
  XVal: number[][];
  yVal: number[];
  valRecommendationIds: string[];
  trainedFrom: Date | null;
  trainedTo: Date | null;
  validatedFrom: Date | null;
  validatedTo: Date | null;
  trainCreatedAts: Date[];
  valCreatedAts: Date[];
}

/**
 * Load training data sorted by createdAt (oldest first) and split by time for train/validation.
 * Train on oldest slice, validate on newest. Prevents future leakage.
 */
export async function loadTrainingDataTimeSplit(
  funderAddress: string,
  targetLabel: "labelPositive6h" | "labelPositive24h",
  trainRatio: number = 0.8
): Promise<TimeSplitResult> {
  const where: { funderAddress: string; labelPositive6h?: { not: null }; labelPositive24h?: { not: null } } = {
    funderAddress,
  };
  if (targetLabel === "labelPositive6h") where.labelPositive6h = { not: null };
  else where.labelPositive24h = { not: null };

  const examples = await prisma.mlTrainingExample.findMany({
    where,
    orderBy: { createdAt: "asc" },
  });

  const valid = examples.filter((ex) => {
    const label = targetLabel === "labelPositive6h" ? ex.labelPositive6h : ex.labelPositive24h;
    return label != null;
  });
  if (valid.length === 0) {
    return {
      XTrain: [], yTrain: [], trainRecommendationIds: [],
      XVal: [], yVal: [], valRecommendationIds: [],
      trainedFrom: null, trainedTo: null, validatedFrom: null, validatedTo: null,
      trainCreatedAts: [], valCreatedAts: [],
    };
  }

  const splitIdx = Math.max(1, Math.floor(valid.length * trainRatio));
  const trainExamples = valid.slice(0, splitIdx);
  const valExamples = valid.slice(splitIdx);

  const build = (list: typeof valid) => {
    const X: number[][] = [];
    const y: number[] = [];
    const ids: string[] = [];
    const dates: Date[] = [];
    for (const ex of list) {
      const label = targetLabel === "labelPositive6h" ? ex.labelPositive6h : ex.labelPositive24h;
      if (label == null) continue;
      X.push(toFeatureVector({
        marketPrice: ex.marketPrice,
        fairPrice: ex.fairPrice,
        edge: ex.edge,
        confidence: ex.confidence,
        momentumComponent: ex.momentumComponent,
        liquidityComponent: ex.liquidityComponent,
        portfolioComponent: ex.portfolioComponent,
        behaviorComponent: ex.behaviorComponent,
        themeExposurePct: ex.themeExposurePct,
        topConcentrationPct: ex.topConcentrationPct,
        hasExistingPosition: ex.hasExistingPosition,
        linkedNewsCount: ex.linkedNewsCount,
        newsFreshnessScore: ex.newsFreshnessScore,
        newsCredibilityScore: ex.newsCredibilityScore,
        noveltyScore: ex.noveltyScore,
        saturationScore: ex.saturationScore,
        catalystBoost: ex.catalystBoost,
        signalType: ex.signalType,
        action: ex.action,
        reviewStatus: ex.reviewStatus,
        priorityScore: ex.priorityScore ?? "",
      }));
      y.push(label ? 1 : 0);
      ids.push(ex.recommendationId);
      dates.push(ex.createdAt);
    }
    return { X, y, ids, dates };
  };

  const train = build(trainExamples);
  const val = build(valExamples);

  const trainCreatedAts = train.dates;
  const valCreatedAts = val.dates;
  const trainedFrom = trainCreatedAts.length > 0 ? new Date(Math.min(...trainCreatedAts.map((d) => d.getTime()))) : null;
  const trainedTo = trainCreatedAts.length > 0 ? new Date(Math.max(...trainCreatedAts.map((d) => d.getTime()))) : null;
  const validatedFrom = valCreatedAts.length > 0 ? new Date(Math.min(...valCreatedAts.map((d) => d.getTime()))) : null;
  const validatedTo = valCreatedAts.length > 0 ? new Date(Math.max(...valCreatedAts.map((d) => d.getTime()))) : null;

  return {
    XTrain: train.X,
    yTrain: train.y,
    trainRecommendationIds: train.ids,
    XVal: val.X,
    yVal: val.y,
    valRecommendationIds: val.ids,
    trainedFrom: trainedFrom ?? null,
    trainedTo: trainedTo ?? null,
    validatedFrom: validatedFrom ?? null,
    validatedTo: validatedTo ?? null,
    trainCreatedAts,
    valCreatedAts,
  };
}

/**
 * Optional: rolling walk-forward validation splits (time-ordered).
 * Returns up to maxSplits (train, val) pairs; each val window is the next chunk after train.
 * Use for cross-validation style metrics over time. Caller trains on train set and evaluates on val set per split.
 */
export async function loadTrainingDataWalkForward(
  funderAddress: string,
  targetLabel: "labelPositive6h" | "labelPositive24h",
  options?: { trainRatio?: number; maxSplits?: number }
): Promise<Array<{ XTrain: number[][]; yTrain: number[]; XVal: number[][]; yVal: number[]; trainedTo: Date | null; validatedFrom: Date | null; validatedTo: Date | null }>> {
  const ratio = options?.trainRatio ?? 0.8;
  const maxSplits = options?.maxSplits ?? 3;
  const full = await loadTrainingDataTimeSplit(funderAddress, targetLabel, ratio);
  if (full.XTrain.length + full.XVal.length < 10) return [];

  const splits: Array<{ XTrain: number[][]; yTrain: number[]; XVal: number[][]; yVal: number[]; trainedTo: Date | null; validatedFrom: Date | null; validatedTo: Date | null }> = [];
  splits.push({
    XTrain: full.XTrain,
    yTrain: full.yTrain,
    XVal: full.XVal,
    yVal: full.yVal,
    trainedTo: full.trainedTo,
    validatedFrom: full.validatedFrom,
    validatedTo: full.validatedTo,
  });
  if (maxSplits <= 1) return splits;

  const where: { funderAddress: string; labelPositive6h?: { not: null }; labelPositive24h?: { not: null } } = {
    funderAddress,
  };
  if (targetLabel === "labelPositive6h") where.labelPositive6h = { not: null };
  else where.labelPositive24h = { not: null };
  const examples = await prisma.mlTrainingExample.findMany({
    where,
    orderBy: { createdAt: "asc" },
  });
  const valid = examples.filter((ex) => (targetLabel === "labelPositive6h" ? ex.labelPositive6h : ex.labelPositive24h) != null);
  if (valid.length < 20) return splits;

  const chunkSize = Math.max(5, Math.floor(valid.length / (maxSplits + 1)));
  for (let s = 1; s < maxSplits; s++) {
    const trainEnd = Math.min(valid.length, chunkSize * (s + 1));
    const trainExamples = valid.slice(0, trainEnd);
    const valExamples = valid.slice(trainEnd, trainEnd + chunkSize);
    if (trainExamples.length < 5 || valExamples.length < 2) break;
    const build = (list: typeof valid) => {
      const X: number[][] = [];
      const y: number[] = [];
      for (const ex of list) {
        const label = targetLabel === "labelPositive6h" ? ex.labelPositive6h : ex.labelPositive24h;
        if (label == null) continue;
        X.push(toFeatureVector({
          marketPrice: ex.marketPrice,
          fairPrice: ex.fairPrice,
          edge: ex.edge,
          confidence: ex.confidence,
          momentumComponent: ex.momentumComponent,
          liquidityComponent: ex.liquidityComponent,
          portfolioComponent: ex.portfolioComponent,
          behaviorComponent: ex.behaviorComponent,
          themeExposurePct: ex.themeExposurePct,
          topConcentrationPct: ex.topConcentrationPct,
          hasExistingPosition: ex.hasExistingPosition,
          linkedNewsCount: ex.linkedNewsCount,
          newsFreshnessScore: ex.newsFreshnessScore,
          newsCredibilityScore: ex.newsCredibilityScore,
          noveltyScore: ex.noveltyScore,
          saturationScore: ex.saturationScore,
          catalystBoost: ex.catalystBoost,
          signalType: ex.signalType,
          action: ex.action,
          reviewStatus: ex.reviewStatus,
          priorityScore: ex.priorityScore ?? "",
        }));
        y.push(label ? 1 : 0);
      }
      return { X, y };
    };
    const train = build(trainExamples);
    const val = build(valExamples);
    const trainDates = trainExamples.map((e) => e.createdAt.getTime());
    const valDates = valExamples.map((e) => e.createdAt.getTime());
    splits.push({
      XTrain: train.X,
      yTrain: train.y,
      XVal: val.X,
      yVal: val.y,
      trainedTo: trainDates.length > 0 ? new Date(Math.max(...trainDates)) : null,
      validatedFrom: valDates.length > 0 ? new Date(Math.min(...valDates)) : null,
      validatedTo: valDates.length > 0 ? new Date(Math.max(...valDates)) : null,
    });
  }
  return splits;
}

/**
 * Export dataset as JSON (array of feature objects + labels). For debugging or external training.
 */
export async function exportDatasetAsJson(
  funderAddress: string,
  targetLabel: "labelPositive6h" | "labelPositive24h"
): Promise<{ rows: Array<Record<string, number | boolean | string>>; featureNames: string[] }> {
  const { X, y, recommendationIds } = await loadTrainingData(funderAddress, targetLabel);
  const rows: Array<Record<string, number | boolean | string>> = [];
  for (let i = 0; i < X.length; i++) {
    const row: Record<string, number | boolean | string> = {
      label: y[i] === 1,
      recommendationId: recommendationIds[i] ?? "",
    };
    FEATURE_NAMES.forEach((name, j) => {
      row[name] = X[i][j] ?? 0;
    });
    rows.push(row);
  }
  return { rows, featureNames: FEATURE_NAMES };
}
