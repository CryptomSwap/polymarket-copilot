/**
 * Audit path/regime shadow_v1 slots, document sources, optional in-memory "after backfill" A/B on labelGoodDecision12h.
 * Writes dump/bootstrap-path-feature-backfill-report.{md,json}. Does not change labels or trading.
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import { toShadowFeatureVector, SHADOW_FEATURE_NAMES } from "../lib/ml/shadow-train/features";
import { trainLogisticRegression, predictBatchLogistic } from "../lib/ml/baseline";
import { computeMetrics } from "../lib/ml/evaluate";
import { computeActiveFeatureIndices, balancedClassWeights } from "../lib/ml/shadow-train/train";
import {
  PATH_FEATURE_LOOKBACK_MS,
  computePathRegimeFeaturesFromPreDecisionPoints,
  filterPreDecisionPoints,
  resolveSnapshotMarketIdAliases,
  snapshotsToPoints,
  type PathRegimeFeatures,
  type SnapshotPoint,
} from "../lib/ml/shadow-dataset/path-features-from-snapshots";

const DUMP_DIR = path.join(process.cwd(), "dump");
const JSON_PATH = path.join(DUMP_DIR, "bootstrap-path-feature-backfill-report.json");
const MD_PATH = path.join(DUMP_DIR, "bootstrap-path-feature-backfill-report.md");

const HORIZON_12H_MS = 12 * 60 * 60 * 1000;

const PATH_SLOT_DB_FIELDS = [
  "momentum1hBps",
  "momentum6hBps",
  "volatility1hBps",
  "volatility6hBps",
  "distanceFromMid",
  "timeToCloseHours",
  "liquidityTrend",
] as const;

/** Indices in SHADOW_FEATURE_NAMES for path/regime slots */
const PATH_FEATURE_INDICES = PATH_SLOT_DB_FIELDS.map((name) => SHADOW_FEATURE_NAMES.indexOf(name));

function parseNum(s: string | null | undefined): number | null {
  if (s == null || s === "") return null;
  const n = parseFloat(String(s).trim());
  return Number.isFinite(n) ? n : null;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/** Pearson correlation (same as point-biserial for binary y). */
function pearsonCorr(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 3) return 0;
  const mx = mean(x);
  const my = mean(y);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const vx = x[i] - mx;
    const vy = y[i] - my;
    num += vx * vy;
    dx += vx * vx;
    dy += vy * vy;
  }
  const den = Math.sqrt(dx * dy);
  return den > 1e-14 ? num / den : 0;
}

function runModelCompare(
  XTrain: number[][],
  XVal: number[][],
  yTrain: number[],
  yVal: number[],
  featureDim: number
): {
  validationRocAuc: number;
  f1At05: number;
  activeFeatureCount: number;
  constantFeatureCount: number;
} {
  const activeIdx =
    XTrain.length > 0 && XTrain[0].length === featureDim
      ? computeActiveFeatureIndices(XTrain, 1e-8)
      : [];
  const idx =
    activeIdx.length > 0 ? activeIdx : Array.from({ length: featureDim }, (_, i) => i);
  const model = trainLogisticRegression(XTrain, yTrain, {
    learningRate: 0.1,
    maxIter: 500,
    l2Lambda: 0.01,
    featureIndices: idx,
    sampleWeights: balancedClassWeights(yTrain),
  });
  const scores = predictBatchLogistic(model, XVal);
  const m = computeMetrics(scores, yVal, 0.5);
  return {
    validationRocAuc: m.rocAuc,
    f1At05: m.f1,
    activeFeatureCount: idx.length,
    constantFeatureCount: featureDim - idx.length,
  };
}

