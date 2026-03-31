/**
 * Read-only lineage audit: recommendation → MlShadowTrainingExample → features → scores → PaperTrade metadata → label join.
 * Does not change runtime, training, schema, or thresholds.
 *
 * Run: npx tsx tools/create-shadow-ml-data-lineage-audit.ts
 *      npm run dump:shadow-ml-data-lineage-audit
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import {
  SHADOW_FEATURE_NAMES,
  toShadowFeatureVector,
  type ShadowFeatureInput,
} from "../lib/ml/shadow-train/features";

const DUMP_DIR = path.join(process.cwd(), "dump");
const OUT_JSON = path.join(DUMP_DIR, "shadow-ml-data-lineage-audit.json");
const OUT_MD = path.join(DUMP_DIR, "shadow-ml-data-lineage-audit.md");
const OUT_CHAT = path.join(DUMP_DIR, "shadow-ml-data-lineage-audit-chat-summary.md");

const LOOKBACK_DAYS = Number(process.env.SHADOW_ML_LINEAGE_LOOKBACK_DAYS ?? 90);
const MAX_SAMPLES_PER_CATEGORY = 5;

type ExampleSelect = {
  id: string;
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
  recommendationId: string | null;
  assetId: string;
  labelGoodDecision12h: boolean | null;
  createdAt: Date;
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

function isBlankStr(s: string | null | undefined): boolean {
  return s == null || String(s).trim() === "";
}

/** Per SHADOW_FEATURE_NAMES index: true when upstream is null/empty before toShadowFeatureVector coerces to 0. */
function preCoercionMissing(r: ExampleSelect, featureIndex: number): boolean {
  switch (featureIndex) {
    case 0:
      return isBlankStr(r.sizeMultiplier);
    case 1:
      return isBlankStr(r.finalSuggestedSize);
    case 2:
      return false;
    case 3:
    case 4:
      return false;
    case 5:
      return r.executionAllow === null;
    case 6:
      return false;
    case 7:
      return isBlankStr(r.qualityState);
    case 8:
      return isBlankStr(r.spreadBps);
    case 9:
      return isBlankStr(r.estimatedSlippage);
    case 10:
      return r.tradable === null;
    case 11:
      return isBlankStr(r.grossExposure);
    case 12:
      return isBlankStr(r.totalOpenExposure);
    case 13:
      return isBlankStr(r.maxSingleMarketConcentrationPct);
    case 14:
      return isBlankStr(r.maxSingleThemeConcentrationPct);
    case 15:
    case 16:
    case 17:
      return false;
    case 18:
      return isBlankStr(r.intendedPrice);
    case 19:
      return isBlankStr(r.intendedSize);
    case 20:
      return false;
    case 21:
      return isBlankStr(r.side);
    case 22:
      return isBlankStr(r.policyState);
    case 23:
      return isBlankStr(r.outcomeBlockedVsAllowedVsSubmitted);
    case 24:
      return isBlankStr(r.momentum1hBps);
    case 25:
      return isBlankStr(r.momentum6hBps);
    case 26:
      return isBlankStr(r.volatility1hBps);
    case 27:
      return isBlankStr(r.volatility6hBps);
    case 28:
      return isBlankStr(r.distanceFromMid);
    case 29:
      return isBlankStr(r.timeToCloseHours);
    case 30:
      return isBlankStr(r.liquidityTrend);
    default:
      return false;
  }
}

