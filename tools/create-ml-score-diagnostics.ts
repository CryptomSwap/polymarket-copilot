/**
 * Read-only audit: ML score saturation, calibration vs raw, feature health, label coverage.
 * Does not change training, models, thresholds, or runtime.
 *
 * Run: npm run dump:ml-score-diagnostics
 *      npx tsx tools/create-ml-score-diagnostics.ts
 *
 * Outputs: dump/ml-score-diagnostics.{json,md}, dump/ml-score-diagnostics-chat-summary.md
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import { getLogisticFeatureImportance, type LogisticRegressionModel } from "../lib/ml/baseline";
import { getActiveOrApprovedShadowModel } from "../lib/ml/shadow-score/score-live";
import {
  SHADOW_FEATURE_NAMES,
  toShadowFeatureVector,
  type ShadowFeatureInput,
} from "../lib/ml/shadow-train/features";

function coefAlignedFeatureNames(model: LogisticRegressionModel): string[] {
  const idxs = model.activeFeatureIdxs;
  if (idxs && idxs.length === model.coefficients.length) {
    return idxs.map((i) => SHADOW_FEATURE_NAMES[i] ?? `f${i}`);
  }
  if (model.coefficients.length === SHADOW_FEATURE_NAMES.length) {
    return [...SHADOW_FEATURE_NAMES];
  }
  return model.coefficients.map((_, i) => SHADOW_FEATURE_NAMES[i] ?? `f${i}`);
}

const DUMP_DIR = path.join(process.cwd(), "dump");
const OUT_JSON = path.join(DUMP_DIR, "ml-score-diagnostics.json");
const OUT_MD = path.join(DUMP_DIR, "ml-score-diagnostics.md");
const OUT_CHAT = path.join(DUMP_DIR, "ml-score-diagnostics-chat-summary.md");

const LOOKBACK_DAYS = Number(process.env.ML_SCORE_DIAGNOSTICS_LOOKBACK_DAYS ?? 90);
const TARGET_BOTS = ["strict_quality", "relaxed_edge", "tail_extremes"] as const;

type NullableStr = string | null | undefined;

type ExampleSelect = {
  policyState: string | null;
  sizeMultiplier: string | null;
  finalSuggestedSize: string | null;
  eligibilityBlockersCount: number;
  reducedSizeIndicator: boolean;
  blockedIndicator: boolean;
  executionAllow: boolean | null;
  executionWarningCount: number;
  qualityState: string | null;
  spreadBps: string | null;
  estimatedSlippage: string | null;
  tradable: boolean | null;
  grossExposure: string | null;
  totalOpenExposure: string | null;
  maxSingleMarketConcentrationPct: string | null;
  maxSingleThemeConcentrationPct: string | null;
  portfolioRiskFlagsCount: number;
  runtimeWarningCount: number;
  runtimeBlockingCount: number;
  intendedPrice: string;
  intendedSize: string;
  recommendationPresent: boolean;
  side: string;
  outcomeBlockedVsAllowedVsSubmitted: string | null;
  momentum1hBps: string | null;
  momentum6hBps: string | null;
  volatility1hBps: string | null;
  volatility6hBps: string | null;
  distanceFromMid: string | null;
  timeToCloseHours: string | null;
  liquidityTrend: string | null;
};

function mean(nums: number[]): number | null {
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function stddevSample(nums: number[]): number | null {
  if (nums.length < 2) return null;
  const m = mean(nums)!;
  const v = nums.reduce((s, x) => s + (x - m) * (x - m), 0) / (nums.length - 1);
  return Math.sqrt(v);
}

function quantileSorted(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

function distributionStats(values: number[]): {
  count: number;
  min: number | null;
  p10: number | null;
  p25: number | null;
  p50: number | null;
  p75: number | null;
  p90: number | null;
  max: number | null;
} {
  const finite = values.filter((x) => Number.isFinite(x));
  if (finite.length === 0) {
    return {
      count: 0,
      min: null,
      p10: null,
      p25: null,
      p50: null,
      p75: null,
      p90: null,
      max: null,
    };
  }
  const s = [...finite].sort((a, b) => a - b);
  return {
    count: s.length,
    min: s[0]!,
    p10: quantileSorted(s, 0.1),
    p25: quantileSorted(s, 0.25),
    p50: quantileSorted(s, 0.5),
    p75: quantileSorted(s, 0.75),
    p90: quantileSorted(s, 0.9),
    max: s[s.length - 1]!,
  };
}

const HIST_BUCKETS = ["<0.5", "0.5–0.7", "0.7–0.9", "0.9–0.99", "0.99–0.999", "0.999+"] as const;

function histogramCounts(values: number[]): Record<(typeof HIST_BUCKETS)[number], number> {
  const out: Record<string, number> = {};
  for (const b of HIST_BUCKETS) out[b] = 0;
  for (const x of values) {
    if (!Number.isFinite(x)) continue;
    if (x < 0.5) out["<0.5"]!++;
    else if (x < 0.7) out["0.5–0.7"]!++;
    else if (x < 0.9) out["0.7–0.9"]!++;
    else if (x < 0.99) out["0.9–0.99"]!++;
    else if (x < 0.999) out["0.99–0.999"]!++;
    else out["0.999+"]!++;
  }
  return out as Record<(typeof HIST_BUCKETS)[number], number>;
}

function pearson(xs: number[], ys: number[]): number | null {
  if (xs.length !== ys.length || xs.length < 3) return null;
  const mx = mean(xs);
  const my = mean(ys);
  if (mx == null || my == null) return null;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < xs.length; i++) {
    const vx = xs[i]! - mx;
    const vy = ys[i]! - my;
    num += vx * vy;
    dx += vx * vx;
    dy += vy * vy;
  }
  const den = Math.sqrt(dx * dy);
  return den > 1e-15 ? num / den : null;
}

function parseCalibrationFromPaperMetadata(metadataJson: string | null): {
  raw: number | null;
  calibrated: number | null;
  admission: number | null;
  logit: number | null;
  usedCalibratedForAdmission: boolean | null;
} {
  if (!metadataJson) {
    return { raw: null, calibrated: null, admission: null, logit: null, usedCalibratedForAdmission: null };
  }
  try {
    const o = JSON.parse(metadataJson) as Record<string, unknown>;
    let cal = o.paperShadowScoreCalibration as Record<string, unknown> | undefined;
    if (!cal && o.openAttribution && typeof o.openAttribution === "object") {
      cal = (o.openAttribution as Record<string, unknown>).paperShadowScoreCalibration as
        | Record<string, unknown>
        | undefined;
    }
    if (!cal || typeof cal !== "object") {
      return { raw: null, calibrated: null, admission: null, logit: null, usedCalibratedForAdmission: null };
    }
    const num = (k: string): number | null => {
      const v = cal![k];
      if (typeof v === "number" && Number.isFinite(v)) return v;
      if (v != null) {
        const n = parseFloat(String(v));
        return Number.isFinite(n) ? n : null;
      }
      return null;
    };
    const u = cal.usedCalibratedForAdmission;
    return {
      raw: num("shadowMlScoreRaw"),
      calibrated: num("shadowMlScoreCalibrated"),
      admission: num("admissionScore"),
      logit: num("shadowMlLogit"),
      usedCalibratedForAdmission: u === true ? true : u === false ? false : null,
    };
  } catch {
    return { raw: null, calibrated: null, admission: null, logit: null, usedCalibratedForAdmission: null };
  }
}

function parseRecommendationId(metadataJson: string | null): string | null {
  if (!metadataJson) return null;
  try {
    const o = JSON.parse(metadataJson) as Record<string, unknown>;
    const id = o.recommendationId;
    return typeof id === "string" ? id : null;
  } catch {
    return null;
  }
}

function outcomeTri(
  s: string | null | undefined
): ShadowFeatureInput["outcomeBlockedVsAllowedVsSubmitted"] {
  if (s === "blocked" || s === "allowed" || s === "submitted") return s;
  return null;
}

function exampleToInput(r: ExampleSelect): ShadowFeatureInput {
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
    outcomeBlockedVsAllowedVsSubmitted: outcomeTri(r.outcomeBlockedVsAllowedVsSubmitted),
    momentum1hBps: r.momentum1hBps,
    momentum6hBps: r.momentum6hBps,
    volatility1hBps: r.volatility1hBps,
    volatility6hBps: r.volatility6hBps,
    distanceFromMid: r.distanceFromMid,
    timeToCloseHours: r.timeToCloseHours,
    liquidityTrend: r.liquidityTrend,
  };
}

/** DB null on nullable string fields used by the shadow vector (coalesced to 0 in model). */
function pctMissingStringFields(r: ExampleSelect): boolean {
  const fields: NullableStr[] = [
    r.sizeMultiplier,
    r.finalSuggestedSize,
    r.spreadBps,
    r.estimatedSlippage,
    r.grossExposure,
    r.totalOpenExposure,
    r.maxSingleMarketConcentrationPct,
    r.maxSingleThemeConcentrationPct,
    r.momentum1hBps,
    r.momentum6hBps,
    r.volatility1hBps,
    r.volatility6hBps,
    r.distanceFromMid,
    r.timeToCloseHours,
    r.liquidityTrend,
  ];
  return fields.some((x) => x == null || String(x).trim() === "");
}

