import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * GET /api/ml/evaluation-summary
 * Summary of ML runs: latest run metrics, time-split validation, active model, live-scored count.
 */
export async function GET() {
  try {
    const [latestRun, activeRun, exampleCount, liveScoredCount, latestScoring] = await Promise.all([
      prisma.mlModelRun.findFirst({ orderBy: { createdAt: "desc" } }),
      prisma.mlModelRun.findFirst({ where: { status: "ACTIVE" }, orderBy: { updatedAt: "desc" } }),
      prisma.mlTrainingExample.count(),
      prisma.recommendationMlScore.count(),
      prisma.recommendationMlScore.findFirst({ orderBy: { scoredAt: "desc" }, select: { scoredAt: true } }),
    ]);

    let metrics = null;
    let comparison = null;
    let calibration = null;
    let featureImportance = null;
    if (latestRun?.metricsJson) {
      try {
        const parsed = JSON.parse(latestRun.metricsJson) as Record<string, unknown>;
        metrics = parsed.accuracy != null ? {
          accuracy: parsed.accuracy,
          precision: parsed.precision,
          recall: parsed.recall,
          f1: parsed.f1,
          rocAuc: parsed.rocAuc,
          threshold: parsed.threshold,
          tp: parsed.tp,
          fp: parsed.fp,
          tn: parsed.tn,
          fn: parsed.fn,
        } : null;
        comparison = parsed.comparison ?? null;
        calibration = parsed.calibrationMae != null ? { mae: parsed.calibrationMae } : null;
        if (Array.isArray(parsed.coefficients)) {
          const names = [
            "marketPrice", "fairPrice", "edge", "confidence", "momentumComponent", "liquidityComponent",
            "portfolioComponent", "behaviorComponent", "themeExposurePct", "topThemeConcentrationPct",
            "hasExistingPosition", "linkedNewsCount", "newsFreshnessScore", "newsCredibilityScore",
            "noveltyScore", "saturationScore", "catalystBoost", "signalTypeEnc", "actionEnc", "reviewStatusEnc",
            "priorityScore",
          ];
          featureImportance = (parsed.coefficients as number[]).map((coef, i) => ({
            name: names[i] ?? `f${i}`,
            coefficient: coef,
            absCoefficient: Math.abs(coef),
          })).sort((a, b) => b.absCoefficient - a.absCoefficient).slice(0, 15);
        }
      } catch {
        // ignore parse errors
      }
    }

    return NextResponse.json({
      latestRun: latestRun
        ? {
            id: latestRun.id,
            modelType: latestRun.modelType,
            targetLabel: latestRun.targetLabel,
            featureSetName: latestRun.featureSetName,
            status: latestRun.status ?? "TRAINED",
            trainCount: latestRun.trainCount,
            validationCount: latestRun.validationCount,
            trainedFrom: latestRun.trainedFrom?.toISOString() ?? null,
            trainedTo: latestRun.trainedTo?.toISOString() ?? null,
            validatedFrom: latestRun.validatedFrom?.toISOString() ?? null,
            validatedTo: latestRun.validatedTo?.toISOString() ?? null,
            leakageCheckPassed: latestRun.leakageCheckPassed,
            createdAt: latestRun.createdAt.toISOString(),
          }
        : null,
      activeModel: activeRun
        ? {
            id: activeRun.id,
            status: activeRun.status,
            targetLabel: activeRun.targetLabel,
            featureSetName: activeRun.featureSetName,
          }
        : null,
      datasetSize: exampleCount,
      liveScoredCount,
      latestScoringTime: latestScoring?.scoredAt?.toISOString() ?? null,
      metrics,
      comparison,
      calibration,
      featureImportance,
    });
  } catch (error) {
    console.error("[GET /api/ml/evaluation-summary]", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to get summary" },
      { status: 500 }
    );
  }
}
