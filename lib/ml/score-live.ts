/**
 * Live scoring pipeline: load ACTIVE/APPROVED model, build features from current recommendations,
 * score out-of-sample, persist RecommendationMlScore and optionally update Recommendation.mlScore.
 * No autonomous trading; ML is advisory only.
 * TODO: Future blended ranking (heuristic + ML) after enough validated runs prove model quality.
 */

import { prisma } from "@/lib/db";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";
import { getNewsInfluenceByMarket } from "@/lib/news/recommendation-influence";
import { toFeatureVector } from "./features";
import { predictProbaLogistic, type LogisticRegressionModel } from "./baseline";

function parseNum(s: string | null | undefined): number {
  if (s == null || s === "") return 0;
  const n = parseFloat(String(s).trim());
  return Number.isFinite(n) ? n : 0;
}

export interface ScoreLiveResult {
  success: boolean;
  modelRunId?: string;
  scoredCount: number;
  error?: string;
}

function parseModelFromMetricsJson(metricsJson: string | null): LogisticRegressionModel | null {
  if (!metricsJson) return null;
  try {
    const parsed = JSON.parse(metricsJson) as Record<string, unknown>;
    const coef = parsed.coefficients as number[] | undefined;
    const intercept = parsed.intercept as number | undefined;
    const means = parsed.means as number[] | undefined;
    const stds = parsed.stds as number[] | undefined;
    if (!Array.isArray(coef) || typeof intercept !== "number" || !Array.isArray(means) || !Array.isArray(stds)) {
      return null;
    }
    return { coefficients: coef, intercept, means, stds };
  } catch {
    return null;
  }
}

/**
 * Load the latest ACTIVE or APPROVED recommendation ML model run.
 * Excludes shadow-trained models (modelType logistic_regression_shadow) so recommendation scoring stays recommendation-centric.
 */
export async function getActiveOrApprovedModel(funderAddress?: string): Promise<{ run: { id: string; featureSetName: string }; model: LogisticRegressionModel } | null> {
  const run = await prisma.mlModelRun.findFirst({
    where: { status: { in: ["ACTIVE", "APPROVED"] }, modelType: "logistic_regression" },
    orderBy: { updatedAt: "desc" },
  });
  if (!run?.metricsJson) return null;
  const model = parseModelFromMetricsJson(run.metricsJson);
  if (!model) return null;
  return { run: { id: run.id, featureSetName: run.featureSetName }, model };
}

/**
 * Build feature vector for a single live recommendation (signal + current portfolio/news context).
 * Uses only pre-trade features; no evaluation or forward-return data.
 */
function buildLiveFeatures(
  rec: { id: string; priorityScore: string; marketSignal: { marketPrice: string; fairPrice: string; edge: string; confidence: string; momentumComponent: string | null; liquidityComponent: string | null; portfolioComponent: string | null; behaviorComponent: string | null; themeExposurePct?: string | null; theme: string | null; outcome: string }; review: { status: string } | null },
  funder: string,
  themeExposurePct: number,
  topThemeConcentrationPct: number,
  hasExistingPosition: boolean,
  linkedNewsCount: number,
  newsFreshness: number,
  newsCredibility: number,
  noveltyScore: number,
  saturationScore: number,
  catalystBoost: number
): number[] {
  return toFeatureVector({
    marketPrice: rec.marketSignal.marketPrice,
    fairPrice: rec.marketSignal.fairPrice,
    edge: rec.marketSignal.edge,
    confidence: rec.marketSignal.confidence,
    momentumComponent: rec.marketSignal.momentumComponent,
    liquidityComponent: rec.marketSignal.liquidityComponent,
    portfolioComponent: rec.marketSignal.portfolioComponent,
    behaviorComponent: rec.marketSignal.behaviorComponent,
    themeExposurePct: String(themeExposurePct),
    topThemeConcentrationPct: String(topThemeConcentrationPct),
    hasExistingPosition,
    linkedNewsCount,
    newsFreshnessScore: String(newsFreshness),
    newsCredibilityScore: String(newsCredibility),
    noveltyScore: String(noveltyScore),
    saturationScore: String(saturationScore),
    catalystBoost: String(catalystBoost),
    signalType: null,
    action: null,
    reviewStatus: rec.review?.status ?? null,
    priorityScore: rec.priorityScore,
  });
}

