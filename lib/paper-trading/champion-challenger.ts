/**
 * Champion/challenger helper for paper trading.
 * Paper-only: compares current shadow champion run against one challenger run without changing admission.
 */

import { prisma } from "@/lib/db";
import { predictProbaLogistic, type LogisticRegressionModel } from "@/lib/ml/baseline";
import { toShadowFeatureVector, type ShadowFeatureInput } from "@/lib/ml/shadow-train/features";
import type { ShadowScoreInput } from "@/lib/ml/shadow-score/types";
import { enableMlChampionChallenger } from "@/lib/ml/config";

export interface PaperChampionChallengerScores {
  championModelRunId: string;
  challengerModelRunId: string | null;
  championScore: number;
  challengerScore: number | null;
  scoreDelta: number | null;
  challengerAvailable: boolean;
}

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

interface ChallengerSelectionInput {
  /** Champion model run id used for the primary (shadow) score. */
  championModelRunId: string;
  /** Target label of the champion model (e.g. labelGoodDecision12h). */
  championTargetLabel: string;
}

async function selectChallengerRun(
  input: ChallengerSelectionInput
): Promise<{ runId: string; model: LogisticRegressionModel } | null> {
  const { championModelRunId, championTargetLabel } = input;

  const challenger = await prisma.mlModelRun.findFirst({
    where: {
      modelType: SHADOW_MODEL_TYPE,
      targetLabel: championTargetLabel,
      status: { in: ["APPROVED", "VALIDATED"] },
      NOT: { id: championModelRunId },
    },
    orderBy: { updatedAt: "desc" },
  });
  if (!challenger?.metricsJson) return null;
  const model = parseModelFromMetricsJson(challenger.metricsJson);
  if (!model) return null;
  return { runId: challenger.id, model };
}

/**
 * Score a challenger model for the same paper candidate, without changing admission.
 * Returns explicit champion/challenger fields for provenance.
 */
export async function scorePaperChampionAndChallenger(
  input: ShadowScoreInput,
  championScore: number,
  championModelRunId: string,
  championTargetLabel: string
): Promise<PaperChampionChallengerScores> {
  if (!enableMlChampionChallenger()) {
    return {
      championModelRunId,
      challengerModelRunId: null,
      championScore,
      challengerScore: null,
      scoreDelta: null,
      challengerAvailable: false,
    };
  }

  try {
    const selection = await selectChallengerRun({
      championModelRunId,
      championTargetLabel,
    });
    if (!selection) {
      return {
        championModelRunId,
        challengerModelRunId: null,
        championScore,
        challengerScore: null,
        scoreDelta: null,
        challengerAvailable: false,
      };
    }

    const featureInput: ShadowFeatureInput = {
      ...(input as ShadowFeatureInput),
      outcomeBlockedVsAllowedVsSubmitted: null,
    };
    const vec = toShadowFeatureVector(featureInput);
    const challengerScore = predictProbaLogistic(selection.model, vec);
    const scoreDelta = challengerScore - championScore;

    return {
      championModelRunId,
      challengerModelRunId: selection.runId,
      championScore,
      challengerScore,
      scoreDelta,
      challengerAvailable: true,
    };
  } catch {
    return {
      championModelRunId,
      challengerModelRunId: null,
      championScore,
      challengerScore: null,
      scoreDelta: null,
      challengerAvailable: false,
    };
  }
}

