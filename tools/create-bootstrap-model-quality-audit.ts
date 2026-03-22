import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import { toShadowFeatureVector } from "../lib/ml/shadow-train/features";
import { SHADOW_FEATURE_NAMES } from "../lib/ml/shadow-train/features";
import { predictBatchLogistic, type LogisticRegressionModel } from "../lib/ml/baseline";
import { computeMetrics } from "../lib/ml/evaluate";

const DUMP_DIR = path.join(process.cwd(), "dump");
const JSON_PATH = path.join(DUMP_DIR, "bootstrap-model-quality-audit.json");
const MD_PATH = path.join(DUMP_DIR, "bootstrap-model-quality-audit.md");
const SHADOW_MODEL_TYPE = "logistic_regression_shadow";

function parseModel(metricsJson: string | null): LogisticRegressionModel | null {
  if (!metricsJson) return null;
  try {
    const p = JSON.parse(metricsJson) as {
      coefficients?: number[];
      intercept?: number;
      means?: number[];
      stds?: number[];
      activeFeatureIdxs?: number[];
    };
    if (!Array.isArray(p.coefficients) || typeof p.intercept !== "number") return null;
    if (!Array.isArray(p.means) || !Array.isArray(p.stds)) return null;
    return {
      coefficients: p.coefficients,
      intercept: p.intercept,
      means: p.means,
      stds: p.stds,
      activeFeatureIdxs: Array.isArray(p.activeFeatureIdxs) ? p.activeFeatureIdxs : undefined,
    };
  } catch {
    return null;
  }
}

function q(arr: number[], p: number): number | null {
  if (arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(s.length - 1, Math.floor((s.length - 1) * p)));
  return s[idx];
}

function summarizeScores(scores: number[]): {
  n: number;
  mean: number | null;
  min: number | null;
  p25: number | null;
  p50: number | null;
  p75: number | null;
  max: number | null;
} {
  if (scores.length === 0) {
    return { n: 0, mean: null, min: null, p25: null, p50: null, p75: null, max: null };
  }
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  return {
    n: scores.length,
    mean,
    min: q(scores, 0),
    p25: q(scores, 0.25),
    p50: q(scores, 0.5),
    p75: q(scores, 0.75),
    max: q(scores, 1),
  };
}