function redactDatabaseUrl(raw: string | undefined): { display: string; isMissing: boolean } {
  if (raw == null || String(raw).trim() === "") {
    return { display: "(DATABASE_URL missing or empty)", isMissing: true };
  }
  try {
    const u = new URL(String(raw).trim());
    const db = (u.pathname || "/").replace(/^\//, "").split("?")[0] || "(database)";
    return { display: `${u.protocol}//${u.hostname}:${u.port || "5432"}/${db}`, isMissing: false };
  } catch {
    return { display: "(invalid DATABASE_URL)", isMissing: false };
  }
}

function buildScoreSection(values: number[], label: string) {
  return {
    label,
    distribution: distributionStats(values),
    histogram: histogramCounts(values),
  };
}

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });

  const urlInfo = redactDatabaseUrl(process.env.DATABASE_URL);
  if (urlInfo.isMissing) {
    console.error("DATABASE_URL missing. Set in .env at project root.");
    process.exit(1);
  }
  try {
    await prisma.$connect();
    await prisma.$queryRawUnsafe("SELECT 1");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("DB unreachable:", msg);
    console.error("Redacted URL:", urlInfo.display);
    process.exit(1);
  }

  try {
  const from = new Date();
  from.setDate(from.getDate() - LOOKBACK_DAYS);

  const paperRows = await prisma.paperTrade.findMany({
    where: { entryTime: { gte: from } },
    select: {
      id: true,
      botType: true,
      score: true,
      metadataJson: true,
      assetId: true,
      side: true,
    },
  });

  const shadowRowsForLabelJoin = await prisma.mlShadowTrainingExample.findMany({
    where: {},
    select: {
      recommendationId: true,
      assetId: true,
      side: true,
      labelGoodDecision12h: true,
      updatedAt: true,
    },
    orderBy: { updatedAt: "desc" },
  });

  const labelByKey = new Map<string, boolean>();
  for (const row of shadowRowsForLabelJoin) {
    const recId = row.recommendationId ?? "";
    const key = `${recId}|${row.assetId}|${row.side}`;
    if (labelByKey.has(key)) continue;
    if (row.labelGoodDecision12h === null) continue;
    labelByKey.set(key, row.labelGoodDecision12h);
  }

  type EnrichedPaper = {
    botType: string;
    paperTradeScore: number;
    rawFromMeta: number | null;
    calibrated: number | null;
    admission: number | null;
    hasCalibrationBlock: boolean;
  };

  const enriched: EnrichedPaper[] = [];
  let labeledPaperCount = 0;

  for (const t of paperRows) {
    const cal = parseCalibrationFromPaperMetadata(t.metadataJson);
    const ptScore = Number.isFinite(t.score) ? t.score : NaN;
    const rawEffective = cal.raw ?? (Number.isFinite(ptScore) ? ptScore : null);
    const hasBlock =
      cal.raw != null ||
      cal.calibrated != null ||
      cal.admission != null ||
      (cal.logit != null && Number.isFinite(cal.logit));

    const recId = parseRecommendationId(t.metadataJson);
    const key = recId != null ? `${recId}|${t.assetId}|${t.side}` : null;
    if (key != null && labelByKey.has(key)) labeledPaperCount++;

    enriched.push({
      botType: t.botType,
      paperTradeScore: ptScore,
      rawFromMeta: cal.raw,
      calibrated: cal.calibrated,
      admission: cal.admission,
      hasCalibrationBlock: hasBlock,
    });
  }

  const rawSeries: number[] = [];
  const calSeries: number[] = [];
  const admSeries: number[] = [];
  const ptSeries: number[] = [];

  for (const e of enriched) {
    const raw = e.rawFromMeta ?? (Number.isFinite(e.paperTradeScore) ? e.paperTradeScore : null);
    if (raw != null) rawSeries.push(raw);
    if (e.calibrated != null) calSeries.push(e.calibrated);
    const adm =
      e.admission ??
      e.calibrated ??
      (e.rawFromMeta ?? (Number.isFinite(e.paperTradeScore) ? e.paperTradeScore : null));
    if (adm != null) admSeries.push(adm);
    if (Number.isFinite(e.paperTradeScore)) ptSeries.push(e.paperTradeScore);
  }

  const pairedRawCal: { raw: number; cal: number }[] = [];
  for (const e of enriched) {
    if (e.rawFromMeta != null && e.calibrated != null) {
      pairedRawCal.push({ raw: e.rawFromMeta, cal: e.calibrated });
    }
  }

  const corrRawCal = pearson(
    pairedRawCal.map((p) => p.raw),
    pairedRawCal.map((p) => p.cal)
  );
  const stdRaw = stddevSample(pairedRawCal.map((p) => p.raw));
  const stdCal = stddevSample(pairedRawCal.map((p) => p.cal));
  const meanAbsDiff =
    pairedRawCal.length > 0
      ? mean(pairedRawCal.map((p) => Math.abs(p.cal - p.raw)))
      : null;

  const calibrationBlock = {
    note:
      "Raw = shadow logistic proba (sigmoid(z)) per ShadowScoreResult.shadowMlScore; PaperTrade.score column matches that raw at open. Calibrated = temperature-scaled proba when stored in openAttribution.paperShadowScoreCalibration.",
    rowsWithCalibrationMetadata: enriched.filter((e) => e.hasCalibrationBlock).length,
    paperTradesTotal: enriched.length,
    pairedRawVsCalibratedCount: pairedRawCal.length,
    pearsonRawVsCalibrated: corrRawCal,
    stddevRawPaired: stdRaw,
    stddevCalibratedPaired: stdCal,
    spreadChangeStd: stdRaw != null && stdCal != null ? stdCal - stdRaw : null,
    minRawPaired: pairedRawCal.length ? Math.min(...pairedRawCal.map((p) => p.raw)) : null,
    maxRawPaired: pairedRawCal.length ? Math.max(...pairedRawCal.map((p) => p.raw)) : null,
    minCalPaired: pairedRawCal.length ? Math.min(...pairedRawCal.map((p) => p.cal)) : null,
    maxCalPaired: pairedRawCal.length ? Math.max(...pairedRawCal.map((p) => p.cal)) : null,
    meanAbsoluteDifferenceRawCalibrated: meanAbsDiff,
  };

  const overall = {
    lookbackDays: LOOKBACK_DAYS,
    paperTradesAnalyzed: paperRows.length,
    scoreDistribution: {
      rawLogisticProba: buildScoreSection(rawSeries, "shadowMlScoreRaw or PaperTrade.score fallback"),
      shadowMlScoreCalibrated: buildScoreSection(calSeries, "shadowMlScoreCalibrated (metadata)"),
      admissionScore: buildScoreSection(admSeries, "admissionScore or fallbacks"),
      paperTradeScoreColumn: buildScoreSection(ptSeries, "PaperTrade.score column"),
    },
    calibration: calibrationBlock,
  };

  function perBotStats(bot: string) {
    const sub = enriched.filter((e) => e.botType === bot);
    const r: number[] = [];
    const c: number[] = [];
    const a: number[] = [];
    const p: number[] = [];
    for (const e of sub) {
      const raw = e.rawFromMeta ?? (Number.isFinite(e.paperTradeScore) ? e.paperTradeScore : null);
      if (raw != null) r.push(raw);
      if (e.calibrated != null) c.push(e.calibrated);
      const adm =
        e.admission ??
        e.calibrated ??
        (e.rawFromMeta ?? (Number.isFinite(e.paperTradeScore) ? e.paperTradeScore : null));
      if (adm != null) a.push(adm);
      if (Number.isFinite(e.paperTradeScore)) p.push(e.paperTradeScore);
    }
    return {
      botType: bot,
      tradeCount: sub.length,
      rawLogisticProba: buildScoreSection(r, "raw"),
      shadowMlScoreCalibrated: buildScoreSection(c, "calibrated"),
      admissionScore: buildScoreSection(a, "admission"),
      paperTradeScoreColumn: buildScoreSection(p, "PaperTrade.score"),
    };
  }

  const perBot = TARGET_BOTS.map((b) => perBotStats(b));
  const p50rawByBot = Object.fromEntries(
    perBot.map((b) => [b.botType, b.rawLogisticProba.distribution.p50])
  );
  const p50s = Object.values(p50rawByBot).filter((x): x is number => x != null && Number.isFinite(x));
  const p50Spread = p50s.length >= 2 ? Math.max(...p50s) - Math.min(...p50s) : null;

  const perBotComparison = {
    p50rawByBot,
    maxMinusMinP50RawAcrossBots: p50Spread,
    interpretation:
      (p50Spread != null && p50Spread < 0.02
        ? "Very similar median raw scores across bots — distributions may be dominated by the same model output, not bot policy."
        : "Meaningful spread in median raw scores across bots — bot filters may shift admitted score mass.") +
      " Compare histograms for saturation patterns per bot.",
  };

  const examples = (await prisma.mlShadowTrainingExample.findMany({
    where: { createdAt: { gte: from } },
    select: {
      policyState: true,
      sizeMultiplier: true,
      finalSuggestedSize: true,
      eligibilityBlockersCount: true,
      reducedSizeIndicator: true,
      blockedIndicator: true,
      executionAllow: true,
      executionWarningCount: true,
      qualityState: true,
      spreadBps: true,
      estimatedSlippage: true,
      tradable: true,
      grossExposure: true,
      totalOpenExposure: true,
      maxSingleMarketConcentrationPct: true,
      maxSingleThemeConcentrationPct: true,
      portfolioRiskFlagsCount: true,
      runtimeWarningCount: true,
      runtimeBlockingCount: true,
      intendedPrice: true,
      intendedSize: true,
      recommendationPresent: true,
      side: true,
      outcomeBlockedVsAllowedVsSubmitted: true,
      momentum1hBps: true,
      momentum6hBps: true,
      volatility1hBps: true,
      volatility6hBps: true,
      distanceFromMid: true,
      timeToCloseHours: true,
      liquidityTrend: true,
    },
  })) as ExampleSelect[];

  const nEx = examples.length;
  const dim = SHADOW_FEATURE_NAMES.length;
  const cols: number[][] = Array.from({ length: dim }, () => []);
  let missingAnyPathFieldRows = 0;

  for (const ex of examples) {
    if (pctMissingStringFields(ex)) missingAnyPathFieldRows++;
    const vec = toShadowFeatureVector(exampleToInput(ex));
    for (let i = 0; i < dim; i++) {
      cols[i]!.push(vec[i] ?? 0);
    }
  }

  const featureSnapshots = SHADOW_FEATURE_NAMES.map((name, i) => {
    const v = cols[i]!;
    const m = mean(v);
    const sd = stddevSample(v);
    const zeros = v.filter((x) => x === 0).length;
    const constEps = 1e-12;
    const isConstant = v.length > 0 && sd != null && sd < constEps;
    return {
      featureIndex: i,
      featureName: name,
      mean: m,
      variance: sd != null ? sd * sd : null,
      stddev: sd,
      pctZero: v.length ? zeros / v.length : null,
      pctConstantApprox: isConstant ? 1 : 0,
      degenerateHint: isConstant ? "near_constant" : zeros / (v.length || 1) > 0.95 ? "mostly_zero" : null,
    };
  });

  const degenerateCount = featureSnapshots.filter(
    (f) => f.degenerateHint != null
  ).length;

  let activeModelRanking: {
    modelRunId: string;
    featureSetName: string;
    targetLabel: string;
    topN: number;
    byAbsCoefficient: Array<{ name: string; coefficient: number; absCoefficient: number }>;
  } | null = null;
  try {
    const active = await getActiveOrApprovedShadowModel();
    if (active) {
      const names = coefAlignedFeatureNames(active.model);
      const ranked = getLogisticFeatureImportance(active.model, names);
      activeModelRanking = {
        modelRunId: active.run.id,
        featureSetName: active.run.featureSetName,
        targetLabel: active.run.targetLabel,
        topN: 15,
        byAbsCoefficient: ranked.slice(0, 15),
      };
    }
  } catch {
    activeModelRanking = null;
  }

  const featureInfluence = {
    activeShadowModel: activeModelRanking,
    activeShadowModelNote:
      "Read-only: latest ACTIVE/APPROVED logistic_regression_shadow run; coefficients ordered by |coef| (same helper as training diagnostics).",
    source:
      "MlShadowTrainingExample rows in lookback; vectors via toShadowFeatureVector (same as training/scoring). Order matches SHADOW_FEATURE_NAMES.",
    exampleRowCount: nEx,
    rowsWithAnyNullablePathStringEmpty: missingAnyPathFieldRows,
    pctRowsWithAnyNullablePathStringEmpty: nEx ? missingAnyPathFieldRows / nEx : null,
    topNFeaturesListed: SHADOW_FEATURE_NAMES.length,
    features: featureSnapshots,
    summary: {
      featuresMostlyZero: featureSnapshots.filter((f) => (f.pctZero ?? 0) > 0.9).length,
      featuresNearConstant: featureSnapshots.filter((f) => f.degenerateHint === "near_constant").length,
      degenerateFeatureCount: degenerateCount,
    },
  };

  const labelCoverage = {
    paperTradesTotal: paperRows.length,
    paperTradesWithJoinedLabelGoodDecision12h: labeledPaperCount,
    labelCoverageRate: paperRows.length ? labeledPaperCount / paperRows.length : null,
    note: "Join: metadata.recommendationId + PaperTrade.assetId + side → MlShadowTrainingExample.labelGoodDecision12h (first non-null by updatedAt desc over all examples, same as paper-score-alignment).",
  };

  const hist999Raw = overall.scoreDistribution.rawLogisticProba.histogram["0.999+"];
  const share999 = rawSeries.length ? hist999Raw / rawSeries.length : 0;
  const p90raw = overall.scoreDistribution.rawLogisticProba.distribution.p90;

  const satAdmission = overall.scoreDistribution.admissionScore.histogram["0.999+"];
  const share999Adm = admSeries.length ? satAdmission / admSeries.length : 0;

  const scoreSaturated =
    share999 > 0.15 || (p90raw != null && p90raw >= 0.995) || share999Adm > 0.15;

  const calibrationEffective =
    pairedRawCal.length >= 20 &&
    meanAbsDiff != null &&
    meanAbsDiff > 0.002 &&
    (corrRawCal == null || corrRawCal < 0.9995);

  const featuresDegenerate =
    degenerateCount > dim * 0.35 ||
    featureSnapshots.filter((f) => (f.pctZero ?? 0) > 0.95).length > dim * 0.4;

  const labelCoverageSufficient =
    (labelCoverage.labelCoverageRate ?? 0) >= 0.25 && paperRows.length >= 30;

  const interpretation = {
    scoreSaturated: scoreSaturated,
    scoreSaturatedExplanation: scoreSaturated
      ? "High mass in upper tail (e.g. ≥0.999 or very high p90) on raw and/or admission scores."
      : "Upper-tail mass is moderate in this window; still inspect histograms.",
    calibrationEffective: calibrationEffective,
    calibrationExplanation:
      pairedRawCal.length < 20
        ? "Too few paired raw/calibrated rows to judge calibration layer."
        : calibrationEffective
          ? "Raw vs calibrated differ meaningfully (correlation < ~1 or non-trivial mean |Δ|)."
          : "Raw and calibrated are almost identical in this sample (temperature may be ~1 or few cal rows).",
    featuresDegenerate: featuresDegenerate,
    featuresExplanation:
      degenerateCount > 0
        ? `${degenerateCount} features show near-constant or >90% zeros in training examples window.`
        : "No strong degeneracy flags on zero/constant heuristics.",
    labelCoverageSufficient: labelCoverageSufficient,
    labelExplanation:
      (labelCoverage.labelCoverageRate ?? 0) < 0.25
        ? "Low fraction of paper trades join to a non-null labelGoodDecision12h."
        : "Label join rate is usable for weak supervision context.",
  };

  const report = {
    generatedAt: new Date().toISOString(),
    lookbackDays: LOOKBACK_DAYS,
    dataSources: {
      paperTrades: "PaperTrade where entryTime >= lookback (scores + metadataJson).",
      calibrationFields:
        "metadataJson.openAttribution.paperShadowScoreCalibration (shadowMlScoreRaw, shadowMlScoreCalibrated, admissionScore, shadowMlLogit).",
      shadowExamples:
        "MlShadowTrainingExample where createdAt >= lookback — feature vectors + label map for paper join.",
      modelFeatureList: "lib/ml/shadow-train/features.ts SHADOW_FEATURE_NAMES + toShadowFeatureVector",
      activeModelCoefficients: "getActiveOrApprovedShadowModel + getLogisticFeatureImportance (read-only)",
    },
    overall,
    perBotScoreDistribution: perBot,
    perBotComparison,
    featureInfluence,
    labelCoverage,
    interpretation,
  };

  await fs.writeFile(OUT_JSON, JSON.stringify(report, null, 2), "utf8");

  const md: string[] = [];
  md.push("# ML score diagnostics (read-only)");
  md.push("");
  md.push(`**Generated:** ${report.generatedAt}`);
  md.push(`**Lookback:** ${LOOKBACK_DAYS}d`);
  md.push("");
  md.push("## Interpretation (auto)");
  md.push("");
  md.push(`| Question | Answer |`);
  md.push("|----------|--------|");
  md.push(`| Score saturated? | **${interpretation.scoreSaturated ? "yes" : "no"}** — ${interpretation.scoreSaturatedExplanation} |`);
  md.push(`| Calibration effective? | **${interpretation.calibrationEffective ? "yes" : "no"}** — ${interpretation.calibrationExplanation} |`);
  md.push(`| Features degenerate? | **${interpretation.featuresDegenerate ? "yes" : "no"}** — ${interpretation.featuresExplanation} |`);
  md.push(`| Label coverage sufficient? | **${interpretation.labelCoverageSufficient ? "yes" : "no"}** — ${interpretation.labelExplanation} |`);
  md.push("");
  md.push("## Overall raw logistic proba (histogram)");
  md.push("");
  md.push(JSON.stringify(overall.scoreDistribution.rawLogisticProba.histogram, null, 2));
  md.push("");
  md.push("## Calibration (paired raw vs calibrated)");
  md.push("");
  md.push(`- n paired: ${calibrationBlock.pairedRawVsCalibratedCount}`);
  md.push(`- Pearson ρ: ${calibrationBlock.pearsonRawVsCalibrated ?? "—"}`);
  md.push(`- std raw / std cal: ${calibrationBlock.stddevRawPaired ?? "—"} / ${calibrationBlock.stddevCalibratedPaired ?? "—"}`);
  md.push(`- mean |cal−raw|: ${calibrationBlock.meanAbsoluteDifferenceRawCalibrated ?? "—"}`);
  md.push("");
  md.push("## Per-bot p50 (raw)");
  md.push("");
  md.push(JSON.stringify(p50rawByBot, null, 2));
  md.push("");
  md.push("## Feature issues (degenerate hints)");
  md.push("");
  for (const f of featureSnapshots.filter((x) => x.degenerateHint != null)) {
    md.push(`- **${f.featureName}**: ${f.degenerateHint} (pctZero=${((f.pctZero ?? 0) * 100).toFixed(1)}%)`);
  }
  md.push("");
  md.push("## Active model — top |coefficient| (read-only)");
  md.push("");
  if (activeModelRanking) {
    md.push(`Model run: \`${activeModelRanking.modelRunId}\` · ${activeModelRanking.featureSetName} · ${activeModelRanking.targetLabel}`);
    md.push("");
    md.push("| feature | coef | |coef| |");
    md.push("|---------|-----:|-------:|");
    for (const row of activeModelRanking.byAbsCoefficient) {
      md.push(`| ${row.name} | ${row.coefficient.toFixed(6)} | ${row.absCoefficient.toFixed(6)} |`);
    }
  } else {
    md.push("_No ACTIVE/APPROVED shadow model with parseable metricsJson._");
  }
  md.push("");
  md.push("## Label coverage");
  md.push("");
  md.push(`- Paper trades: ${labelCoverage.paperTradesTotal}`);
  md.push(`- With joined label: ${labelCoverage.paperTradesWithJoinedLabelGoodDecision12h} (${((labelCoverage.labelCoverageRate ?? 0) * 100).toFixed(1)}%)`);
  md.push("");
  md.push(`Full JSON: \`${OUT_JSON}\``);

  await fs.writeFile(OUT_MD, md.join("\n"), "utf8");

  const chat: string[] = [];
  chat.push("# ML score diagnostics — chat summary");
  chat.push("");
  chat.push("## 1. Score distribution (paper trades, raw logistic proba)");
  chat.push("");
  chat.push("| stat | value |");
  chat.push("|------|-------|");
  const d = overall.scoreDistribution.rawLogisticProba.distribution;
  chat.push(`| n | ${d.count} |`);
  chat.push(`| p50 | ${d.p50 ?? "—"} |`);
  chat.push(`| p90 | ${d.p90 ?? "—"} |`);
  chat.push(`| max | ${d.max ?? "—"} |`);
  chat.push("");
  chat.push("Histogram (raw): " + JSON.stringify(overall.scoreDistribution.rawLogisticProba.histogram));
  chat.push("");
  chat.push("## 2. Saturation diagnosis");
  chat.push("");
  chat.push(interpretation.scoreSaturated ? "**Saturated (heuristic yes):** high 0.999+ share or very high p90." : "**Not clearly saturated** by heuristic (still check histogram).");
  chat.push("");
  chat.push("## 3. Calibration");
  chat.push("");
  chat.push(`- paired n: ${calibrationBlock.pairedRawVsCalibratedCount}, ρ=${calibrationBlock.pearsonRawVsCalibrated ?? "—"}, mean|Δ|=${calibrationBlock.meanAbsoluteDifferenceRawCalibrated ?? "—"}`);
  chat.push(`- **${interpretation.calibrationEffective ? "Shows measurable effect" : "Little separation raw vs cal"}** (${interpretation.calibrationExplanation})`);
  chat.push("");
  chat.push("## 4. Feature issues");
  chat.push("");
  chat.push(`- Shadow examples in window: ${nEx}`);
  chat.push(`- Features flagged degenerate (zero-dominant or near-constant): ${degenerateCount} / ${dim}`);
  if (activeModelRanking) {
    chat.push(
      `- Top |coefficient| (active model ${activeModelRanking.modelRunId.slice(0, 8)}…): ${activeModelRanking.byAbsCoefficient
        .slice(0, 5)
        .map((x) => x.name)
        .join(", ")}`
    );
  }
  chat.push("");
  chat.push("## 5. Label coverage");
  chat.push("");
  chat.push(`- ${labeledPaperCount} / ${paperRows.length} paper trades (${((labelCoverage.labelCoverageRate ?? 0) * 100).toFixed(1)}%) with labelGoodDecision12h join`);
  chat.push("");
  chat.push("## 6. Conclusion");
  chat.push("");
  chat.push(
    interpretation.scoreSaturated
      ? "Scores pile up near 1.0 in this window; inspect logit scale and temperature calibration plus feature saturation."
      : "Tail saturation is not extreme by quick heuristics; still review per-bot histograms and logits in JSON."
  );
  chat.push(
    featuresDegenerate
      ? " Many shadow inputs are zero-heavy or constant — model may have limited usable signal from those dimensions."
      : " Feature-wise degeneracy flags are moderate; see JSON for per-feature stats."
  );

  await fs.writeFile(OUT_CHAT, chat.join("\n"), "utf8");

  console.log("Wrote", OUT_JSON);
  console.log("Wrote", OUT_MD);
  console.log("Wrote", OUT_CHAT, "(paste into chat)");
  console.log("");
  console.log("IMPLEMENTATION SUMMARY:");
  console.log("- files created: tools/create-ml-score-diagnostics.ts");
  console.log("- files modified: package.json (script dump:ml-score-diagnostics)");
  console.log(
    "- data sources: PaperTrade (90d) scores/metadata; openAttribution.paperShadowScoreCalibration; MlShadowTrainingExample (90d) for features + label join"
  );
  console.log(
    `- key findings (heuristic): saturated=${scoreSaturated}, calibrationMoves=${calibrationEffective}, degenerateFeatures=${featuresDegenerate}, labelOk=${labelCoverageSufficient}`
  );
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
