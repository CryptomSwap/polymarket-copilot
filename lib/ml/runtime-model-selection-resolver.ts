/**
 * Resolver for per-bot model selection: current global champion vs INTENDED_ACTIVE governance link.
 * Default (flag OFF): current behavior only = getActiveOrApprovedShadowModel() (single global champion).
 * When flag ON: INTENDED_ACTIVE model for bot's ACTIVE revision if present and usable; else fallback to global champion.
 * Does not change scoring behavior unless ENABLE_PAPER_PER_BOT_MODEL_SELECTION_FROM_GOVERNANCE is explicitly set.
 */

import { prisma } from "@/lib/db";
import { enablePaperPerBotModelSelectionFromGovernance } from "./config";
import { getActiveOrApprovedShadowModel } from "./shadow-score/score-live";

export type ModelSelectionResolutionSource = "global_champion" | "intended_active_link";

export type ModelSelectionResolutionWarning =
  | "no_active_revision"
  | "no_intended_active_model_link"
  | "linked_model_not_found"
  | "linked_model_incompatible_type"
  | "linked_model_missing_metrics"
  | "fell_back_to_global_champion"
  | "no_global_champion";

const SHADOW_MODEL_TYPE = "logistic_regression_shadow";

/** Minimal check that metricsJson contains usable shadow model (same shape as score-live expects). */
function isUsableShadowMetricsJson(metricsJson: string | null): boolean {
  if (!metricsJson) return false;
  try {
    const parsed = JSON.parse(metricsJson) as Record<string, unknown>;
    const coef = parsed.coefficients;
    const intercept = parsed.intercept;
    const means = parsed.means;
    const stds = parsed.stds;
    return (
      Array.isArray(coef) &&
      typeof intercept === "number" &&
      Array.isArray(means) &&
      Array.isArray(stds)
    );
  } catch {
    return false;
  }
}

/**
 * Resolve which model run would be used for scoring this bot. When flag OFF, returns global champion only.
 * When flag ON, uses INTENDED_ACTIVE link for ACTIVE revision if valid; otherwise falls back to global champion.
 * For reporting: pass forceGovernancePath: true to compute hypothetical ON result without enabling the flag.
 */
export async function resolveModelSelectionForBot(
  botType: string,
  options?: { forceGovernancePath?: boolean }
): Promise<{
  /** Resolved model run id (null if no champion and no valid link). */
  resolvedModelRunId: string | null;
  /** Run metadata when resolved from a specific run. */
  run: { id: string; featureSetName: string; targetLabel: string } | null;
  source: ModelSelectionResolutionSource;
  fallbackUsed: boolean;
  warnings: ModelSelectionResolutionWarning[];
  resolvedProfileRevisionId: string | null;
  linkageRoleUsed: string | null;
  modelType: string | null;
  targetLabel: string | null;
}> {
  let champion: Awaited<ReturnType<typeof getActiveOrApprovedShadowModel>>;
  try {
    champion = await getActiveOrApprovedShadowModel();
  } catch {
    champion = null;
  }

  const fallbackResult = (warnings: ModelSelectionResolutionWarning[]) => ({
    resolvedModelRunId: champion?.run.id ?? null,
    run: champion?.run ?? null,
    source: "global_champion" as const,
    fallbackUsed: true,
    warnings,
    resolvedProfileRevisionId: null,
    linkageRoleUsed: null,
    modelType: champion?.run ? SHADOW_MODEL_TYPE : null,
    targetLabel: champion?.run.targetLabel ?? null,
  });

  const useGovernance = options?.forceGovernancePath ?? enablePaperPerBotModelSelectionFromGovernance();
  if (!useGovernance) {
    return {
      resolvedModelRunId: champion?.run.id ?? null,
      run: champion?.run ?? null,
      source: "global_champion",
      fallbackUsed: false,
      warnings: champion ? [] : ["no_global_champion"],
      resolvedProfileRevisionId: null,
      linkageRoleUsed: null,
      modelType: champion?.run ? SHADOW_MODEL_TYPE : null,
      targetLabel: champion?.run.targetLabel ?? null,
    };
  }

  let activeRevisionId: string | null = null;
  let intendedModelRunId: string | null = null;
  try {
    const revision = await prisma.paperBotProfileRevision.findFirst({
      where: { botType, status: "ACTIVE" },
      orderBy: { promotedAt: "desc" },
      select: { id: true },
    });
    activeRevisionId = revision?.id ?? null;
    if (!revision) {
      return fallbackResult(["no_active_revision", "fell_back_to_global_champion"]);
    }
    const link = await prisma.paperBotProfileModelLink.findFirst({
      where: { profileRevisionId: revision.id, linkageRole: "INTENDED_ACTIVE" },
      orderBy: { createdAt: "desc" },
      select: { modelRunId: true },
    });
    intendedModelRunId = link?.modelRunId ?? null;
    if (!intendedModelRunId) {
      return fallbackResult(["no_intended_active_model_link", "fell_back_to_global_champion"]);
    }
  } catch {
    return fallbackResult(["no_active_revision", "fell_back_to_global_champion"]);
  }

  let run: { id: string; featureSetName: string; targetLabel: string } | null = null;
  try {
    const modelRun = await prisma.mlModelRun.findUnique({
      where: { id: intendedModelRunId },
      select: { id: true, modelType: true, featureSetName: true, targetLabel: true, metricsJson: true, status: true },
    });
    if (!modelRun) {
      return fallbackResult(["linked_model_not_found", "fell_back_to_global_champion"]);
    }
    if (modelRun.modelType !== SHADOW_MODEL_TYPE) {
      return fallbackResult(["linked_model_incompatible_type", "fell_back_to_global_champion"]);
    }
    if (!isUsableShadowMetricsJson(modelRun.metricsJson)) {
      return fallbackResult(["linked_model_missing_metrics", "fell_back_to_global_champion"]);
    }
    run = {
      id: modelRun.id,
      featureSetName: modelRun.featureSetName,
      targetLabel: modelRun.targetLabel,
    };
  } catch {
    return fallbackResult(["linked_model_not_found", "fell_back_to_global_champion"]);
  }

  return {
    resolvedModelRunId: run.id,
    run,
    source: "intended_active_link",
    fallbackUsed: false,
    warnings: [],
    resolvedProfileRevisionId: activeRevisionId,
    linkageRoleUsed: "INTENDED_ACTIVE",
    modelType: SHADOW_MODEL_TYPE,
    targetLabel: run.targetLabel,
  };
}
