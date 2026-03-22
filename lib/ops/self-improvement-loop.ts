import * as fs from "fs/promises";
import * as path from "path";
import { prisma } from "@/lib/db";
import { trainShadowModel } from "@/lib/ml/shadow-train";
import { persistShadowTrainingExamples } from "@/lib/ml/shadow-dataset";
import { predictBatchLogistic, type LogisticRegressionModel } from "@/lib/ml/baseline";
import { computeMetrics } from "@/lib/ml/evaluate";
import { toShadowFeatureVector } from "@/lib/ml/shadow-train/features";
import { getActiveOrApprovedShadowModel } from "@/lib/ml/shadow-score";
import { getPaperTradingConfig, type PaperTradingConfig } from "@/lib/paper-trading/config";
import { BOT_PROFILES } from "@/lib/paper-trading/bot-profiles";
import type { ShadowTargetLabel } from "@/lib/ml/shadow-train/types";
import { scoreBandFromShadowProba } from "@/lib/paper-trading/paper-score-band";

const SHADOW_MODEL_TYPE = "logistic_regression_shadow";
const DUMP_DIR = path.join(process.cwd(), "dump");
const OVERRIDES_PATH = path.join(DUMP_DIR, "paper-config-optimizer-overrides.json");
const STATE_PATH = path.join(DUMP_DIR, "self-improvement-state.json");

type BotOverride = {
  threshold?: number;
  maxDailyNewTrades?: number;
  cooldownHours?: number;
  cooldownMarketHours?: number;
};

type GlobalOverride = {
  relaxedConcentrationMaxPerTick?: number;
  relaxedConcentrationMaxPerDay?: number;
  relaxedConcentrationMaxOpenPerMarket?: number;
  relaxedConcentrationMaxOpenPerTheme?: number;
  relaxedConcentrationStakeNotional?: number;
};

type OptimizerOverridesFile = {
  version: 1;
  updatedAt: string;
  updatedBy: "paper_config_optimizer";
  botOverrides: Record<string, BotOverride>;
  globalOverrides: GlobalOverride;
};

type SelfImprovementState = {
  version: 1;
  lastModelPromotion?: {
    at: string;
    previousModelRunId: string | null;
    promotedModelRunId: string;
    baselineMeanPnlPct: number | null;
    baselineSamples: number;
  };
  lastConfigOptimization?: {
    at: string;
    previousOverrides: OptimizerOverridesFile | null;
    appliedOverrides: OptimizerOverridesFile;
    baselineMeanPnlPct: number | null;
    baselineSamples: number;
  };
};

function asNum(v: string | null | undefined): number | null {
  if (!v) return null;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function envNum(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name: string, fallback = false): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "1" || raw === "true";
}

function asShadowTargetLabel(v: string | null | undefined): ShadowTargetLabel | null {
  if (!v) return null;
  if (
    v === "labelGoodDecision" ||
    v === "labelGoodDecision6h" ||
    v === "labelGoodDecision12h" ||
    v === "labelMissedOpportunity"
  ) {
    return v;
  }
  return null;
}

async function countRowsForTarget(targetLabel: ShadowTargetLabel): Promise<number> {
  const rows = await prisma.mlShadowTrainingExample.findMany({
    where: { [targetLabel]: { not: null } },
    select: { [targetLabel]: true },
    take: 100_000,
  });
  let count = 0;
  for (const r of rows) {
    const v = (r as Record<string, unknown>)[targetLabel];
    if (v === true || v === false) count++;
  }
  return count;
}

async function chooseBootstrapTarget(minRows: number): Promise<{
  chosenTarget: ShadowTargetLabel | null;
  counts: {
    labelGoodDecision12h: number;
    labelGoodDecision6h: number;
  };
  rationale: string;
}> {
  const allow6h = envBool("SELF_IMPROVE_BOOTSTRAP_ALLOW_6H", true);
  const preferenceOrder: Array<"labelGoodDecision12h" | "labelGoodDecision6h"> = allow6h
    ? ["labelGoodDecision12h", "labelGoodDecision6h"]
    : ["labelGoodDecision12h"];
  const counts = {
    labelGoodDecision12h: await countRowsForTarget("labelGoodDecision12h"),
    labelGoodDecision6h: await countRowsForTarget("labelGoodDecision6h"),
  };
  for (const k of preferenceOrder) {
    if (counts[k] >= minRows) {
      return {
        chosenTarget: k,
        counts,
        rationale: `selected_preferred_target_with_min_rows:${k}>=${minRows}`,
      };
    }
  }
  return {
    chosenTarget: null,
    counts,
    rationale: `no_eligible_short_horizon_bootstrap_target:minRows=${minRows}:allow6h=${allow6h}`,
  };
}

async function parseRunMetrics(runId: string): Promise<{ rocAuc: number | null; f1: number | null }> {
  const run = await prisma.mlModelRun.findUnique({
    where: { id: runId },
    select: { metricsJson: true },
  });
  if (!run?.metricsJson) return { rocAuc: null, f1: null };
  try {
    const m = JSON.parse(run.metricsJson) as { rocAuc?: unknown; f1?: unknown };
    return {
      rocAuc: typeof m.rocAuc === "number" ? m.rocAuc : null,
      f1: typeof m.f1 === "number" ? m.f1 : null,
    };
  } catch {
    return { rocAuc: null, f1: null };
  }
}

