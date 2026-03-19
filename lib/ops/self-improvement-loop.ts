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

export async function runShadowDatasetRefreshJob(): Promise<void> {
  const limit = envInt("SELF_IMPROVE_DATASET_BUILD_LIMIT", 1_500);
  const res = await persistShadowTrainingExamples({
    limit,
    evaluatedOnly: true,
  });
  await writeJsonReport("model-dataset-refresh-report", {
    generatedAt: new Date().toISOString(),
    limit,
    result: res,
  });
}

export async function runShadowRetrainJob(): Promise<void> {
  const targetLabel = (process.env.SELF_IMPROVE_TARGET_LABEL ?? "labelGoodDecision12h") as
    | "labelGoodDecision"
    | "labelMissedOpportunity"
    | "labelGoodDecision6h"
    | "labelGoodDecision12h";
  const limit = envInt("SELF_IMPROVE_TRAIN_LIMIT", 5000);
  const trainRatio = envNum("SELF_IMPROVE_TRAIN_RATIO", 0.8);
  const result = await trainShadowModel(targetLabel, { limit, trainRatio });
  if (!result.success) {
    throw new Error(`self_improve_train_failed:${result.error ?? "unknown"}`);
  }
  await writeJsonReport("model-training-report", {
    generatedAt: new Date().toISOString(),
    targetLabel,
    limit,
    trainRatio,
    result,
  });
}

export async function runShadowEvaluateAndPromoteJob(): Promise<void> {
  const minSamples = envInt("SELF_IMPROVE_MIN_EVAL_SAMPLES", 250);
  const holdoutDays = envInt("SELF_IMPROVE_HOLDOUT_DAYS", 14);
  const minAucDelta = envNum("SELF_IMPROVE_MIN_AUC_DELTA", 0.01);
  const minF1Delta = envNum("SELF_IMPROVE_MIN_F1_DELTA", 0.01);
  const minPositiveRate = envNum("SELF_IMPROVE_MIN_POSITIVE_RATE", 0.05);
  const minNegativeRate = envNum("SELF_IMPROVE_MIN_NEGATIVE_RATE", 0.05);

  const active = await getActiveOrApprovedShadowModel();
  if (!active?.run.id) {
    await writeJsonReport("model-promotion-report", {
      generatedAt: new Date().toISOString(),
      status: "skipped",
      reason: "no_active_or_approved_shadow_champion",
      hint: "Activate or approve a shadow model first: POST /api/ml/activate-latest-shadow or POST /api/ml/approve-run with a shadow runId.",
    });
    return;
  }
  const champion = await prisma.mlModelRun.findUnique({ where: { id: active.run.id } });
  if (!champion?.metricsJson) throw new Error("self_improve_champion_not_found");

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
    await writeJsonReport("model-promotion-report", {
      generatedAt: new Date().toISOString(),
      status: "skipped",
      reason: "no_trained_challenger",
      championModelRunId: champion.id,
    });
    return;
  }

  const championModel = modelFromMetricsJson(champion.metricsJson);
  const challengerModel = modelFromMetricsJson(challenger.metricsJson);
  if (!championModel || !challengerModel) {
    throw new Error("self_improve_unusable_model_artifact");
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
    promoteReason = promoted ? "promoted" : "metric_delta_below_threshold";
  } else {
    promoteReason = "noisy_or_insufficient_data";
  }

  if (promoted) {
    await prisma.$transaction(async (tx) => {
      await tx.mlModelRun.updateMany({
        where: { modelType: SHADOW_MODEL_TYPE, status: "ACTIVE", id: { not: challenger.id } },
        data: { status: "VALIDATED" },
      });
      await tx.mlModelRun.update({
        where: { id: challenger.id },
        data: { status: "ACTIVE" },
      });
    });

    const baseline = await getMeanClosedPaperPnlPct(envInt("SELF_IMPROVE_BASELINE_LOOKBACK_DAYS", 7));
    const state = await loadState();
    state.lastModelPromotion = {
      at: new Date().toISOString(),
      previousModelRunId: champion.id,
      promotedModelRunId: challenger.id,
      baselineMeanPnlPct: baseline.mean,
      baselineSamples: baseline.samples,
    };
    await saveState(state);
  }

  await writeJsonReport("model-promotion-report", {
    generatedAt: new Date().toISOString(),
    championModelRunId: champion.id,
    challengerModelRunId: challenger.id,
    promoted,
    reason: promoteReason,
    guardrails: {
      minSamples,
      holdoutDays,
      minAucDelta,
      minF1Delta,
      minPositiveRate,
      minNegativeRate,
    },
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

export async function runSelfImprovementRollbackGuardJob(): Promise<void> {
  const state = await loadState();
  const minSamples = envInt("SELF_IMPROVE_ROLLBACK_MIN_SAMPLES", 30);
  const maxDrawdownDelta = envNum("SELF_IMPROVE_ROLLBACK_MEAN_PNL_DELTA", -0.015);
  const lookbackDays = envInt("SELF_IMPROVE_ROLLBACK_LOOKBACK_DAYS", 5);
  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
  const events: Array<Record<string, unknown>> = [];

  if (state.lastModelPromotion) {
    const promoted = state.lastModelPromotion.promotedModelRunId;
    const rows = await prisma.paperTrade.findMany({
      where: { modelRunId: promoted, status: "closed", exitTime: { gte: since } },
      select: { pnlPct: true },
    });
    const pnl = rows.map((r) => asNum(r.pnlPct)).filter((v): v is number => v != null);
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
}