function toV1Input(r: Record<string, unknown>) {
  return {
    policyState: r.policyState as string | null,
    sizeMultiplier: r.sizeMultiplier as string | null,
    finalSuggestedSize: r.finalSuggestedSize as string | null,
    eligibilityBlockersCount: r.eligibilityBlockersCount as number,
    reducedSizeIndicator: r.reducedSizeIndicator as boolean,
    blockedIndicator: r.blockedIndicator as boolean,
    executionAllow: r.executionAllow as boolean | null,
    executionWarningCount: r.executionWarningCount as number,
    qualityState: r.qualityState as string | null,
    spreadBps: r.spreadBps as string | null,
    estimatedSlippage: r.estimatedSlippage as string | null,
    tradable: r.tradable as boolean | null,
    grossExposure: r.grossExposure as string | null,
    totalOpenExposure: r.totalOpenExposure as string | null,
    maxSingleMarketConcentrationPct: r.maxSingleMarketConcentrationPct as string | null,
    maxSingleThemeConcentrationPct: r.maxSingleThemeConcentrationPct as string | null,
    portfolioRiskFlagsCount: r.portfolioRiskFlagsCount as number,
    runtimeWarningCount: r.runtimeWarningCount as number,
    runtimeBlockingCount: r.runtimeBlockingCount as number,
    intendedPrice: r.intendedPrice as string | null,
    intendedSize: r.intendedSize as string | null,
    recommendationPresent: r.recommendationPresent as boolean,
    side: r.side as string | null,
    outcomeBlockedVsAllowedVsSubmitted: r.outcomeBlockedVsAllowedVsSubmitted as
      | "blocked"
      | "allowed"
      | "submitted"
      | null,
    momentum1hBps: r.momentum1hBps as string | null,
    momentum6hBps: r.momentum6hBps as string | null,
    volatility1hBps: r.volatility1hBps as string | null,
    volatility6hBps: r.volatility6hBps as string | null,
    distanceFromMid: r.distanceFromMid as string | null,
    timeToCloseHours: r.timeToCloseHours as string | null,
    liquidityTrend: r.liquidityTrend as string | null,
  };
}

function rowHasPathSignalInDb(r: Record<string, unknown>): boolean {
  for (const f of PATH_SLOT_DB_FIELDS) {
    const n = parseNum(r[f] as string | null);
    if (n != null && n !== 0) return true;
  }
  return false;
}

function rowHasPathSignalComputed(p: PathRegimeFeatures): boolean {
  for (const f of PATH_SLOT_DB_FIELDS) {
    const n = parseNum(p[f]);
    if (n != null && n !== 0) return true;
  }
  return false;
}