async function evaluateBootstrapApprovalCandidate(params: {
  runId: string;
  targetLabel: string;
  trainCount: number | null;
  validationCount: number | null;
  coldStartAtStart: boolean;
}): Promise<{
  eligible: boolean;
  reason: string;
  guardrails: Record<string, unknown>;
}> {
  if (!params.coldStartAtStart) {
    return {
      eligible: false,
      reason: "not_cold_start",
      guardrails: { coldStartAtStart: false },
    };
  }
  const minDataset = envInt("SELF_IMPROVE_BOOTSTRAP_MIN_DATASET", 25);
  const minValidation = envInt("SELF_IMPROVE_BOOTSTRAP_MIN_VALIDATION", 10);
  const minAuc = envNum("SELF_IMPROVE_BOOTSTRAP_MIN_ROC_AUC", 0.5);
  const minF1 = envNum("SELF_IMPROVE_BOOTSTRAP_MIN_F1", 0.2);
  const allow6h = envBool("SELF_IMPROVE_BOOTSTRAP_ALLOW_6H", true);
  const allowedTargets = new Set<string>(allow6h ? ["labelGoodDecision12h", "labelGoodDecision6h"] : ["labelGoodDecision12h"]);
  const { rocAuc, f1 } = await parseRunMetrics(params.runId);
  const trainCount = params.trainCount ?? 0;
  const validationCount = params.validationCount ?? 0;
  const datasetSize = trainCount + validationCount;
  const guardrails: Record<string, unknown> = {
    coldStartAtStart: params.coldStartAtStart,
    minDataset,
    minValidation,
    minAuc,
    minF1,
    allow6h,
    targetLabel: params.targetLabel,
    datasetSize,
    validationCount,
    rocAuc,
    f1,
  };
  if (!allowedTargets.has(params.targetLabel)) {
    return { eligible: false, reason: `target_not_bootstrap_allowed:${params.targetLabel}`, guardrails };
  }
  if (datasetSize < minDataset) {
    return { eligible: false, reason: `dataset_below_min:${datasetSize}<${minDataset}`, guardrails };
  }
  if (validationCount < minValidation) {
    return { eligible: false, reason: `validation_below_min:${validationCount}<${minValidation}`, guardrails };
  }
  if (rocAuc == null || rocAuc < minAuc) {
    return { eligible: false, reason: `roc_auc_below_min:${rocAuc ?? "null"}<${minAuc}`, guardrails };
  }
  if (f1 == null || f1 < minF1) {
    return { eligible: false, reason: `f1_below_min:${f1 ?? "null"}<${minF1}`, guardrails };
  }
  const existingChampion = await getActiveOrApprovedShadowModel();
  if (existingChampion?.run.id) {
    return { eligible: false, reason: "champion_now_exists_skip_bootstrap_auto_approve", guardrails };
  }
  return { eligible: true, reason: "eligible_for_bootstrap_approval", guardrails };
}

async function ensureDumpDir(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });
}

async function writeJsonReport(prefix: string, payload: Record<string, unknown>): Promise<string> {
  await ensureDumpDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(DUMP_DIR, `${prefix}-${stamp}.json`);
  const latest = path.join(DUMP_DIR, `${prefix}-latest.json`);
  const body = JSON.stringify(payload, null, 2);
  await fs.writeFile(file, body, "utf8");
  await fs.writeFile(latest, body, "utf8");
  return file;
}

function modelFromMetricsJson(metricsJson: string | null): LogisticRegressionModel | null {
  if (!metricsJson) return null;
  try {
    const p = JSON.parse(metricsJson) as {
      coefficients?: number[];
      intercept?: number;
      means?: number[];
      stds?: number[];
    };
    if (!Array.isArray(p.coefficients)) return null;
    if (typeof p.intercept !== "number") return null;
    if (!Array.isArray(p.means) || !Array.isArray(p.stds)) return null;
    return {
      coefficients: p.coefficients,
      intercept: p.intercept,
      means: p.means,
      stds: p.stds,
    };
  } catch {
    return null;
  }
}

function toFeatureInput(
  r: Awaited<ReturnType<typeof prisma.mlShadowTrainingExample.findMany>>[number]
): Parameters<typeof toShadowFeatureVector>[0] {
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

async function loadOverrides(): Promise<OptimizerOverridesFile | null> {
  try {
    const raw = await fs.readFile(OVERRIDES_PATH, "utf8");
    const parsed = JSON.parse(raw) as OptimizerOverridesFile;
    if (parsed?.version === 1) return parsed;
    return null;
  } catch {
    return null;
  }
}

async function saveOverrides(data: OptimizerOverridesFile): Promise<void> {
  await ensureDumpDir();
  await fs.writeFile(OVERRIDES_PATH, JSON.stringify(data, null, 2), "utf8");
}

async function loadState(): Promise<SelfImprovementState> {
  try {
    const raw = await fs.readFile(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw) as SelfImprovementState;
    if (parsed?.version === 1) return parsed;
  } catch {
    // ignore
  }
  return { version: 1 };
}

async function saveState(next: SelfImprovementState): Promise<void> {
  await ensureDumpDir();
  await fs.writeFile(STATE_PATH, JSON.stringify(next, null, 2), "utf8");
}

async function getMeanClosedPaperPnlPct(days: number): Promise<{ mean: number | null; samples: number }> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rows = await prisma.paperTrade.findMany({
    where: { status: "closed", exitTime: { gte: since } },
    select: { pnlPct: true },
  });
  const vals = rows.map((r) => asNum(r.pnlPct)).filter((v): v is number => v != null);
  if (vals.length === 0) return { mean: null, samples: 0 };
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  return { mean, samples: vals.length };
}

function shadowDatasetCandidateSelectionFromEnv(): "sequential" | "prefer_missing_12h_label" {
  const v = (process.env.SHADOW_DATASET_CANDIDATE_SELECTION ?? "").toLowerCase().trim();
  if (v === "sequential") return "sequential";
  return "prefer_missing_12h_label";
}