const FEATURE_SOURCE_PATHS: string[] = SHADOW_FEATURE_NAMES.map((name, i) => {
  const base = "lib/ml/shadow-train/features.ts → toShadowFeatureVector → MlShadowTrainingExample.";
  const map: Record<string, string> = {
    sizeMultiplier: `${base}sizeMultiplier`,
    finalSuggestedSize: `${base}finalSuggestedSize`,
    eligibilityBlockersCount: `${base}eligibilityBlockersCount`,
    reducedSizeIndicator: `${base}reducedSizeIndicator`,
    blockedIndicator: `${base}blockedIndicator`,
    executionAllow: `${base}executionAllow (null → 0 in vector)`,
    executionWarningCount: `${base}executionWarningCount`,
    qualityStateEnc: `derived: enc(qualityState, QUALITY_STATE_ENC) same file`,
    spreadBps: `${base}spreadBps`,
    estimatedSlippage: `${base}estimatedSlippage`,
    tradable: `${base}tradable (only true → 1)`,
    grossExposure: `${base}grossExposure`,
    totalOpenExposure: `${base}totalOpenExposure`,
    maxSingleMarketConcentrationPct: `${base}maxSingleMarketConcentrationPct`,
    maxSingleThemeConcentrationPct: `${base}maxSingleThemeConcentrationPct`,
    portfolioRiskFlagsCount: `${base}portfolioRiskFlagsCount`,
    runtimeWarningCount: `${base}runtimeWarningCount`,
    runtimeBlockingCount: `${base}runtimeBlockingCount`,
    intendedPrice: `${base}intendedPrice`,
    intendedSize: `${base}intendedSize`,
    recommendationPresent: `${base}recommendationPresent`,
    sideEnc: `derived: side === BUY ? 1 : 0`,
    policyStateEnc: `derived: enc(policyState, POLICY_STATE_ENC)`,
    outcomeBlockedVsAllowedVsSubmittedEnc: `derived: OUTCOME_ENC[outcome…] or 0 if null`,
    momentum1hBps: `${base}momentum1hBps`,
    momentum6hBps: `${base}momentum6hBps`,
    volatility1hBps: `${base}volatility1hBps`,
    volatility6hBps: `${base}volatility6hBps`,
    distanceFromMid: `${base}distanceFromMid`,
    timeToCloseHours: `${base}timeToCloseHours`,
    liquidityTrend: `${base}liquidityTrend`,
  };
  return map[name] ?? `${base}(index ${i})`;
});

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

function parseRecommendationId(metadataJson: string | null): string | null {
  if (!metadataJson) return null;
  try {
    const o = JSON.parse(metadataJson) as Record<string, unknown>;
    const id = o.recommendationId;
    return typeof id === "string" && id.trim() !== "" ? id : null;
  } catch {
    return null;
  }
}

function parseCalibrationFromPaperMetadata(metadataJson: string | null): {
  raw: number | null;
  calibrated: number | null;
  admission: number | null;
} {
  if (!metadataJson) return { raw: null, calibrated: null, admission: null };
  try {
    const o = JSON.parse(metadataJson) as Record<string, unknown>;
    let cal = o.paperShadowScoreCalibration as Record<string, unknown> | undefined;
    if (!cal && o.openAttribution && typeof o.openAttribution === "object") {
      cal = (o.openAttribution as Record<string, unknown>).paperShadowScoreCalibration as
        | Record<string, unknown>
        | undefined;
    }
    if (!cal || typeof cal !== "object") return { raw: null, calibrated: null, admission: null };
    const num = (k: string): number | null => {
      const v = cal![k];
      if (typeof v === "number" && Number.isFinite(v)) return v;
      if (v != null) {
        const n = parseFloat(String(v));
        return Number.isFinite(n) ? n : null;
      }
      return null;
    };
    return {
      raw: num("shadowMlScoreRaw"),
      calibrated: num("shadowMlScoreCalibrated"),
      admission: num("admissionScore"),
    };
  } catch {
    return { raw: null, calibrated: null, admission: null };
  }
}

