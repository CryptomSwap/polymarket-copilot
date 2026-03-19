/**
 * Shadow ML advisory scoring: load latest shadow-trained model, score candidate context.
 * Does not change execution decisions; output is advisory only.
 */

import { prisma } from "@/lib/db";
import { predictProbaLogistic, type LogisticRegressionModel } from "@/lib/ml/baseline";
import { toShadowFeatureVector, type ShadowFeatureInput } from "@/lib/ml/shadow-train/features";
import type { ShadowScoreInput, ShadowScoreResult } from "./types";

const SHADOW_MODEL_TYPE = "logistic_regression_shadow";

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
 * Load the latest ACTIVE or APPROVED shadow-trained model (modelType = logistic_regression_shadow).
 * Distinct from recommendation ML (getActiveOrApprovedModel in score-live.ts).
 */
export async function getActiveOrApprovedShadowModel(): Promise<{
  run: { id: string; featureSetName: string; targetLabel: string };
  model: LogisticRegressionModel;
} | null> {
  const run = await prisma.mlModelRun.findFirst({
    where: { modelType: SHADOW_MODEL_TYPE, status: { in: ["ACTIVE", "APPROVED"] } },
    orderBy: { updatedAt: "desc" },
  });
  if (!run?.metricsJson) return null;
  const model = parseModelFromMetricsJson(run.metricsJson);
  if (!model) return null;
  return {
    run: { id: run.id, featureSetName: run.featureSetName, targetLabel: run.targetLabel },
    model,
  };
}

/**
 * Build feature completeness warnings for operator review (missing or defaulted fields).
 */
function buildFeatureWarnings(input: ShadowScoreInput): string[] {
  const w: string[] = [];
  if (input.grossExposure == null && input.totalOpenExposure == null) w.push("portfolio_exposure_missing");
  if (input.qualityState == null && input.spreadBps == null && input.tradable == null) w.push("execution_quality_partial");
  if (input.policyState == null && input.executionAllow == null) w.push("decision_policy_partial");
  return w;
}

/**
 * Score a candidate context with the active/approved shadow model. Advisory only; does not change execution.
 */
export async function scoreShadowCandidate(input: ShadowScoreInput): Promise<{
  success: boolean;
  result?: ShadowScoreResult;
  error?: string;
}> {
  const active = await getActiveOrApprovedShadowModel();
  if (!active) {
    return { success: false, error: "No ACTIVE or APPROVED shadow model found. Train and approve a shadow model first." };
  }

  const featureInput: ShadowFeatureInput = {
    ...input,
    outcomeBlockedVsAllowedVsSubmitted: null,
  };
  const vec = toShadowFeatureVector(featureInput);
  const proba = predictProbaLogistic(active.model, vec);

  const band: "low" | "medium" | "high" =
    proba >= 0.6 ? "high" : proba >= 0.4 ? "medium" : "low";

  const warnings = buildFeatureWarnings(input);

  return {
    success: true,
    result: {
      shadowMlScore: proba,
      shadowMlScoreBand: band,
      modelId: active.run.id,
      modelFeatureSet: active.run.featureSetName,
      modelTargetLabel: active.run.targetLabel,
      isShadowModel: true,
      featureCompletenessWarnings: warnings,
    },
  };
}