export async function runShadowDatasetRefreshJob(): Promise<void> {
  const limit = envInt("SELF_IMPROVE_DATASET_BUILD_LIMIT", 1_500);
  const coldStart = !(await getActiveOrApprovedShadowModel());
  const allowBootstrapUnevaluated = envBool("SELF_IMPROVE_BOOTSTRAP_ALLOW_UNEVALUATED", true);
  const evaluatedOnly = coldStart && allowBootstrapUnevaluated ? false : true;
  const datasetCandidateSelection = shadowDatasetCandidateSelectionFromEnv();
  const res = await persistShadowTrainingExamples({
    limit,
    evaluatedOnly,
    datasetCandidateSelection,
  });
  await writeJsonReport("model-dataset-refresh-report", {
    generatedAt: new Date().toISOString(),
    limit,
    coldStartMode: coldStart,
    evaluatedOnly,
    datasetCandidateSelection,
    result: res,
  });
}

/**
 * Path/regime feature backfill on existing MlShadowTrainingExample rows. Runs before shadow retrain in the automated chain.
 */
export async function runShadowPathFeatureBackfillJob(): Promise<void> {
  const { backfillPathRegimeFeaturesForMlExamples } = await import("@/lib/ml/shadow-dataset/backfill-path-regime-features");
  const limit = envInt("SELF_IMPROVE_PATH_BACKFILL_LIMIT", 3_000);
  const batchSize = envInt("SELF_IMPROVE_PATH_BACKFILL_BATCH", 50);
  const require12h = envBool("SELF_IMPROVE_PATH_BACKFILL_REQUIRE_LABEL_12H", false);
  const dryRun = envBool("SELF_IMPROVE_PATH_BACKFILL_DRY_RUN", false);
  const res = await backfillPathRegimeFeaturesForMlExamples(prisma, {
    limit,
    batchSize,
    dryRun,
    requireLabelGoodDecision12h: require12h,
  });
  await writeJsonReport("path-feature-backfill-report", {
    generatedAt: new Date().toISOString(),
    limit,
    batchSize,
    requireLabelGoodDecision12h: require12h,
    dryRun,
    result: res,
  });
}

export async function runShadowRetrainJob(): Promise<void> {
  const champion = await getActiveOrApprovedShadowModel();
  const coldStart = !champion;
  const envTargetLabel = asShadowTargetLabel(process.env.SELF_IMPROVE_TARGET_LABEL ?? null);
  const bootstrapMinRows = envInt("SELF_IMPROVE_BOOTSTRAP_MIN_ROWS", 25);
  const bootstrapChoice = coldStart ? await chooseBootstrapTarget(bootstrapMinRows) : null;
  let targetLabel: ShadowTargetLabel;
  let policySource: "bootstrap_policy" | "env_override" | "champion_target";
  if (coldStart && envTargetLabel && !["labelGoodDecision12h", "labelGoodDecision6h"].includes(envTargetLabel)) {
    await writeJsonReport("model-training-report", {
      generatedAt: new Date().toISOString(),
      status: "skipped",
      reason: "cold_start_target_override_not_short_horizon",
      envTargetLabel,
      allowedTargets: ["labelGoodDecision12h", "labelGoodDecision6h"],
      coldStartMode: coldStart,
      championAtStart: null,
    });
    return;
  }
  if (envTargetLabel) {
    targetLabel = envTargetLabel;
    policySource = "env_override";
  } else if (!coldStart && champion?.run.targetLabel) {
    targetLabel = asShadowTargetLabel(champion.run.targetLabel) ?? "labelGoodDecision12h";
    policySource = "champion_target";
  } else {
    if (!bootstrapChoice?.chosenTarget) {
      await writeJsonReport("model-training-report", {
        generatedAt: new Date().toISOString(),
        status: "skipped",
        reason: "no_eligible_short_horizon_bootstrap_target",
        coldStartMode: coldStart,
        championAtStart: champion != null ? champion.run : null,
        bootstrapChoice,
        minRowsRequired: bootstrapMinRows,
        failClosed: true,
      });
      return;
    }
    targetLabel = bootstrapChoice.chosenTarget;
    policySource = "bootstrap_policy";
  }
  const limit = envInt("SELF_IMPROVE_TRAIN_LIMIT", 5000);
  const trainRatio = envNum("SELF_IMPROVE_TRAIN_RATIO", 0.8);
  const result = await trainShadowModel(targetLabel, { limit, trainRatio });
  if (!result.success) {
    throw new Error(`self_improve_train_failed:${result.error ?? "unknown"}`);
  }
  await writeJsonReport("model-training-report", {
    generatedAt: new Date().toISOString(),
    targetLabel,
    policySource,
    coldStartMode: coldStart,
    championAtStart: champion?.run ?? null,
    bootstrapChoice,
    bootstrapActivationDelegated: true,
    limit,
    trainRatio,
    result,
  });
}