function redactDatabaseUrl(raw: string | undefined): { display: string; isMissing: boolean } {
  if (raw == null || String(raw).trim() === "") {
    return { display: "(DATABASE_URL missing)", isMissing: true };
  }
  try {
    const u = new URL(String(raw).trim());
    const db = (u.pathname || "/").replace(/^\//, "").split("?")[0] || "(db)";
    return { display: `${u.protocol}//${u.hostname}:${u.port || "5432"}/${db}`, isMissing: false };
  } catch {
    return { display: "(invalid URL)", isMissing: false };
  }
}

function pushSample(map: Map<string, string[]>, key: string, id: string): void {
  const arr = map.get(key) ?? [];
  if (arr.length < MAX_SAMPLES_PER_CATEGORY) arr.push(id);
  map.set(key, arr);
}

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });
  const urlInfo = redactDatabaseUrl(process.env.DATABASE_URL);
  if (urlInfo.isMissing) {
    console.error("DATABASE_URL missing.");
    process.exit(1);
  }
  try {
    await prisma.$connect();
    await prisma.$queryRawUnsafe("SELECT 1");
  } catch (e) {
    console.error("DB unreachable:", e instanceof Error ? e.message : e);
    process.exit(1);
  }

  try {
    const from = new Date();
    from.setDate(from.getDate() - LOOKBACK_DAYS);

    const exWhere = { createdAt: { gte: from } as const };

    const [trainingTotal, trainingLabeled, trainingUnlabeled, recPresent, recMissing] =
      await Promise.all([
        prisma.mlShadowTrainingExample.count({ where: exWhere }),
        prisma.mlShadowTrainingExample.count({
          where: { ...exWhere, labelGoodDecision12h: { not: null } },
        }),
        prisma.mlShadowTrainingExample.count({
          where: { ...exWhere, labelGoodDecision12h: null },
        }),
        prisma.mlShadowTrainingExample.count({
          where: {
            ...exWhere,
            AND: [{ recommendationId: { not: null } }, { NOT: { recommendationId: "" } }],
          },
        }),
        prisma.mlShadowTrainingExample.count({
          where: {
            ...exWhere,
            OR: [{ recommendationId: null }, { recommendationId: "" }],
          },
        }),
      ]);

    const distinctCombo =
      await prisma.$queryRaw<[{ c: bigint }]>`
      SELECT COUNT(*)::bigint AS c FROM (
        SELECT DISTINCT "recommendationId", "assetId", "side"
        FROM "MlShadowTrainingExample"
        WHERE "createdAt" >= ${from}
      ) t
    `;
    const distinctTripleCount = Number(distinctCombo[0]?.c ?? 0n);

    const missingRecSamples = await prisma.mlShadowTrainingExample.findMany({
      where: {
        ...exWhere,
        OR: [{ recommendationId: null }, { recommendationId: "" }],
      },
      select: {
        id: true,
        shadowCandidateId: true,
        assetId: true,
        side: true,
        createdAt: true,
        funderAddress: true,
      },
      take: MAX_SAMPLES_PER_CATEGORY,
      orderBy: { createdAt: "desc" },
    });

    const examplesForFeatures = (await prisma.mlShadowTrainingExample.findMany({
      where: exWhere,
      select: {
        id: true,
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
        recommendationId: true,
        assetId: true,
        labelGoodDecision12h: true,
        createdAt: true,
      },
    })) as ExampleSelect[];

    const dim = SHADOW_FEATURE_NAMES.length;
    const cols: number[][] = Array.from({ length: dim }, () => []);
    const missingPreCounts = Array(dim).fill(0);

    for (const ex of examplesForFeatures) {
      const vec = toShadowFeatureVector(exampleToInput(ex));
      for (let i = 0; i < dim; i++) {
        cols[i]!.push(vec[i] ?? 0);
        if (preCoercionMissing(ex, i)) missingPreCounts[i]!++;
      }
    }

    const nFeat = examplesForFeatures.length;
    const featureAudit = SHADOW_FEATURE_NAMES.map((name, i) => {
      const v = cols[i]!;
      const m = mean(v);
      const sd = stddevSample(v);
      const var_ = sd != null ? sd * sd : null;
      const zeros = v.filter((x) => x === 0).length;
      const pctZero = nFeat ? zeros / nFeat : null;
      const pctNullPre = nFeat ? missingPreCounts[i]! / nFeat : null;
      const degenerate =
        (sd != null && sd < 1e-12) || (pctZero != null && pctZero > 0.95);
      let rootCauseHint = "no strong flag";
      if (pctNullPre != null && pctNullPre > 0.75) {
        rootCauseHint = "mostly missing upstream (DB null/empty before parseNum → 0)";
      } else if (pctZero != null && pctZero > 0.9 && (pctNullPre ?? 0) < 0.3) {
        rootCauseHint = "mostly zero after coercion — may be policy/semantics (e.g. tradable only true→1) or true sparse signal";
      } else if (sd != null && sd < 1e-12) {
        rootCauseHint = "near-constant numeric column in window";
      }
      return {
        featureName: name,
        sourceFieldPath: FEATURE_SOURCE_PATHS[i],
        mean: m,
        variance: var_,
        stddev: sd,
        pctZero,
        pctNullOrMissingBeforeCoercion: pctNullPre,
        degenerate,
        rootCauseHint,
      };
    });

    const degenerateFeatureCount = featureAudit.filter((f) => f.degenerate).length;

    const paperRows = await prisma.paperTrade.findMany({
      where: { entryTime: { gte: from } },
      select: {
        id: true,
        score: true,
        metadataJson: true,
        assetId: true,
        side: true,
      },
    });

    let countRawMeta = 0;
    let countCalMeta = 0;
    let countAdmMeta = 0;
    let countScoreFallbackOnly = 0;
    const samplesRaw: string[] = [];
    const samplesCal: string[] = [];
    const samplesAdm: string[] = [];
    const samplesFallback: string[] = [];

    for (const t of paperRows) {
      const cal = parseCalibrationFromPaperMetadata(t.metadataJson);
      const hasAnyCal = cal.raw != null || cal.calibrated != null || cal.admission != null;
      if (cal.raw != null) {
        countRawMeta++;
        if (samplesRaw.length < MAX_SAMPLES_PER_CATEGORY) samplesRaw.push(t.id);
      }
      if (cal.calibrated != null) {
        countCalMeta++;
        if (samplesCal.length < MAX_SAMPLES_PER_CATEGORY) samplesCal.push(t.id);
      }
      if (cal.admission != null) {
        countAdmMeta++;
        if (samplesAdm.length < MAX_SAMPLES_PER_CATEGORY) samplesAdm.push(t.id);
      }
      if (!hasAnyCal && Number.isFinite(t.score)) {
        countScoreFallbackOnly++;
        if (samplesFallback.length < MAX_SAMPLES_PER_CATEGORY) samplesFallback.push(t.id);
      }
    }

    const scoreLineage = {
      documentation: {
        paperTradeScoreColumn:
          "PaperTrade.score is set to raw logistic proba (ShadowScoreResult.shadowMlScore) at open; see lib/paper-trading/engine.ts prisma.paperTrade.create and lib/ml/shadow-score/types.ts.",
        shadowMlScoreRaw:
          "openAttribution.paperShadowScoreCalibration.shadowMlScoreRaw (same raw proba, stored in metadataJson).",
        shadowMlScoreCalibrated:
          "Temperature-scaled proba from applyPaperShadowLogitTemperature in score path; stored in paperShadowScoreCalibration.shadowMlScoreCalibrated.",
        admissionScore:
          "Gates admission vs min score; stored as paperShadowScoreCalibration.admissionScore (may equal raw or calibrated per paperShadowUseCalibratedScoreForPaper).",
        metadataLayout:
          "Calibration lives under JSON root openAttribution (mergeOpenAttributionIntoMetadata), not always at metadata root.",
      },
      paperTradesInWindow: paperRows.length,
      countWithRawInMetadata: countRawMeta,
      countWithCalibratedInMetadata: countCalMeta,
      countWithAdmissionInMetadata: countAdmMeta,
      countRelyingOnPaperTradeScoreOnlyNoCalibrationBlock: countScoreFallbackOnly,
      sampleTradeIds: {
        withRawInMetadata: samplesRaw,
        withCalibratedInMetadata: samplesCal,
        withAdmissionInMetadata: samplesAdm,
        fallbackScoreOnlyNoCalibrationBlock: samplesFallback,
      },
    };

    const tradeRecIds = new Set<string>();
    for (const t of paperRows) {
      const r = parseRecommendationId(t.metadataJson);
      if (r) tradeRecIds.add(r);
    }

    const relevantExamples =
      tradeRecIds.size > 0
        ? await prisma.mlShadowTrainingExample.findMany({
            where: { recommendationId: { in: Array.from(tradeRecIds) } },
            select: {
              recommendationId: true,
              assetId: true,
              side: true,
              labelGoodDecision12h: true,
              id: true,
            },
          })
        : [];

    let paperMetaRecPresent = 0;
    let paperMetaRecMissing = 0;
    let paperAssetBlank = 0;
    let paperSideBlank = 0;
    for (const t of paperRows) {
      const rec = parseRecommendationId(t.metadataJson);
      if (rec) paperMetaRecPresent++;
      else paperMetaRecMissing++;
      const assetOk = t.assetId != null && String(t.assetId).trim() !== "";
      const sideOk = t.side != null && String(t.side).trim() !== "";
      if (!assetOk) paperAssetBlank++;
      if (!sideOk) paperSideBlank++;
    }

    let matchRecOnly = 0;
    let matchRecAsset = 0;
    let matchFullKey = 0;
    let joinedLabel = 0;
    const failureSamples = new Map<string, string[]>();

    for (const t of paperRows) {
      const rec = parseRecommendationId(t.metadataJson);
      if (!rec) {
        pushSample(failureSamples, "missing_recommendation_id_on_trade", t.id);
        continue;
      }
      const rows = relevantExamples.filter((e) => e.recommendationId === rec);
      if (rows.length === 0) {
        pushSample(failureSamples, "recommendation_id_exists_but_no_example_row", t.id);
        continue;
      }
      matchRecOnly++;
      const ra = rows.filter((e) => e.assetId === t.assetId);
      if (ra.length === 0) {
        pushSample(failureSamples, "example_rows_for_rec_but_asset_mismatch", t.id);
        continue;
      }
      matchRecAsset++;
      const full = ra.filter((e) => e.side === t.side);
      if (full.length === 0) {
        pushSample(failureSamples, "rec_and_asset_match_but_side_mismatch", t.id);
        continue;
      }
      matchFullKey++;
      if (full.some((e) => e.labelGoodDecision12h !== null)) {
        joinedLabel++;
      } else {
        pushSample(failureSamples, "full_key_match_but_label_null_on_all_rows", t.id);
      }
    }

    const labelJoinRate = paperRows.length ? joinedLabel / paperRows.length : 0;

    const rawScores: number[] = [];
    for (const t of paperRows) {
      const cal = parseCalibrationFromPaperMetadata(t.metadataJson);
      const r = cal.raw ?? (Number.isFinite(t.score) ? t.score : null);
      if (r != null) rawScores.push(r);
    }
    const hist = { "<0.5": 0, "0.5-0.7": 0, "0.7-0.9": 0, "0.9-0.99": 0, "0.99-0.999": 0, "0.999+": 0 };
    for (const x of rawScores) {
      if (x < 0.5) hist["<0.5"]++;
      else if (x < 0.7) hist["0.5-0.7"]++;
      else if (x < 0.9) hist["0.7-0.9"]++;
      else if (x < 0.99) hist["0.9-0.99"]++;
      else if (x < 0.999) hist["0.99-0.999"]++;
      else hist["0.999+"]++;
    }
    const satShare = rawScores.length ? hist["0.999+"] / rawScores.length : 0;

    const saturationBlock = {
      rawLogisticHistogramOnPaperTrades: hist,
      shareAtLeast0_999: satShare,
    };

    const labelJoinFailureAudit = {
      paperTradesInWindow: paperRows.length,
      metadataRecommendationIdPresent: paperMetaRecPresent,
      metadataRecommendationIdMissing: paperMetaRecMissing,
      paperAssetIdBlank: paperAssetBlank,
      paperSideBlank: paperSideBlank,
      note: "Join key in reports: recommendationId|assetId|side (lib/paper-trading/paper-score-alignment-report.ts). Examples loaded: MlShadowTrainingExample where recommendationId IN (distinct rec ids from paper trades in window).",
      matchCounts: {
        tradesWithRecInMetadata: paperMetaRecPresent,
        withAtLeastOneExampleMatchingRecommendationIdOnly: matchRecOnly,
        withAtLeastOneExampleMatchingRecommendationIdAndAssetId: matchRecAsset,
        withAtLeastOneExampleMatchingFullTriple: matchFullKey,
        tradesWithNonNullLabelOnJoinKey: joinedLabel,
      },
      sampleTradeIdsByFailureCategory: Object.fromEntries(failureSamples),
    };

    const trainingExampleAudit = {
      windowDays: LOOKBACK_DAYS,
      totalRowCount: trainingTotal,
      labelGoodDecision12h: {
        nonNull: trainingLabeled,
        null: trainingUnlabeled,
      },
      keyIdentity: {
        recommendationIdPresent: recPresent,
        recommendationIdMissingOrEmpty: recMissing,
        assetIdPresentAllRowsExpected: trainingTotal,
        sidePresentAllRowsExpected: trainingTotal,
        note: "assetId and side are required fields on MlShadowTrainingExample (prisma schema); expect counts = totalRowCount.",
      },
      distinctRecommendationAssetSideCombos: distinctTripleCount,
      sampleRowsMissingRecommendationId: missingRecSamples,
    };

    const degenerateRatio = dim ? degenerateFeatureCount / dim : 0;
    const rootCausesRanked: string[] = [];
    if (labelJoinRate < 0.25) {
      rootCausesRanked.push(
        `Low label join (${(labelJoinRate * 100).toFixed(1)}%): missing recommendationId on paper metadata and/or no MlShadowTrainingExample row for triple.`
      );
    }
    if (satShare > 0.15) {
      rootCausesRanked.push(
        `Raw score saturation (${(satShare * 100).toFixed(1)}% in ≥0.999 bucket): large logits / weak feature separation before or at sigmoid.`
      );
    }
    if (degenerateRatio > 0.35) {
      rootCausesRanked.push(
        `Degenerate features (${degenerateFeatureCount}/${dim}): many near-constant or zero-heavy inputs shrink effective model capacity.`
      );
    }
    if (trainingUnlabeled > trainingLabeled) {
      rootCausesRanked.push(
        "Training window has more unlabeled than labeled shadow examples — weak supervision for labelGoodDecision12h."
      );
    }
    if (countScoreFallbackOnly > 0 && countRawMeta < paperRows.length * 0.5) {
      rootCausesRanked.push(
        "Many paper trades lack paperShadowScoreCalibration block in metadata — harder to audit raw vs calibrated lineage."
      );
    }
    if (rootCausesRanked.length === 0) {
      rootCausesRanked.push("No extreme flags in heuristics; inspect JSON for details.");
    }

    const primarySaturation =
      satShare > 0.15
        ? degenerateRatio > 0.35
          ? "mixed: raw-model-side (logit/sigmoid) compounded by feature-side degeneracy"
          : "primarily raw-model-side (logit scale / weights / separation)"
        : degenerateRatio > 0.35
          ? "primarily feature-side (inputs collapse)"
          : labelJoinRate < 0.2
            ? "primarily label-side (join/coverage)"
            : "unclear from coarse metrics — see histograms";

    const interpretation = {
      saturationPrimaryBucket: primarySaturation,
      calibrationSideNote:
        "Calibration (temperature) rescales logits; if raw already saturated, calibration may not fix separation — see ml-score-diagnostics.",
      rankedLikelyCauses: rootCausesRanked.slice(0, 5),
      concreteFindings: [
        `${trainingTotal} training examples in ${LOOKBACK_DAYS}d; ${trainingLabeled} with labelGoodDecision12h set.`,
        `${paperRows.length} paper trades; ${joinedLabel} join to a row with non-null label on full triple.`,
        `${degenerateFeatureCount} / ${dim} features flagged degenerate (near-constant or >95% zero).`,
        `${(satShare * 100).toFixed(2)}% of paper-trade raw scores in [0.999,1] bucket.`,
        `Metadata: ${countRawMeta} with raw in calibration block, ${countScoreFallbackOnly} trades with score only and no calibration block.`,
      ],
    };

    const nextFixRecommendations = [
      {
        rank: 1,
        title: "Fix or verify label join for paper trades",
        expectedImpact: "Restores supervised metrics (label positive rate, calibration checks) tied to paper outcomes.",
        risk: "Low if join key is wrong only in analytics; verify production paths before changing writes.",
        beforeThresholdTuning:
          "Without labels, you cannot tell if threshold moves help; tuning blind on PnL-only is noisy.",
      },
      {
        rank: 2,
        title: "Remove, impute, or replace degenerate / always-zero shadow features",
        expectedImpact: "Reduces logit saturation from redundant weights and improves gradient signal.",
        risk: "Medium — requires training pipeline agreement and possible retrain.",
        beforeThresholdTuning:
          "If inputs are flat, threshold changes only trim volume, not model quality.",
      },
      {
        rank: 3,
        title: "Inspect raw logits, regularization, and target construction (shadow train)",
        expectedImpact: "Addresses root logistic separation and class balance effects on proba scale.",
        risk: "Higher — model governance and validation cycle.",
        beforeThresholdTuning:
          "If probabilities are miscalibrated structurally, operational thresholds chase symptoms.",
      },
      {
        rank: 4,
        title: "Ensure paperShadowScoreCalibration always persisted on new opens",
        expectedImpact: "Auditable lineage from raw → calibrated → admissionScore without guessing from PaperTrade.score alone.",
        risk: "Low; metadata size growth negligible.",
        beforeThresholdTuning: "Needed for fair before/after comparisons when tuning gates.",
      },
    ];

    const report = {
      generatedAt: new Date().toISOString(),
      lookbackDays: LOOKBACK_DAYS,
      pipelineStagesAudited: [
        "MlShadowTrainingExample population (90d)",
        "Feature vectorization path lib/ml/shadow-train/features.ts",
        "PaperTrade score + metadata calibration block",
        "Label join key recommendationId|assetId|side",
      ],
      A_trainingExamplePopulation: trainingExampleAudit,
      B_featurePopulation: {
        vectorizationPath: "toShadowFeatureVector (same as training/scoring)",
        rowCount: nFeat,
        features: featureAudit,
        degenerateFeatureCount,
      },
      C_modelScoreLineage: scoreLineage,
      D_labelJoinFailure: labelJoinFailureAudit,
      E_saturationRootCause: { ...interpretation, saturationHistogram: saturationBlock },
      F_nextFixRecommendationsReadOnly: nextFixRecommendations,
    };

    await fs.writeFile(OUT_JSON, JSON.stringify(report, null, 2), "utf8");

    const md: string[] = [];
    md.push("# Shadow ML data lineage audit (read-only)");
    md.push("");
    md.push(`**Generated:** ${report.generatedAt}`);
    md.push("");
    md.push("## A. Training examples (90d)");
    md.push(`- Total: ${trainingTotal}`);
    md.push(`- labelGoodDecision12h non-null: ${trainingLabeled}, null: ${trainingUnlabeled}`);
    md.push(`- recommendationId present: ${recPresent}, missing/empty: ${recMissing}`);
    md.push(`- Distinct (recommendationId, assetId, side): ${distinctTripleCount}`);
    md.push("");
    md.push("## D. Label join (paper trades 90d)");
    md.push(`- Join success (non-null label on full triple): ${joinedLabel} / ${paperRows.length} (${(labelJoinRate * 100).toFixed(1)}%)`);
    md.push(`- recId in metadata: ${paperMetaRecPresent}, missing: ${paperMetaRecMissing}`);
    md.push("");
    md.push("## E. Saturation / interpretation");
    md.push(`- **Primary bucket:** ${primarySaturation}`);
    for (const c of rootCausesRanked.slice(0, 5)) {
      md.push(`- ${c}`);
    }
    md.push("");
    md.push("## F. Next fixes (read-only list)");
    for (const f of nextFixRecommendations) {
      md.push(`### ${f.rank}. ${f.title}`);
      md.push(`- Impact: ${f.expectedImpact}`);
      md.push(`- Risk: ${f.risk}`);
      md.push(`- Before threshold tuning: ${f.beforeThresholdTuning}`);
    }
    md.push("");
    md.push(`Full JSON: \`${OUT_JSON}\``);
    await fs.writeFile(OUT_MD, md.join("\n"), "utf8");

    const chat: string[] = [];
    chat.push("# Shadow ML lineage — chat summary");
    chat.push("");
    chat.push("## Score distribution (raw on paper trades)");
    chat.push(JSON.stringify(hist));
    chat.push("");
    chat.push("## Saturation");
    chat.push(primarySaturation);
    chat.push(`Share ≥0.999: ${(satShare * 100).toFixed(1)}%`);
    chat.push("");
    chat.push("## Calibration / metadata");
    chat.push(
      `Trades with calibration raw in metadata: ${countRawMeta}/${paperRows.length}; score-only fallback (no block): ${countScoreFallbackOnly}`
    );
    chat.push("");
    chat.push("## Features");
    chat.push(`Degenerate features: ${degenerateFeatureCount}/${dim}`);
    chat.push("");
    chat.push("## Label coverage (join)");
    chat.push(`${joinedLabel}/${paperRows.length} (${(labelJoinRate * 100).toFixed(1)}%)`);
    chat.push("");
    chat.push("## Top causes");
    for (const c of rootCausesRanked.slice(0, 3)) chat.push(`- ${c}`);
    chat.push("");
    chat.push("## Key conclusion");
    chat.push(
      labelJoinRate < 0.25
        ? "Prioritize join key + recommendationId on paper metadata before threshold work."
        : satShare > 0.15
          ? "Prioritize feature health and logit/regularization review; saturation is structural."
          : "Review JSON for per-feature and per-failure-category samples."
    );
    await fs.writeFile(OUT_CHAT, chat.join("\n"), "utf8");

    console.log("--- Shadow ML data lineage audit ---");
    console.log(`Training examples (90d): ${trainingTotal}`);
    console.log(`Paper trades (90d): ${paperRows.length}`);
    console.log(`Degenerate features: ${degenerateFeatureCount} / ${dim}`);
    console.log(`Label join success rate: ${(labelJoinRate * 100).toFixed(1)}% (${joinedLabel}/${paperRows.length})`);
    console.log("Top 3 likely root causes:");
    for (const c of rootCausesRanked.slice(0, 3)) console.log(`  - ${c}`);
    console.log("Outputs:");
    console.log(`  ${OUT_JSON}`);
    console.log(`  ${OUT_MD}`);
    console.log(`  ${OUT_CHAT}`);
    console.log("");
    console.log("IMPLEMENTATION SUMMARY:");
    console.log("- files created: tools/create-shadow-ml-data-lineage-audit.ts");
    console.log("- files modified: package.json (if dump: script added)");
    console.log(
      "- pipeline stages: MlShadowTrainingExample keys/labels, toShadowFeatureVector features, PaperTrade metadata scores, label join triple"
    );
    for (let i = 0; i < Math.min(3, rootCausesRanked.length); i++) {
      console.log(`- root cause ${i + 1}: ${rootCausesRanked[i]}`);
    }
    console.log(
      `- most important next fix (read-only): ${labelJoinRate < 0.3 ? "verify paper metadata recommendationId + example rows for join key" : "address feature degeneracy and logit saturation drivers"}`
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