function variance(values: number[]): number {
  if (values.length <= 1) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sq = values.reduce((a, b) => a + (b - mean) * (b - mean), 0);
  return sq / (values.length - 1);
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

  try {
    const run = await prisma.mlModelRun.findFirst({
      where: { modelType: SHADOW_MODEL_TYPE, targetLabel: "labelGoodDecision12h", status: "TRAINED" },
      orderBy: { createdAt: "desc" },
    });
    if (!run) {
      await fs.writeFile(
        JSON_PATH,
        JSON.stringify({ generatedAt, error: "no_trained_labelGoodDecision12h_run_found" }, null, 2),
        "utf8"
      );
      await fs.writeFile(
        MD_PATH,
        `# Bootstrap model quality audit\n\nGenerated: ${generatedAt}\n\n- No TRAINED labelGoodDecision12h run found.\n`,
        "utf8"
      );
      return;
    }

    const model = parseModel(run.metricsJson);
    if (!model) {
      throw new Error("trained_run_metrics_unparseable");
    }

    const rows = await prisma.mlShadowTrainingExample.findMany({
      where: { labelGoodDecision12h: { not: null } },
      orderBy: { createdAt: "asc" },
      take: (run.trainCount ?? 0) + (run.validationCount ?? 0) || 500,
    });
    const valid = rows.filter((r) => r.labelGoodDecision12h === true || r.labelGoodDecision12h === false);
    const splitIdx = Math.max(1, run.trainCount ?? Math.floor(valid.length * 0.8));
    const trainRows = valid.slice(0, splitIdx);
    const valRows = valid.slice(splitIdx);

    const yTrain = trainRows.map((r) => (r.labelGoodDecision12h === true ? 1 : 0));
    const yVal = valRows.map((r) => (r.labelGoodDecision12h === true ? 1 : 0));
    const xTrain = trainRows.map((r) => toShadowFeatureVector(toFeatureInput(r)));
    const xVal = valRows.map((r) => toShadowFeatureVector(toFeatureInput(r)));
    const valScores = predictBatchLogistic(model, xVal);
    const metrics = computeMetrics(valScores, yVal);
    const invMetrics = computeMetrics(valScores.map((s) => 1 - s), yVal);

    const posScores = valScores.filter((_, i) => yVal[i] === 1);
    const negScores = valScores.filter((_, i) => yVal[i] === 0);
    const predPos = valScores.filter((s) => s >= 0.5).length;
    const predPosRate = valScores.length > 0 ? predPos / valScores.length : 0;

    const perFeatureVar = xTrain.length
      ? xTrain[0].map((_, j) => variance(xTrain.map((r) => r[j] ?? 0)))
      : [];
    const constantFeatures = perFeatureVar
      .map((v, i) => ({ idx: i, variance: v }))
      .filter((x) => x.variance === 0);
    const nearConstantFeatures = perFeatureVar
      .map((v, i) => ({ idx: i, variance: v }))
      .filter((x) => x.variance > 0 && x.variance < 1e-8);

    const trainPos = yTrain.filter((y) => y === 1).length;
    const trainNeg = yTrain.length - trainPos;
    const valPos = yVal.filter((y) => y === 1).length;
    const valNeg = yVal.length - valPos;

    const effectivelyOneClass = predPosRate > 0.95 || predPosRate < 0.05;
    const splitDegenerate = Math.abs((trainPos / Math.max(1, yTrain.length)) - (valPos / Math.max(1, yVal.length))) > 0.25;
    const orientationSuspicious = invMetrics.rocAuc - metrics.rocAuc > 0.15;

    const recommendedNextStep = orientationSuspicious
      ? "Inspect target polarity and feature-target alignment on recent rows; inversion signal suggests model ranking opposite to target."
      : effectivelyOneClass || splitDegenerate
        ? "Increase and rebalance bootstrap sample before activation (more 12h-labeled rows and broader temporal coverage), then retrain."
        : "No metric bug found; improve feature signal/data quality for 12h target before activation.";

    const report = {
      generatedAt,
      run: {
        id: run.id,
        status: run.status,
        targetLabel: run.targetLabel,
        createdAt: run.createdAt.toISOString(),
        trainCount: run.trainCount,
        validationCount: run.validationCount,
      },
      classBalance: {
        train: { total: yTrain.length, pos: trainPos, neg: trainNeg, posRate: yTrain.length ? trainPos / yTrain.length : null },
        validation: { total: yVal.length, pos: valPos, neg: valNeg, posRate: yVal.length ? valPos / yVal.length : null },
      },
      confusionMatrixAt05: {
        tp: metrics.tp,
        fp: metrics.fp,
        tn: metrics.tn,
        fn: metrics.fn,
      },
      scoreDistributionByClass: {
        positiveClass: summarizeScores(posScores),
        negativeClass: summarizeScores(negScores),
      },
      predictionBehavior: {
        predictedPositiveRateAt05: predPosRate,
        effectivelyPredictingOneClass: effectivelyOneClass,
      },
      aucOrientationCheck: {
        aucUsingScoreAsPositiveProb: metrics.rocAuc,
        aucUsingInvertedScore: invMetrics.rocAuc,
        positiveClassDefinition: "y=1 means labelGoodDecision12h=true",
        orientationSuspicious,
      },
      featureVariance: {
        constantFeatureCount: constantFeatures.length,
        nearConstantFeatureCount: nearConstantFeatures.length,
        constantFeatureIndices: constantFeatures.slice(0, 20),
        nearConstantFeatureIndices: nearConstantFeatures.slice(0, 20),
        constantFeatureNames: constantFeatures.slice(0, 20).map((x) => SHADOW_FEATURE_NAMES[x.idx] ?? `f${x.idx}`),
        nearConstantFeatureNames: nearConstantFeatures
          .slice(0, 20)
          .map((x) => SHADOW_FEATURE_NAMES[x.idx] ?? `f${x.idx}`),
      },
      splitDiagnostics: {
        usesTimeOrdering: true,
        trainToValidationPosRateShift:
          (yTrain.length ? trainPos / yTrain.length : 0) - (yVal.length ? valPos / yVal.length : 0),
        degenerateValidationSlice: splitDegenerate,
      },
      conclusion: {
        primaryBlocker: orientationSuspicious
          ? "possible_orientation_or_target_polarity_issue"
          : effectivelyOneClass
            ? "trivial_classifier_behavior"
            : splitDegenerate
              ? "degenerate_time_split"
              : "weak_feature_signal_or_noisy_target",
        metricBugProven: false,
        recommendedSmallestSafeNextStep: recommendedNextStep,
      },
    };

    await fs.writeFile(JSON_PATH, JSON.stringify(report, null, 2), "utf8");

    const md: string[] = [];
    md.push("# Bootstrap model quality audit");
    md.push("");
    md.push(`Generated: ${generatedAt}`);
    md.push("");
    md.push("## Run audited");
    md.push(`- Run: \`${run.id}\``);
    md.push(`- Target: \`${run.targetLabel}\``);
    md.push(`- Status: \`${run.status}\``);
    md.push("");
    md.push("## Class balance");
    md.push(`- Train pos/neg: **${trainPos}/${trainNeg}** (posRate=${(report.classBalance.train.posRate ?? 0).toFixed(4)})`);
    md.push(`- Validation pos/neg: **${valPos}/${valNeg}** (posRate=${(report.classBalance.validation.posRate ?? 0).toFixed(4)})`);
    md.push("");
    md.push("## Confusion matrix (threshold=0.5)");
    md.push(`- TP=${metrics.tp}, FP=${metrics.fp}, TN=${metrics.tn}, FN=${metrics.fn}`);
    md.push("");
    md.push("## Score distribution by class");
    md.push(`- Positive mean/p50: ${(report.scoreDistributionByClass.positiveClass.mean ?? 0).toFixed(4)} / ${(report.scoreDistributionByClass.positiveClass.p50 ?? 0).toFixed(4)}`);
    md.push(`- Negative mean/p50: ${(report.scoreDistributionByClass.negativeClass.mean ?? 0).toFixed(4)} / ${(report.scoreDistributionByClass.negativeClass.p50 ?? 0).toFixed(4)}`);
    md.push("");
    md.push("## One-class behavior");
    md.push(`- Predicted positive rate @0.5: **${predPosRate.toFixed(4)}**`);
    md.push(`- Effectively one class: **${effectivelyOneClass}**`);
    md.push("");
    md.push("## AUC orientation check");
    md.push(`- AUC(score): **${metrics.rocAuc.toFixed(4)}**`);
    md.push(`- AUC(1-score): **${invMetrics.rocAuc.toFixed(4)}**`);
    md.push(`- Orientation suspicious: **${orientationSuspicious}**`);
    md.push("");
    md.push("## Feature variance");
    md.push(`- Constant features: **${constantFeatures.length}**`);
    md.push(`- Near-constant features: **${nearConstantFeatures.length}**`);
    if (constantFeatures.length > 0) {
      md.push(`- Sample constant feature names: ${report.featureVariance.constantFeatureNames.slice(0, 10).join(", ")}`);
    }
    md.push("");
    md.push("## Split diagnostics");
    md.push(`- Degenerate validation slice: **${splitDegenerate}**`);
    md.push(`- Train->Val pos-rate shift: **${report.splitDiagnostics.trainToValidationPosRateShift.toFixed(4)}**`);
    md.push("");
    md.push("## Recommended next step");
    md.push(`- ${recommendedNextStep}`);
    md.push("");

    await fs.writeFile(MD_PATH, md.join("\n"), "utf8");
    console.log(`Wrote ${JSON_PATH}`);
    console.log(`Wrote ${MD_PATH}`);
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    await fs.writeFile(JSON_PATH, JSON.stringify({ generatedAt, error: err }, null, 2), "utf8");
    await fs.writeFile(MD_PATH, `# Bootstrap model quality audit\n\nGenerated: ${generatedAt}\n\n- Error: ${err}\n`, "utf8");
    throw e;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