export async function runShadowBootstrapActivationJob(): Promise<void> {
  const generatedAt = new Date().toISOString();
  const champion = await getActiveOrApprovedShadowModel();
  const coldStart = !champion;
  if (!coldStart) {
    await writeJsonReport("model-bootstrap-activation-report", {
      generatedAt,
      status: "skipped",
      reason: "champion_exists",
      champion: champion?.run ?? null,
      scope: "paper_only",
      failClosed: true,
    });
    return;
  }
  const allow6h = envBool("SELF_IMPROVE_BOOTSTRAP_ALLOW_6H", true);
  const allowedTargets = allow6h ? ["labelGoodDecision12h", "labelGoodDecision6h"] : ["labelGoodDecision12h"];
  const candidate = await prisma.mlModelRun.findFirst({
    where: {
      modelType: SHADOW_MODEL_TYPE,
      status: "TRAINED",
      targetLabel: { in: allowedTargets },
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      targetLabel: true,
      trainCount: true,
      validationCount: true,
      createdAt: true,
    },
  });
  if (!candidate) {
    await writeJsonReport("model-bootstrap-activation-report", {
      generatedAt,
      status: "skipped",
      reason: "no_trained_short_horizon_candidate",
      allowedTargets,
      scope: "paper_only",
      failClosed: true,
    });
    return;
  }
  const decision = await evaluateBootstrapApprovalCandidate({
    runId: candidate.id,
    targetLabel: candidate.targetLabel,
    trainCount: candidate.trainCount ?? null,
    validationCount: candidate.validationCount ?? null,
    coldStartAtStart: coldStart,
  });
  if (!decision.eligible) {
    await writeJsonReport("model-bootstrap-activation-report", {
      generatedAt,
      status: "skipped",
      reason: decision.reason,
      candidateRunId: candidate.id,
      candidateTargetLabel: candidate.targetLabel,
      guardrails: decision.guardrails,
      scope: "paper_only",
      failClosed: true,
    });
    return;
  }
  const championBeforeUpdate = await getActiveOrApprovedShadowModel();
  if (championBeforeUpdate?.run.id) {
    await writeJsonReport("model-bootstrap-activation-report", {
      generatedAt,
      status: "skipped",
      reason: "champion_exists_before_update",
      champion: championBeforeUpdate.run,
      scope: "paper_only",
      failClosed: true,
    });
    return;
  }
  const updated = await prisma.mlModelRun.updateMany({
    where: {
      id: candidate.id,
      modelType: SHADOW_MODEL_TYPE,
      status: "TRAINED",
    },
    data: { status: "APPROVED" },
  });
  if (updated.count !== 1) {
    await writeJsonReport("model-bootstrap-activation-report", {
      generatedAt,
      status: "skipped",
      reason: "candidate_not_in_expected_trained_state",
      candidateRunId: candidate.id,
      updatedCount: updated.count,
      scope: "paper_only",
      failClosed: true,
    });
    return;
  }
  await writeJsonReport("model-bootstrap-activation-report", {
    generatedAt,
    status: "approved",
    activatedRunId: candidate.id,
    statusSetTo: "APPROVED",
    bootstrapTarget: candidate.targetLabel,
    guardrails: decision.guardrails,
    provenance: {
      mode: "bootstrap_activation_job",
      paperOnly: true,
      noChampionRequired: true,
    },
    scope: "paper_only",
  });
}

export type BootstrapActivationPreview = {
  wouldApprove: boolean;
  reason: string;
  candidateRunId: string | null;
  candidateTargetLabel: string | null;
  guardrails?: Record<string, unknown>;
};

/** Read-only bootstrap activation outcome (same gates as runShadowBootstrapActivationJob). */
export async function computeBootstrapActivationPreview(): Promise<BootstrapActivationPreview> {
  const champion = await getActiveOrApprovedShadowModel();
  const coldStart = !champion;
  if (!coldStart) {
    return {
      wouldApprove: false,
      reason: "champion_exists",
      candidateRunId: null,
      candidateTargetLabel: null,
    };
  }
  const allow6h = envBool("SELF_IMPROVE_BOOTSTRAP_ALLOW_6H", true);
  const allowedTargets = allow6h ? ["labelGoodDecision12h", "labelGoodDecision6h"] : ["labelGoodDecision12h"];
  const candidate = await prisma.mlModelRun.findFirst({
    where: {
      modelType: SHADOW_MODEL_TYPE,
      status: "TRAINED",
      targetLabel: { in: allowedTargets },
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      targetLabel: true,
      trainCount: true,
      validationCount: true,
      createdAt: true,
    },
  });
  if (!candidate) {
    return {
      wouldApprove: false,
      reason: "no_trained_short_horizon_candidate",
      candidateRunId: null,
      candidateTargetLabel: null,
    };
  }
  const decision = await evaluateBootstrapApprovalCandidate({
    runId: candidate.id,
    targetLabel: candidate.targetLabel,
    trainCount: candidate.trainCount ?? null,
    validationCount: candidate.validationCount ?? null,
    coldStartAtStart: coldStart,
  });
  return {
    wouldApprove: decision.eligible,
    reason: decision.reason,
    candidateRunId: candidate.id,
    candidateTargetLabel: candidate.targetLabel,
    guardrails: decision.guardrails,
  };
}