function topCorrelations(
  X: number[][],
  y: number[],
  names: string[],
  topN: number
): { name: string; correlation: number; absCorrelation: number }[] {
  const out: { name: string; correlation: number; absCorrelation: number }[] = [];
  const d = names.length;
  for (let j = 0; j < d; j++) {
    const col = X.map((row) => row[j] ?? 0);
    const c = pearsonCorr(col, y);
    out.push({ name: names[j], correlation: c, absCorrelation: Math.abs(c) });
  }
  out.sort((a, b) => b.absCorrelation - a.absCorrelation);
  return out.slice(0, topN);
}

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });
  const generatedAt = new Date().toISOString();
  const limit = Math.min(
    50_000,
    Math.max(200, parseInt(process.env.PATH_BACKFILL_REPORT_LIMIT ?? "9500", 10) || 9500)
  );
  const trainRatio = 0.8;
  const topNCorr = Math.min(25, Math.max(5, parseInt(process.env.PATH_BACKFILL_TOP_CORR ?? "15", 10) || 15));

  const audit = {
    whyPathSlotsWereZeroFilled: [
      "Live/paper MlShadowTrainingExample rows are built in lib/ml/shadow-dataset/build.ts via persistShadowTrainingExamples.",
      "Historically, path/regime columns were not written on create/update — only offline_historical (lib/ml/shadow-dataset/offline-historical.ts) populated them from MarketPriceSnapshot.",
      "ShadowCandidate / decision snapshots do not currently carry momentum/volatility/distance/time-to-close/liquidity trend as persisted ML columns; intended source is pre-decision MarketPriceSnapshot series + SyncedMarket.endDate.",
    ],
    sourcesPerField: {
      momentum1hBps:
        "Price at decision (or intendedPrice fallback) vs last snapshot price at or before decision−1h; bps = (p0−p1)/p1×10000. Snapshots only with capturedAt ≤ decisionAt.",
      momentum6hBps: "Same with 6h lookback (pre-decision only).",
      volatility1hBps:
        "(max−min)/mid×10000 over snapshots in [decision−1h, decision] (offline-historical aligned range).",
      volatility6hBps: "Same with 6h window ending at decision.",
      distanceFromMid: "|midPrice − 0.5| at decision; mid from snapshot at/before decision, else intendedPrice if valid.",
      timeToCloseHours: "(SyncedMarket.endDate − decisionAt) / 1h when endDate exists and is after decision.",
      liquidityTrend:
        "(liquidityAtDecision − liquidityAtDecision−6h) / liquidityAtDecision−6h when denominator > 0; liquidity from snapshot series, pre-decision only.",
    },
    noForwardLeakage:
      "Path/regime features use filterPreDecisionPoints(..., decisionAt) so no snapshot with capturedAt > decisionAt contributes. Separate forward window [decision, decision+12h] is only used elsewhere for markout12h labeling, not merged into path feature points.",
    implementation: {
      coreModule: "lib/ml/shadow-dataset/path-features-from-snapshots.ts",
      persistHook: "lib/ml/shadow-dataset/build.ts persistShadowTrainingExamples",
      batchBackfill: "lib/ml/shadow-dataset/backfill-path-regime-features.ts",
    },
  };

  try {
    const raw = await prisma.mlShadowTrainingExample.findMany({
      where: { labelGoodDecision12h: { not: null } },
      orderBy: { createdAt: "asc" },
      take: limit,
      select: {
        id: true,
        createdAt: true,
        labelGoodDecision12h: true,
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
        marketId: true,
        assetId: true,
      },
    });

    const valid = raw.filter((r) => r.labelGoodDecision12h === true || r.labelGoodDecision12h === false);

    const uniqueMarketKeys = [...new Set(valid.map((r) => r.marketId).filter(Boolean) as string[])];
    const syncedMarkets =
      uniqueMarketKeys.length > 0
        ? await prisma.syncedMarket.findMany({
            where: {
              OR: [{ id: { in: uniqueMarketKeys } }, { conditionId: { in: uniqueMarketKeys } }],
            },
            select: { id: true, conditionId: true, endDate: true },
          })
        : [];
    const endDateByKey = new Map<string, Date>();
    for (const m of syncedMarkets) {
      if (m.endDate) {
        const d = m.endDate instanceof Date ? m.endDate : new Date(m.endDate);
        if (m.id) endDateByKey.set(m.id, d);
        if (m.conditionId) endDateByKey.set(m.conditionId, d);
      }
    }
    function marketEndFor(marketId: string | null): Date | null {
      if (!marketId) return null;
      return endDateByKey.get(marketId) ?? null;
    }

    const groups = new Map<string, (typeof valid)[number][]>();
    for (const r of valid) {
      if (!r.marketId || !r.assetId) continue;
      const k = `${r.marketId}\t${r.assetId}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(r);
    }

    const snapshotMarketIdCache = new Map<string, string[]>();
    const computedByRowId = new Map<string, PathRegimeFeatures>();

    for (const [, groupRows] of groups) {
      const times = groupRows.map((r) => r.createdAt.getTime());
      const minD = Math.min(...times);
      const maxD = Math.max(...times);
      const globalFrom = new Date(minD - PATH_FEATURE_LOOKBACK_MS);
      const globalTo = new Date(maxD + HORIZON_12H_MS);
      const marketId = groupRows[0]!.marketId!;
      const assetId = groupRows[0]!.assetId!;
      const resolved = await resolveSnapshotMarketIdAliases(prisma, marketId, snapshotMarketIdCache);
      if (resolved.length === 0) continue;

      const snapshots = await prisma.marketPriceSnapshot.findMany({
        where: {
          marketId: { in: resolved },
          assetId,
          capturedAt: { gte: globalFrom, lte: globalTo },
        },
        orderBy: { capturedAt: "asc" },
        select: { capturedAt: true, price: true, liquidity: true, volume: true },
      });
      const fullRangePoints = snapshotsToPoints(snapshots);

      for (const r of groupRows) {
        const d = r.createdAt.getTime();
        const at12h = d + HORIZON_12H_MS;
        const slice: SnapshotPoint[] = [];
        for (const p of fullRangePoints) {
          const t = p.capturedAt.getTime();
          if (t >= d - PATH_FEATURE_LOOKBACK_MS && t <= at12h) slice.push(p);
        }
        if (slice.length === 0) continue;

        const decisionAt = r.createdAt;
        const pre = filterPreDecisionPoints(slice, decisionAt);
        const pf = computePathRegimeFeaturesFromPreDecisionPoints(pre, decisionAt, {
          marketEndDate: marketEndFor(r.marketId),
          intendedPriceFallback: parseNum(r.intendedPrice),
        });
        computedByRowId.set(r.id, pf);
      }
    }

    let dbPathSignal = 0;
    let simPathSignal = 0;
    let simAnyNonNull = 0;
    const rowsAsRecord = valid.map((r) => {
      const rec = { ...r } as Record<string, unknown>;
      if (rowHasPathSignalInDb(rec)) dbPathSignal++;
      const pf = computedByRowId.get(r.id);
      if (pf) {
        if (rowHasPathSignalComputed(pf)) simPathSignal++;
        const hasAny = PATH_SLOT_DB_FIELDS.some((f) => pf[f] != null);
        if (hasAny) simAnyNonNull++;
        const merged = { ...rec };
        for (const f of PATH_SLOT_DB_FIELDS) {
          if (pf[f] != null) merged[f] = pf[f];
        }
        return { baseline: rec, after: merged, computed: pf };
      }
      return { baseline: rec, after: rec, computed: null as PathRegimeFeatures | null };
    });

    const splitIdx = Math.max(1, Math.floor(valid.length * trainRatio));
    const trainPart = rowsAsRecord.slice(0, splitIdx);
    const valPart = rowsAsRecord.slice(splitIdx);
    const yTrain = trainPart.map((x) => ((x.baseline.labelGoodDecision12h as boolean) ? 1 : 0));
    const yVal = valPart.map((x) => ((x.baseline.labelGoodDecision12h as boolean) ? 1 : 0));

    const XBaseTrain = trainPart.map((x) => toShadowFeatureVector(toV1Input(x.baseline)));
    const XBaseVal = valPart.map((x) => toShadowFeatureVector(toV1Input(x.baseline)));
    const XAfterTrain = trainPart.map((x) => toShadowFeatureVector(toV1Input(x.after)));
    const XAfterVal = valPart.map((x) => toShadowFeatureVector(toV1Input(x.after)));

    const dim = SHADOW_FEATURE_NAMES.length;
    const baselineMetrics = runModelCompare(XBaseTrain, XBaseVal, yTrain, yVal, dim);
    const afterMetrics = runModelCompare(XAfterTrain, XAfterVal, yTrain, yVal, dim);

    const aucDelta = afterMetrics.validationRocAuc - baselineMetrics.validationRocAuc;
    const materialGain = aucDelta >= 0.03 && afterMetrics.validationRocAuc >= 0.54;

    const corrBaselineVal = topCorrelations(XBaseVal, yVal, SHADOW_FEATURE_NAMES, topNCorr);
    const corrAfterVal = topCorrelations(XAfterVal, yVal, SHADOW_FEATURE_NAMES, topNCorr);

    const pathVarianceBefore = PATH_FEATURE_INDICES.map((j) => {
      const name = SHADOW_FEATURE_NAMES[j]!;
      const col = XBaseVal.map((row) => row[j] ?? 0);
      const m = mean(col);
      const v = col.length > 1 ? col.reduce((s, x) => s + (x - m) * (x - m), 0) / (col.length - 1) : 0;
      return { name, variance: v, mean: m };
    });
    const pathVarianceAfter = PATH_FEATURE_INDICES.map((j) => {
      const name = SHADOW_FEATURE_NAMES[j]!;
      const col = XAfterVal.map((row) => row[j] ?? 0);
      const m = mean(col);
      const v = col.length > 1 ? col.reduce((s, x) => s + (x - m) * (x - m), 0) / (col.length - 1) : 0;
      return { name, variance: v, mean: m };
    });

    const enoughRowsPopulated = simAnyNonNull >= Math.max(500, valid.length * 0.05);

    const report = {
      generatedAt,
      constraints: {
        noLiveTradingOrThresholdOrLabelSemanticsChanges: true,
      },
      audit,
      pool: {
        labelGoodDecision12hMixed: true,
        rowCount: valid.length,
        limit,
        trainRatio,
        rowsWithMarketAndAsset: valid.filter((r) => r.marketId && r.assetId).length,
      },
      population: {
        rowsWithDbPathSignalNonZero: dbPathSignal,
        rowsWithSimulatedPathSignalNonZero: simPathSignal,
        rowsWithAnySimulatedPathFieldNonNull: simAnyNonNull,
        enoughRowsPopulatedForExperiment: enoughRowsPopulated,
      },
      pathSlotVarianceOnValidation: {
        before: pathVarianceBefore,
        after: pathVarianceAfter,
      },
      abCompareMixedLabel12h: {
        target: "labelGoodDecision12h (unchanged semantics)",
        shadow_v1_dbPathSlots: baselineMetrics,
        shadow_v1_simulatedPathBackfill: afterMetrics,
        aucDelta,
        f1At05Delta: afterMetrics.f1At05 - baselineMetrics.f1At05,
        materialGainThreshold: { deltaAucMin: 0.03, afterAucMin: 0.54 },
        materialGain,
      },
      topUnivariateCorrelationsValidation: {
        baseline: corrBaselineVal,
        afterPathBackfill: corrAfterVal,
      },
      conclusion: {
        improvesLearnabilityMaterially: materialGain,
        enoughForAnotherBootstrapAttempt:
          materialGain && enoughRowsPopulated
            ? "Yes — path slots show material validation lift and sufficient populated rows; safe to try a paper/bootstrap retrain with backfill applied (still advisory)."
            : materialGain && !enoughRowsPopulated
              ? "Partially — AUC lift on this slice but too few rows get path signal; collect more snapshot history before relying on it."
              : !materialGain && enoughRowsPopulated
                ? "No material AUC gain despite populating many rows — mixed 12h target noise or policy dominance still limits learnability."
                : "No — sparse path population and no material lift; extend snapshot coverage and revisit labels/target before a serious bootstrap run.",
      },
    };

    await fs.writeFile(JSON_PATH, JSON.stringify(report, null, 2), "utf8");

    const md = `# Bootstrap path feature backfill report

Generated: ${generatedAt}

## Why path slots were empty

${audit.whyPathSlotsWereZeroFilled.map((x) => `- ${x}`).join("\n")}

## Per-field sources (truthful, pre-decision)

${Object.entries(audit.sourcesPerField)
  .map(([k, v]) => `- **${k}:** ${v}`)
  .join("\n")}

## Pool

- Rows (mixed \`labelGoodDecision12h\`): **${valid.length}** (limit=${limit})
- Rows with marketId+assetId: **${report.pool.rowsWithMarketAndAsset}**

## Population

| Metric | Count |
|--------|------:|
| DB path signal (any slot non-zero) | ${dbPathSignal} |
| Simulated path signal (non-zero after recompute) | ${simPathSignal} |
| Any simulated path field non-null | ${simAnyNonNull} |

## A/B (same time split, balanced LR, constant-feature drop)

| Variant | val ROC-AUC | F1@0.5 | active features |
|---------|------------|--------|-----------------|
| shadow_v1 (DB columns as stored) | ${baselineMetrics.validationRocAuc.toFixed(4)} | ${baselineMetrics.f1At05.toFixed(4)} | ${baselineMetrics.activeFeatureCount} |
| shadow_v1 (simulated path backfill) | ${afterMetrics.validationRocAuc.toFixed(4)} | ${afterMetrics.f1At05.toFixed(4)} | ${afterMetrics.activeFeatureCount} |

- ΔAUC = **${aucDelta.toFixed(4)}**
- Material gain (ΔAUC≥0.03 and after AUC≥0.54): **${materialGain}**

## Path-slot variance on validation (before → after)

${pathVarianceBefore
  .map(
    (b, i) =>
      `- **${b.name}:** var ${b.variance.toExponential(2)} → ${pathVarianceAfter[i]!.variance.toExponential(2)}`
  )
  .join("\n")}

## Top univariate correlations (validation, vs label)

### Baseline (DB)

${corrBaselineVal.map((c) => `- ${c.name}: ${c.correlation.toFixed(4)}`).join("\n")}

### After simulated path backfill

${corrAfterVal.map((c) => `- ${c.name}: ${c.correlation.toFixed(4)}`).join("\n")}

## Conclusion

- **Material learnability improvement:** ${materialGain ? "yes" : "no"}
- **Enough for another real bootstrap attempt:** ${report.conclusion.enoughForAnotherBootstrapAttempt}

Persist path features: run dataset persist (new rows) or \`npm run ml:backfill-path-regime-features\` (existing rows).
`;

    await fs.writeFile(MD_PATH, md, "utf8");
    console.log(`Wrote ${JSON_PATH}`);
    console.log(`Wrote ${MD_PATH}`);
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    const fallback = { generatedAt, audit, error: err };
    await fs.writeFile(JSON_PATH, JSON.stringify(fallback, null, 2), "utf8");
    await fs.writeFile(MD_PATH, `# Bootstrap path feature backfill report\n\nError: ${err}\n`, "utf8");
    throw e;
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