/**
 * Score current live recommendations with the active/approved model and persist RecommendationMlScore.
 * Optionally updates Recommendation.mlScore/mlModelRunId as denormalized latest.
 */
export async function scoreLiveRecommendations(
  funderAddress?: string,
  options?: { updateDenormalizedScore?: boolean }
): Promise<ScoreLiveResult> {
  const funder = funderAddress?.toLowerCase() ?? (await getFunderForRecompute());
  if (!funder) {
    return { success: false, scoredCount: 0, error: "No funder address." };
  }

  const active = await getActiveOrApprovedModel(funder);
  if (!active) {
    return { success: false, scoredCount: 0, error: "No ACTIVE or APPROVED model run found. Train and approve a model first." };
  }

  const recs = await prisma.recommendation.findMany({
    where: { marketSignal: { funderAddress: funder } },
    include: { marketSignal: true, review: true },
  });
  if (recs.length === 0) {
    return { success: true, modelRunId: active.run.id, scoredCount: 0 };
  }

  const snapshot = await prisma.portfolioSnapshot.findFirst({
    where: { funderAddress: funder },
    orderBy: { createdAt: "desc" },
  });
  const totalExposure = snapshot ? parseNum(snapshot.totalOpenExposure) : 0;
  const topThemeConcentrationPct = snapshot ? parseNum(snapshot.topThemeConcentrationPct) : 0;

  const positions = await prisma.derivedPosition.findMany({ where: { funderAddress: funder } });
  const themeExposure = new Map<string, number>();
  for (const p of positions) {
    const theme = p.theme ?? "Other";
    themeExposure.set(theme, (themeExposure.get(theme) ?? 0) + parseNum(p.marketValue));
  }

  const marketIds = Array.from(new Set(recs.map((r) => r.marketSignal.marketId)));
  const newsByMarket = await getNewsInfluenceByMarket(marketIds);

  let scoredCount = 0;
  const updateDenormalized = options?.updateDenormalizedScore !== false;

  for (const rec of recs) {
    const theme = rec.marketSignal.theme ?? "Other";
    const themeExp = themeExposure.get(theme) ?? 0;
    const themeExposurePct = totalExposure > 0 ? (themeExp / totalExposure) * 100 : 0;

    const asset = await prisma.syncedAsset.findFirst({
      where: { syncedMarketId: rec.marketSignal.marketId, outcome: rec.marketSignal.outcome },
    });
    let hasExistingPosition = false;
    if (asset) {
      const pos = await prisma.derivedPosition.findUnique({
        where: { funderAddress_assetId: { funderAddress: funder, assetId: asset.tokenId } },
      });
      if (pos) hasExistingPosition = true;
    }

    const news = newsByMarket[rec.marketSignal.marketId];
    const linkedNewsCount = news?.linkedNewsCount ?? 0;
    const newsFreshness = 0.5;
    const newsCredibility = linkedNewsCount > 0 ? (news?.catalystBoost ?? 0) * 10 : 0;
    const noveltyScore = 0.5;
    const saturationScore = news?.saturationPenalty ? news.saturationPenalty * 5 : 0;
    const catalystBoost = news?.catalystBoost ?? 0;

    const vec = buildLiveFeatures(
      rec as Parameters<typeof buildLiveFeatures>[0],
      funder,
      themeExposurePct,
      topThemeConcentrationPct,
      hasExistingPosition,
      linkedNewsCount,
      newsFreshness,
      newsCredibility,
      noveltyScore,
      saturationScore,
      catalystBoost
    );
    const score = predictProbaLogistic(active.model, vec);

    try {
      await prisma.recommendationMlScore.upsert({
        where: {
          recommendationId_mlModelRunId: { recommendationId: rec.id, mlModelRunId: active.run.id },
        },
        create: {
          recommendationId: rec.id,
          mlModelRunId: active.run.id,
          score: String(score),
          featureSetName: active.run.featureSetName,
          scoredAt: new Date(),
        },
        update: {
          score: String(score),
          scoredAt: new Date(),
        },
      });
      scoredCount++;
      if (updateDenormalized) {
        await prisma.recommendation.update({
          where: { id: rec.id },
          data: { mlScore: String(score), mlModelRunId: active.run.id },
        });
      }
    } catch (e) {
      // skip on conflict or missing run
    }
  }

  return {
    success: true,
    modelRunId: active.run.id,
    scoredCount,
  };
}