function shadowEvalMinAgeMsForLoop(): number {
  const raw = process.env.SHADOW_EVAL_MIN_AGE_MS;
  const def = 25 * 60 * 60 * 1000;
  if (raw == null || String(raw).trim() === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return def;
  return Math.min(Math.floor(n), 365 * 24 * 60 * 60 * 1000);
}

function shadowEvalLimitForLoop(): number {
  const raw = process.env.SHADOW_EVAL_LIMIT;
  const def = 100;
  if (raw == null || String(raw).trim() === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return def;
  return Math.min(Math.floor(n), 5000);
}

/**
 * Single orchestrated paper-only improvement pass (no live trading, no paper_config_optimize).
 * Order: shadow truth → dataset persist → path feature backfill → retrain → bootstrap APPROVED gate → promote gate → rollback guard.
 * Does not run paper_trading_tick (keeps on its own schedule). Writes dump/self-improving-loop-status.{json,md} at end.
 */
export async function runSelfImprovingPaperLoopJob(): Promise<void> {
  const { evaluateShadowCandidates } = await import("@/lib/shadow-evaluation");
  const generatedAt = new Date().toISOString();
  const stages: Array<{ stage: string; ok: boolean; error?: string; at: string }> = [];

  const runStage = async (name: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
      stages.push({ stage: name, ok: true, at: new Date().toISOString() });
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      stages.push({ stage: name, ok: false, error: err, at: new Date().toISOString() });
      await writeJsonReport("self-improving-paper-loop-run", {
        generatedAt,
        status: "failure",
        failedStage: name,
        error: err,
        stages,
        orderingNote:
          "truth_eval → dataset_refresh → path_backfill → retrain → bootstrap_activate → promote → rollback_guard",
      });
      throw e;
    }
  };

  await runStage("shadow_evaluation", async () => {
    await evaluateShadowCandidates({
      minAgeMs: shadowEvalMinAgeMsForLoop(),
      limit: shadowEvalLimitForLoop(),
    });
  });
  await runStage("dataset_refresh", () => runShadowDatasetRefreshJob());
  await runStage("path_feature_backfill", () => runShadowPathFeatureBackfillJob());
  await runStage("shadow_retrain", () => runShadowRetrainJob());
  await runStage("bootstrap_activate", () => runShadowBootstrapActivationJob());
  await runStage("shadow_promote", () => runShadowEvaluateAndPromoteJob());
  await runStage("rollback_guard", () => runSelfImprovementRollbackGuardJob());

  await writeJsonReport("self-improving-paper-loop-run", {
    generatedAt,
    status: "success",
    stages,
    orderingNote:
      "truth_eval → dataset_refresh → path_backfill → retrain → bootstrap_activate → promote → rollback_guard",
  });

  const { writeSelfImprovingLoopStatusReports } = await import("./self-improving-loop-status");
  await writeSelfImprovingLoopStatusReports();
}

export type ShadowPromotionPreview = {
  generatedAt: string;
  status: "evaluated" | "skipped";
  skipReason?: string;
  hint?: string;
  wouldPromote: boolean;
  outcomeReason: string;
  championModelRunId: string | null;
  challengerModelRunId: string | null;
  championTargetLabel: string | null;
  guardrails: {
    minSamples: number;
    holdoutDays: number;
    minAucDelta: number;
    minF1Delta: number;
    minPositiveRate: number;
    minNegativeRate: number;
  };
  holdout: {
    rows: number;
    positiveRate: number;
    negativeRate: number;
    noisy: boolean;
  };
  metrics: {
    champion: ReturnType<typeof computeMetrics> | null;
    challenger: ReturnType<typeof computeMetrics> | null;
    deltaAuc: number;
    deltaF1: number;
  };
};

/**
 * Read-only shadow promotion evaluation (same gates as runShadowEvaluateAndPromoteJob). For status reports and tests.
 */
export async function computeShadowPromotionPreview(): Promise<ShadowPromotionPreview> {
  const generatedAt = new Date().toISOString();
  const minSamples = envInt("SELF_IMPROVE_MIN_EVAL_SAMPLES", 250);
  const holdoutDays = envInt("SELF_IMPROVE_HOLDOUT_DAYS", 14);
  const minAucDelta = envNum("SELF_IMPROVE_MIN_AUC_DELTA", 0.01);
  const minF1Delta = envNum("SELF_IMPROVE_MIN_F1_DELTA", 0.01);
  const minPositiveRate = envNum("SELF_IMPROVE_MIN_POSITIVE_RATE", 0.05);
  const minNegativeRate = envNum("SELF_IMPROVE_MIN_NEGATIVE_RATE", 0.05);
  const guardrails = {
    minSamples,
    holdoutDays,
    minAucDelta,
    minF1Delta,
    minPositiveRate,
    minNegativeRate,
  };

  const active = await getActiveOrApprovedShadowModel();
  if (!active?.run.id) {
    return {
      generatedAt,
      status: "skipped",
      skipReason: "no_active_or_approved_shadow_champion",
      hint: "Activate or approve a shadow model first: POST /api/ml/activate-latest-shadow or POST /api/ml/approve-run with a shadow runId.",
      wouldPromote: false,
      outcomeReason: "no_champion",
      championModelRunId: null,
      challengerModelRunId: null,
      championTargetLabel: null,
      guardrails,
      holdout: { rows: 0, positiveRate: 0, negativeRate: 0, noisy: true },
      metrics: { champion: null, challenger: null, deltaAuc: 0, deltaF1: 0 },
    };
  }

  const champion = await prisma.mlModelRun.findUnique({ where: { id: active.run.id } });
  if (!champion?.metricsJson) {
    return {
      generatedAt,
      status: "skipped",
      skipReason: "champion_row_or_metrics_missing",
      wouldPromote: false,
      outcomeReason: "champion_not_found",
      championModelRunId: active.run.id,
      challengerModelRunId: null,
      championTargetLabel: champion?.targetLabel ?? null,
      guardrails,
      holdout: { rows: 0, positiveRate: 0, negativeRate: 0, noisy: true },
      metrics: { champion: null, challenger: null, deltaAuc: 0, deltaF1: 0 },
    };
  }

  const challenger = await prisma.mlModelRun.findFirst({
    where: {
      modelType: SHADOW_MODEL_TYPE,
      targetLabel: champion.targetLabel,
      status: "TRAINED",
      id: { not: champion.id },
    },
    orderBy: { createdAt: "desc" },
  });

  if (!challenger?.metricsJson) {
    return {
      generatedAt,
      status: "skipped",
      skipReason: "no_trained_challenger",
      wouldPromote: false,
      outcomeReason: "no_challenger",
      championModelRunId: champion.id,
      challengerModelRunId: null,
      championTargetLabel: champion.targetLabel,
      guardrails,
      holdout: { rows: 0, positiveRate: 0, negativeRate: 0, noisy: true },
      metrics: { champion: null, challenger: null, deltaAuc: 0, deltaF1: 0 },
    };
  }

  const championModel = modelFromMetricsJson(champion.metricsJson);
  const challengerModel = modelFromMetricsJson(challenger.metricsJson);
  if (!championModel || !challengerModel) {
    return {
      generatedAt,
      status: "skipped",
      skipReason: "unusable_model_artifact",
      wouldPromote: false,
      outcomeReason: "metrics_parse_failed",
      championModelRunId: champion.id,
      challengerModelRunId: challenger.id,
      championTargetLabel: champion.targetLabel,
      guardrails,
      holdout: { rows: 0, positiveRate: 0, negativeRate: 0, noisy: true },
      metrics: { champion: null, challenger: null, deltaAuc: 0, deltaF1: 0 },
    };
  }

  const since = new Date(Date.now() - holdoutDays * 24 * 60 * 60 * 1000);
  const rows = await prisma.mlShadowTrainingExample.findMany({
    where: {
      createdAt: { gte: since },
      [champion.targetLabel]: { not: null },
    },
    orderBy: { createdAt: "asc" },
    take: envInt("SELF_IMPROVE_HOLDOUT_MAX_ROWS", 10_000),
  });

  const valid = rows.filter((r) => r[champion.targetLabel as keyof typeof r] === true || r[champion.targetLabel as keyof typeof r] === false);
  const y: number[] = valid.map((r) => (r[champion.targetLabel as keyof typeof r] === true ? 1 : 0));
  const posRate = y.length > 0 ? y.reduce((a, b) => a + b, 0) / y.length : 0;
  const negRate = 1 - posRate;
  const noisy = y.length < minSamples || posRate < minPositiveRate || negRate < minNegativeRate;

  let promoted = false;
  let promoteReason = "rejected";
  let deltaAuc = 0;
  let deltaF1 = 0;
  let championMetrics = null as ReturnType<typeof computeMetrics> | null;
  let challengerMetrics = null as ReturnType<typeof computeMetrics> | null;
  if (!noisy) {
    const X = valid.map((r) => toShadowFeatureVector(toFeatureInput(r)));
    const champScores = predictBatchLogistic(championModel, X);
    const challScores = predictBatchLogistic(challengerModel, X);
    championMetrics = computeMetrics(champScores, y);
    challengerMetrics = computeMetrics(challScores, y);
    deltaAuc = challengerMetrics.rocAuc - championMetrics.rocAuc;
    deltaF1 = challengerMetrics.f1 - championMetrics.f1;
    promoted = deltaAuc >= minAucDelta && deltaF1 >= minF1Delta;
    promoteReason = promoted ? "would_promote" : "metric_delta_below_threshold";
  } else {
    promoteReason = "noisy_or_insufficient_data";
  }

  return {
    generatedAt,
    status: "evaluated",
    wouldPromote: promoted,
    outcomeReason: promoteReason,
    championModelRunId: champion.id,
    challengerModelRunId: challenger.id,
    championTargetLabel: champion.targetLabel,
    guardrails,
    holdout: {
      rows: y.length,
      positiveRate: posRate,
      negativeRate: negRate,
      noisy,
    },
    metrics: {
      champion: championMetrics,
      challenger: challengerMetrics,
      deltaAuc,
      deltaF1,
    },
  };
}

export async function runShadowEvaluateAndPromoteJob(): Promise<void> {
  const preview = await computeShadowPromotionPreview();
  if (preview.status === "skipped") {
    await writeJsonReport("model-promotion-report", {
      ...preview,
      promoted: false,
      reason: preview.skipReason ?? preview.outcomeReason,
    });
    return;
  }

  const championId = preview.championModelRunId!;
  const challengerId = preview.challengerModelRunId!;

  if (preview.wouldPromote) {
    await prisma.$transaction(async (tx) => {
      await tx.mlModelRun.updateMany({
        where: { modelType: SHADOW_MODEL_TYPE, status: "ACTIVE", id: { not: challengerId } },
        data: { status: "VALIDATED" },
      });
      await tx.mlModelRun.update({
        where: { id: challengerId },
        data: { status: "ACTIVE" },
      });
    });

    const baseline = await getMeanClosedPaperPnlPct(envInt("SELF_IMPROVE_BASELINE_LOOKBACK_DAYS", 7));
    const state = await loadState();
    state.lastModelPromotion = {
      at: new Date().toISOString(),
      previousModelRunId: championId,
      promotedModelRunId: challengerId,
      baselineMeanPnlPct: baseline.mean,
      baselineSamples: baseline.samples,
    };
    await saveState(state);
  }

  await writeJsonReport("model-promotion-report", {
    generatedAt: preview.generatedAt,
    championModelRunId: championId,
    challengerModelRunId: challengerId,
    promoted: preview.wouldPromote,
    reason: preview.wouldPromote ? "promoted" : preview.outcomeReason,
    guardrails: preview.guardrails,
    holdout: preview.holdout,
    metrics: preview.metrics,
  });
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export async function runPaperConfigOptimizerJob(): Promise<void> {
  const analysisDays = envInt("PAPER_CONFIG_OPTIMIZER_LOOKBACK_DAYS", 14);
  const minSamples = envInt("PAPER_CONFIG_OPTIMIZER_MIN_SAMPLES", 40);
  const stepThreshold = envNum("PAPER_CONFIG_OPTIMIZER_THRESHOLD_STEP", 0.01);
  const stepCooldown = envInt("PAPER_CONFIG_OPTIMIZER_COOLDOWN_STEP_HOURS", 1);
  const stepDailyTrades = envInt("PAPER_CONFIG_OPTIMIZER_DAILY_TRADES_STEP", 3);
  const autoApply = envBool("PAPER_CONFIG_OPTIMIZER_AUTO_APPLY", false);

  const since = new Date(Date.now() - analysisDays * 24 * 60 * 60 * 1000);
  const current = (await loadOverrides()) ?? {
    version: 1 as const,
    updatedAt: new Date(0).toISOString(),
    updatedBy: "paper_config_optimizer" as const,
    botOverrides: {},
    globalOverrides: {},
  };
  const next: OptimizerOverridesFile = {
    ...current,
    updatedAt: new Date().toISOString(),
    updatedBy: "paper_config_optimizer",
    botOverrides: { ...current.botOverrides },
    globalOverrides: { ...current.globalOverrides },
  };

  const perBot: Record<string, unknown> = {};
  for (const bot of BOT_PROFILES) {
    const rows = await prisma.paperTrade.findMany({
      where: { botType: bot.botType, status: "closed", exitTime: { gte: since } },
      select: { pnlPct: true, score: true },
    });
    const pnl = rows.map((r) => asNum(r.pnlPct)).filter((v): v is number => v != null);
    const avgPnl = pnl.length ? pnl.reduce((a, b) => a + b, 0) / pnl.length : null;
    const hitRate = pnl.length ? pnl.filter((v) => v > 0).length / pnl.length : null;
    const currentOverride = next.botOverrides[bot.botType] ?? {};
    let proposed: BotOverride = { ...currentOverride };
    let rationale = "no_change";

    if (pnl.length >= minSamples && avgPnl != null && hitRate != null) {
      const baseThreshold = currentOverride.threshold ?? bot.threshold ?? 0.3;
      const baseDaily = currentOverride.maxDailyNewTrades ?? bot.maxDailyNewTrades ?? 0;
      const baseCooldownHours = currentOverride.cooldownHours ?? bot.cooldownHours ?? 12;
      const baseCooldownMarketHours = currentOverride.cooldownMarketHours ?? bot.cooldownMarketHours ?? 0;

      if (avgPnl < -0.01 || hitRate < 0.45) {
        proposed.threshold = clamp(baseThreshold + stepThreshold, 0.2, 0.85);
        proposed.maxDailyNewTrades = clamp(baseDaily > 0 ? baseDaily - stepDailyTrades : 25, 5, 250);
        proposed.cooldownHours = clamp(baseCooldownHours + stepCooldown, 2, 72);
        proposed.cooldownMarketHours = clamp(baseCooldownMarketHours + stepCooldown, 0, 48);
        rationale = "tighten_after_underperformance";
      } else if (avgPnl > 0.01 && hitRate > 0.56) {
        proposed.threshold = clamp(baseThreshold - stepThreshold, 0.2, 0.85);
        proposed.maxDailyNewTrades = clamp(baseDaily + stepDailyTrades, 5, 250);
        proposed.cooldownHours = clamp(baseCooldownHours - stepCooldown, 2, 72);
        proposed.cooldownMarketHours = clamp(baseCooldownMarketHours - stepCooldown, 0, 48);
        rationale = "relax_after_outperformance";
      }
    } else {
      rationale = "insufficient_samples";
    }

    next.botOverrides[bot.botType] = proposed;
    perBot[bot.botType] = {
      samples: pnl.length,
      avgPnlPct: avgPnl,
      hitRate,
      rationale,
      before: currentOverride,
      after: proposed,
    };
  }

  // Global concentration/tiny-stake knobs (paper-only).
  const baseGlobal = current.globalOverrides;
  const g: GlobalOverride = {
    relaxedConcentrationMaxPerTick: clamp(baseGlobal.relaxedConcentrationMaxPerTick ?? 3, 1, 8),
    relaxedConcentrationMaxPerDay: clamp(baseGlobal.relaxedConcentrationMaxPerDay ?? 25, 5, 80),
    relaxedConcentrationMaxOpenPerMarket: clamp(baseGlobal.relaxedConcentrationMaxOpenPerMarket ?? 1, 1, 4),
    relaxedConcentrationMaxOpenPerTheme: clamp(baseGlobal.relaxedConcentrationMaxOpenPerTheme ?? 8, 2, 20),
    relaxedConcentrationStakeNotional: clamp(baseGlobal.relaxedConcentrationStakeNotional ?? 2, 0.25, 10),
  };
  next.globalOverrides = g;

  const baseline = await getMeanClosedPaperPnlPct(envInt("PAPER_CONFIG_OPTIMIZER_BASELINE_LOOKBACK_DAYS", 7));
  if (autoApply) {
    await saveOverrides(next);
    const state = await loadState();
    state.lastConfigOptimization = {
      at: new Date().toISOString(),
      previousOverrides: current,
      appliedOverrides: next,
      baselineMeanPnlPct: baseline.mean,
      baselineSamples: baseline.samples,
    };
    await saveState(state);
  }

  await writeJsonReport("paper-config-optimization-report", {
    generatedAt: new Date().toISOString(),
    analysisDays,
    minSamples,
    autoApply,
    baseline,
    globalBefore: current.globalOverrides,
    globalAfter: next.globalOverrides,
    perBot,
  });
}

function scoreBandForPaperTrade(score: number): "low" | "medium" | "high" {
  return scoreBandFromShadowProba(score);
}

export async function runSelfImprovementRollbackGuardJob(): Promise<void> {
  const state = await loadState();
  const minSamples = envInt("SELF_IMPROVE_ROLLBACK_MIN_SAMPLES", 30);
  const maxDrawdownDelta = envNum("SELF_IMPROVE_ROLLBACK_MEAN_PNL_DELTA", -0.015);
  const lookbackDays = envInt("SELF_IMPROVE_ROLLBACK_LOOKBACK_DAYS", 5);
  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
  const events: Array<Record<string, unknown>> = [];

  const closedRecent = await prisma.paperTrade.findMany({
    where: { status: "closed", exitTime: { gte: since } },
    select: { score: true, pnlPct: true, modelRunId: true },
  });
  const bandStats: Record<
    string,
    { samples: number; meanPnlPct: number | null; winRate: number | null }
  > = { low: { samples: 0, meanPnlPct: null, winRate: null }, medium: { samples: 0, meanPnlPct: null, winRate: null }, high: { samples: 0, meanPnlPct: null, winRate: null } };
  for (const b of ["low", "medium", "high"] as const) {
    const rows = closedRecent.filter((r) => scoreBandForPaperTrade(r.score) === b);
    const pnls = rows.map((r) => asNum(r.pnlPct)).filter((v): v is number => v != null);
    bandStats[b] = {
      samples: pnls.length,
      meanPnlPct: pnls.length ? pnls.reduce((a, x) => a + x, 0) / pnls.length : null,
      winRate: pnls.length ? pnls.filter((x) => x > 0).length / pnls.length : null,
    };
  }

  let rollbackRecommendation: "hold" | "investigate" | "rollback_last_promotion_if_configured" = "hold";
  if (state.lastModelPromotion?.promotedModelRunId) {
    const promotedId = state.lastModelPromotion.promotedModelRunId;
    const promoPnls = closedRecent
      .filter((r) => r.modelRunId === promotedId)
      .map((r) => asNum(r.pnlPct))
      .filter((v): v is number => v != null);
    const mean = promoPnls.length ? promoPnls.reduce((a, x) => a + x, 0) / promoPnls.length : null;
    const baseline = state.lastModelPromotion.baselineMeanPnlPct;
    const delta = mean != null && baseline != null ? mean - baseline : null;
    if (
      state.lastModelPromotion.previousModelRunId &&
      promoPnls.length >= minSamples &&
      delta != null &&
      delta <= maxDrawdownDelta
    ) {
      rollbackRecommendation = "rollback_last_promotion_if_configured";
    } else if (promoPnls.length >= minSamples && mean != null && mean < -0.02) {
      rollbackRecommendation = "investigate";
    }
  }

  if (state.lastModelPromotion) {
    const promoted = state.lastModelPromotion.promotedModelRunId;
    const promoRows = closedRecent.filter((r) => r.modelRunId === promoted);
    const pnl = promoRows.map((r) => asNum(r.pnlPct)).filter((v): v is number => v != null);
    const mean = pnl.length ? pnl.reduce((a, b) => a + b, 0) / pnl.length : null;
    const baseline = state.lastModelPromotion.baselineMeanPnlPct;
    const delta = mean != null && baseline != null ? mean - baseline : null;
    const shouldRollback =
      state.lastModelPromotion.previousModelRunId &&
      pnl.length >= minSamples &&
      delta != null &&
      delta <= maxDrawdownDelta;
    if (shouldRollback) {
      const previousModelRunId = state.lastModelPromotion.previousModelRunId as string;
      await prisma.$transaction(async (tx) => {
        await tx.mlModelRun.updateMany({
          where: { modelType: SHADOW_MODEL_TYPE, status: "ACTIVE", id: { not: previousModelRunId } },
          data: { status: "VALIDATED" },
        });
        await tx.mlModelRun.update({ where: { id: previousModelRunId }, data: { status: "ACTIVE" } });
      });
      events.push({
        type: "model_rollback",
        at: new Date().toISOString(),
        reason: "material_underperformance_after_promotion",
        promotedModelRunId: promoted,
        restoredModelRunId: previousModelRunId,
        baselineMeanPnlPct: baseline,
        recentMeanPnlPct: mean,
        delta,
        samples: pnl.length,
      });
    }
  }

  if (state.lastConfigOptimization?.previousOverrides) {
    const baseline = state.lastConfigOptimization.baselineMeanPnlPct;
    const rows = await prisma.paperTrade.findMany({
      where: { status: "closed", exitTime: { gte: since } },
      select: { pnlPct: true },
    });
    const pnl = rows.map((r) => asNum(r.pnlPct)).filter((v): v is number => v != null);
    const mean = pnl.length ? pnl.reduce((a, b) => a + b, 0) / pnl.length : null;
    const delta = mean != null && baseline != null ? mean - baseline : null;
    const shouldRollback = pnl.length >= minSamples && delta != null && delta <= maxDrawdownDelta;
    if (shouldRollback) {
      await saveOverrides(state.lastConfigOptimization.previousOverrides);
      events.push({
        type: "paper_config_rollback",
        at: new Date().toISOString(),
        reason: "material_underperformance_after_config_optimization",
        baselineMeanPnlPct: baseline,
        recentMeanPnlPct: mean,
        delta,
        samples: pnl.length,
      });
    }
  }

  await writeJsonReport("self-improvement-rollback-report", {
    generatedAt: new Date().toISOString(),
    lookbackDays,
    minSamples,
    maxDrawdownDelta,
    events,
    paperTradeOutcomesByScoreBand: bandStats,
    rollbackRecommendation,
    note: "rollbackRecommendation is advisory; automatic rollback only runs when lastModelPromotion exists and drawdown gate fires (existing behavior).",
  });
}

export async function runSelfImprovementStatusReportJob(): Promise<void> {
  const activeModel = await prisma.mlModelRun.findFirst({
    where: { modelType: SHADOW_MODEL_TYPE, status: "ACTIVE" },
    orderBy: { updatedAt: "desc" },
    select: { id: true, targetLabel: true, updatedAt: true },
  });
  const overrides = await loadOverrides();
  const cfg: PaperTradingConfig = getPaperTradingConfig();
  await writeJsonReport("self-improvement-status-report", {
    generatedAt: new Date().toISOString(),
    activeModel,
    activePaperConfig: {
      threshold: cfg.threshold,
      maxDailyNewTrades: cfg.maxDailyNewTrades,
      cooldownHours: cfg.cooldownHours,
      cooldownMarketHours: cfg.cooldownMarketHours,
      relaxedConcentrationMaxPerTick: cfg.relaxedConcentrationMaxPerTick,
      relaxedConcentrationMaxPerDay: cfg.relaxedConcentrationMaxPerDay,
      relaxedConcentrationMaxOpenPerMarket: cfg.relaxedConcentrationMaxOpenPerMarket,
      relaxedConcentrationMaxOpenPerTheme: cfg.relaxedConcentrationMaxOpenPerTheme,
      relaxedConcentrationStakeNotional: cfg.relaxedConcentrationStakeNotional,
    },
    optimizerOverrides: overrides,
  });
  const { writeSelfImprovingLoopStatusReports } = await import("./self-improving-loop-status");
  await writeSelfImprovingLoopStatusReports();
}

