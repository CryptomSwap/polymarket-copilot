/**
 * Audit shadow_v1 feature signal on 12h-labeled pool + optional shadow_v1_micro A/B (report-only).
 * Does not change default training, activation, live trading, or labels.
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import { SHADOW_FEATURE_NAMES, toShadowFeatureVector } from "../lib/ml/shadow-train/features";
import {
  SHADOW_FEATURE_NAMES_V1_MICRO,
  SHADOW_MICRO_SUFFIX_NAMES,
  toShadowFeatureVectorV1Micro,
} from "../lib/ml/shadow-train/features-shadow-v1-micro";
import { trainLogisticRegression, predictBatchLogistic } from "../lib/ml/baseline";
import { computeMetrics } from "../lib/ml/evaluate";
import { computeActiveFeatureIndices, balancedClassWeights } from "../lib/ml/shadow-train/train";

const DUMP_DIR = path.join(process.cwd(), "dump");
const JSON_PATH = path.join(DUMP_DIR, "bootstrap-feature-signal-audit.json");
const MD_PATH = path.join(DUMP_DIR, "bootstrap-feature-signal-audit.md");

const NEAR_CONST_VAR = 1e-6;

type PrismaRow = Awaited<ReturnType<typeof fetchRows>>[number];

async function fetchRows(limit: number) {
  return prisma.mlShadowTrainingExample.findMany({
    where: { labelGoodDecision12h: { not: null } },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: {
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
      depthSufficiency: true,
      quoteFreshnessState: true,
      tradable: true,
      grossExposure: true,
      totalOpenExposure: true,
      workingOrderExposure: true,
      maxSingleMarketConcentrationPct: true,
      maxSingleThemeConcentrationPct: true,
      worstCaseLossEstimate: true,
      nearResolutionExposure: true,
      illiquidExposureEstimate: true,
      correlatedExposureEstimate: true,
      portfolioRiskFlagsCount: true,
      runtimeSafetyState: true,
      runtimeWarningCount: true,
      runtimeBlockingCount: true,
      executionBlockingReasonGroups: true,
      intendedPrice: true,
      intendedSize: true,
      recommendationPresent: true,
      side: true,
      outcomeBlockedVsAllowedVsSubmitted: true,
      candidateSource: true,
      momentum1hBps: true,
      momentum6hBps: true,
      volatility1hBps: true,
      volatility6hBps: true,
      distanceFromMid: true,
      timeToCloseHours: true,
      liquidityTrend: true,
    },
  });
}

function toV1Input(r: PrismaRow) {
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
    momentum1hBps: r.momentum1hBps,
    momentum6hBps: r.momentum6hBps,
    volatility1hBps: r.volatility1hBps,
    volatility6hBps: r.volatility6hBps,
    distanceFromMid: r.distanceFromMid,
    timeToCloseHours: r.timeToCloseHours,
    liquidityTrend: r.liquidityTrend,
  };
}

function toMicroInput(r: PrismaRow) {
  return {
    ...toV1Input(r),
    depthSufficiency: r.depthSufficiency,
    quoteFreshnessState: r.quoteFreshnessState,
    workingOrderExposure: r.workingOrderExposure,
    worstCaseLossEstimate: r.worstCaseLossEstimate,
  };
}

function varianceCol(col: number[]): number {
  const n = col.length;
  if (n <= 1) return 0;
  const m = col.reduce((a, b) => a + b, 0) / n;
  let s = 0;
  for (const v of col) s += (v - m) * (v - m);
  return s / (n - 1);
}

/** Static taxonomy (runtime constant/near-constant layered on top). */
function baseFeatureGroup(name: string): string {
  const policy = new Set([
    "policyStateEnc",
    "blockedIndicator",
    "executionAllow",
    "outcomeBlockedVsAllowedVsSubmittedEnc",
    "eligibilityBlockersCount",
    "reducedSizeIndicator",
    "recommendationPresent",
    "runtimeWarningCount",
    "runtimeBlockingCount",
    "qualityStateEnc",
    "executionWarningCount",
    "sizeMultiplier",
    "finalSuggestedSize",
  ]);
  const market = new Set([
    "spreadBps",
    "estimatedSlippage",
    "tradable",
    "intendedPrice",
    "intendedSize",
    "sideEnc",
    "depthSufficiencyEnc",
    "quoteFreshnessEnc",
  ]);
  const portfolio = new Set([
    "grossExposure",
    "totalOpenExposure",
    "maxSingleMarketConcentrationPct",
    "maxSingleThemeConcentrationPct",
    "portfolioRiskFlagsCount",
    "workingOrderExposureNum",
    "worstCaseLossEstimateNum",
  ]);
  const path = new Set([
    "momentum1hBps",
    "momentum6hBps",
    "volatility1hBps",
    "volatility6hBps",
    "distanceFromMid",
    "timeToCloseHours",
    "liquidityTrend",
  ]);
  if (policy.has(name)) return "policy_execution_gating";
  if (market.has(name)) return "market_microstructure_entry";
  if (portfolio.has(name)) return "portfolio_risk_snapshot";
  if (path.has(name)) return "path_regime_historical";
  return "other";
}

/** Persisted on MlShadowTrainingExample but not passed into toShadowFeatureVector (shadow_v1). */
const ML_COLUMNS_NOT_IN_SHADOW_V1_VECTOR = [
  "depthSufficiency",
  "quoteFreshnessState",
  "workingOrderExposure",
  "worstCaseLossEstimate",
  "nearResolutionExposure",
  "illiquidExposureEstimate",
  "correlatedExposureEstimate",
  "runtimeSafetyState",
  "executionBlockingReasonGroups",
  "candidateSource",
  "assetId",
  "marketId",
  "recommendationId",
  "orderIntentId",
  "funderAddress",
  "shadowCandidateId",
  "wasBlocked",
  "wasSubmitted",
  "wasFilled",
  "markout1h",
  "markout6h",
  "markout12h",
  "markout24h",
  "outcomeClassification",
  "labelGoodDecision",
  "labelBadDecision",
  "labelMissedOpportunity",
  "labelExecutionUnsafe",
  "labelGoodDecision6h",
  "labelGoodDecision12h",
] as const;

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

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });
  const generatedAt = new Date().toISOString();
  const limit = Math.min(
    50_000,
    Math.max(500, parseInt(process.env.BOOTSTRAP_FEATURE_AUDIT_LIMIT ?? "9500", 10) || 9500)
  );
  const trainRatio = 0.8;

  try {
    const raw = await fetchRows(limit);
    const valid = raw.filter((r) => r.labelGoodDecision12h === true || r.labelGoodDecision12h === false);
    const splitIdx = Math.max(1, Math.floor(valid.length * trainRatio));
    const trainRows = valid.slice(0, splitIdx);
    const valRows = valid.slice(splitIdx);
    const yTrain = trainRows.map((r) => (r.labelGoodDecision12h ? 1 : 0));
    const yVal = valRows.map((r) => (r.labelGoodDecision12h ? 1 : 0));

    const Xv1All = valid.map((r) => toShadowFeatureVector(toV1Input(r)));
    const XmicroAll = valid.map((r) => toShadowFeatureVectorV1Micro(toMicroInput(r)));

    const inventory = SHADOW_FEATURE_NAMES.map((name, j) => {
      const col = Xv1All.map((row) => row[j] ?? 0);
      const v = varianceCol(col);
      const nonZero = col.filter((x) => x !== 0).length / col.length;
      const uniq = new Set(col.map((x) => Math.round(x * 1e6) / 1e6)).size;
      const group = baseFeatureGroup(name);
      let signalClass: "constant" | "near_constant" | "weak_varying" | "varying";
      if (v <= 1e-10) signalClass = "constant";
      else if (v < NEAR_CONST_VAR) signalClass = "near_constant";
      else if (nonZero < 0.02 && uniq <= 2) signalClass = "weak_varying";
      else signalClass = "varying";
      return {
        name,
        index: j,
        group,
        signalClass,
        variance: v,
        nonZeroRate: nonZero,
        approxDistinctValues: uniq,
        mean: col.reduce((a, b) => a + b, 0) / col.length,
      };
    });

    const microInventorySuffix = SHADOW_MICRO_SUFFIX_NAMES.map((name, k) => {
      const j = SHADOW_FEATURE_NAMES.length + k;
      const col = XmicroAll.map((row) => row[j] ?? 0);
      const v = varianceCol(col);
      const nonZero = col.filter((x) => x !== 0).length / col.length;
      const uniq = new Set(col.map((x) => Math.round(x * 1e6) / 1e6)).size;
      const group = baseFeatureGroup(name);
      let signalClass: "constant" | "near_constant" | "weak_varying" | "varying";
      if (v <= 1e-10) signalClass = "constant";
      else if (v < NEAR_CONST_VAR) signalClass = "near_constant";
      else if (nonZero < 0.02 && uniq <= 2) signalClass = "weak_varying";
      else signalClass = "varying";
      return { name, index: j, group, signalClass, variance: v, nonZeroRate: nonZero, approxDistinctValues: uniq };
    });

    const countsByClass = {
      constant: inventory.filter((x) => x.signalClass === "constant").length,
      near_constant: inventory.filter((x) => x.signalClass === "near_constant").length,
      weak_varying: inventory.filter((x) => x.signalClass === "weak_varying").length,
      varying: inventory.filter((x) => x.signalClass === "varying").length,
    };

    const dbColumnPopulation = {
      depthSufficiencyNonNull: valid.filter((r) => r.depthSufficiency != null && r.depthSufficiency !== "").length,
      quoteFreshnessStateNonNull: valid.filter((r) => r.quoteFreshnessState != null && r.quoteFreshnessState !== "").length,
      workingOrderExposureNonNull: valid.filter((r) => r.workingOrderExposure != null && r.workingOrderExposure !== "").length,
      worstCaseLossEstimateNonNull: valid.filter((r) => r.worstCaseLossEstimate != null && r.worstCaseLossEstimate !== "").length,
      nearResolutionExposureNonNull: valid.filter((r) => r.nearResolutionExposure != null && r.nearResolutionExposure !== "").length,
      illiquidExposureEstimateNonNull: valid.filter((r) => r.illiquidExposureEstimate != null && r.illiquidExposureEstimate !== "").length,
      correlatedExposureEstimateNonNull: valid.filter((r) => r.correlatedExposureEstimate != null && r.correlatedExposureEstimate !== "").length,
      runtimeSafetyStateNonNull: valid.filter((r) => r.runtimeSafetyState != null && r.runtimeSafetyState !== "").length,
      executionBlockingReasonGroupsNonNull: valid.filter(
        (r) => r.executionBlockingReasonGroups != null && r.executionBlockingReasonGroups !== ""
      ).length,
    };

    const candidateAdditionsRanked = [
      {
        rank: 1,
        feature: "depthSufficiency + quoteFreshnessState",
        rationale: "Entry-time quote/depth quality; already persisted on MlShadowTrainingExample; encoded in shadow_v1_micro.",
        implementationCost: "low",
        expectedSignal: "medium_for_spread_liquidity_path",
        inShadowV1Micro: true,
      },
      {
        rank: 2,
        feature: "workingOrderExposure + worstCaseLossEstimate",
        rationale: "Portfolio snapshot numerics at decision time; persisted; added as parseNum in shadow_v1_micro.",
        implementationCost: "low",
        expectedSignal: "low_medium_risk_context",
        inShadowV1Micro: true,
      },
      {
        rank: 3,
        feature: "nearResolutionExposure + illiquidExposureEstimate + correlatedExposureEstimate",
        rationale: "Risk snapshot fields exist on row but unused in vectors; parseNum similar to existing exposure features.",
        implementationCost: "low",
        expectedSignal: "low_unknown_until_measured",
        inShadowV1Micro: false,
      },
      {
        rank: 4,
        feature: "runtimeSafetyState (encoded)",
        rationale: "Runtime safety enum may correlate with cautious decisions vs outcomes.",
        implementationCost: "low",
        expectedSignal: "low_policy_adjacent",
        inShadowV1Micro: false,
      },
      {
        rank: 5,
        feature: "executionBlockingReasonGroups (hashed prefix count or length)",
        rationale: "Rich signal but high cardinality; needs careful bucketing.",
        implementationCost: "medium",
        expectedSignal: "unknown",
        inShadowV1Micro: false,
      },
      {
        rank: 6,
        feature: "assetId / marketId frequency or embedding",
        rationale: "Market-specific regimes; risk of overfit without regularization.",
        implementationCost: "high",
        expectedSignal: "high_if_data_sufficient",
        inShadowV1Micro: false,
      },
    ];

    const Xv1Train = trainRows.map((r) => toShadowFeatureVector(toV1Input(r)));
    const Xv1Val = valRows.map((r) => toShadowFeatureVector(toV1Input(r)));
    const XmicroTrain = trainRows.map((r) => toShadowFeatureVectorV1Micro(toMicroInput(r)));
    const XmicroVal = valRows.map((r) => toShadowFeatureVectorV1Micro(toMicroInput(r)));

    const v1Metrics = runModelCompare(Xv1Train, Xv1Val, yTrain, yVal, SHADOW_FEATURE_NAMES.length);
    const microMetrics = runModelCompare(
      XmicroTrain,
      XmicroVal,
      yTrain,
      yVal,
      SHADOW_FEATURE_NAMES_V1_MICRO.length
    );

    const aucDelta = microMetrics.validationRocAuc - v1Metrics.validationRocAuc;
    const materialGain = aucDelta >= 0.03 && microMetrics.validationRocAuc >= 0.54;
    const modestGain = aucDelta >= 0.015 && microMetrics.validationRocAuc > v1Metrics.validationRocAuc;

    const smallestRevision =
      "shadow_v1_micro = shadow_v1 + depthSufficiencyEnc + quoteFreshnessEnc + workingOrderExposureNum + worstCaseLossEstimateNum (lib/ml/shadow-train/features-shadow-v1-micro.ts). Wire to trainShadowModel behind featureSetName flag after repeated material A/B on larger pools.";

    const enoughRawDataNow =
      dbColumnPopulation.depthSufficiencyNonNull > valid.length * 0.05 ||
      dbColumnPopulation.quoteFreshnessStateNonNull > valid.length * 0.05 ||
      dbColumnPopulation.workingOrderExposureNonNull > valid.length * 0.05;

    const report = {
      generatedAt,
      constraints: {
        reportOnlyDefaultTrainingUnchanged: true,
        noActivationOrLiveTradingOrLabelChanges: true,
      },
      source: { pool: "labelGoodDecision12h IS NOT NULL", rowCount: valid.length, limit, trainRatio },
      shadowV1: {
        featureSetName: "shadow_v1",
        dimension: SHADOW_FEATURE_NAMES.length,
        inventory,
        countsByClass,
        groupsSummary: {
          policy_execution_gating: inventory.filter((x) => x.group === "policy_execution_gating").map((x) => x.name),
          market_microstructure_entry: inventory.filter((x) => x.group === "market_microstructure_entry").map((x) => x.name),
          portfolio_risk_snapshot: inventory.filter((x) => x.group === "portfolio_risk_snapshot").map((x) => x.name),
          path_regime_historical: inventory.filter((x) => x.group === "path_regime_historical").map((x) => x.name),
        },
        usefulVsWeakVsConstant: {
          note: "useful = varying + non-trivial nonZero; weak = near_constant or path_* all-zero in practice; constant = zero variance",
          constantNames: inventory.filter((x) => x.signalClass === "constant").map((x) => x.name),
          nearConstantNames: inventory.filter((x) => x.signalClass === "near_constant").map((x) => x.name),
          weakVaryingNames: inventory.filter((x) => x.signalClass === "weak_varying").map((x) => x.name),
          varyingNames: inventory.filter((x) => x.signalClass === "varying").map((x) => x.name),
        },
      },
      mlColumnsPersistedButNotInShadowV1Vector: [...ML_COLUMNS_NOT_IN_SHADOW_V1_VECTOR],
      dbColumnPopulationRates: {
        ...dbColumnPopulation,
        totalRows: valid.length,
      },
      experimentalFeatureSet: {
        name: "shadow_v1_micro",
        module: "lib/ml/shadow-train/features-shadow-v1-micro.ts",
        extraFeatureNames: [...SHADOW_MICRO_SUFFIX_NAMES],
        microInventoryOnPool: microInventorySuffix,
      },
      abCompareMixedLabel12h: {
        target: "labelGoodDecision12h (production mixed semantics)",
        shadow_v1: v1Metrics,
        shadow_v1_micro: microMetrics,
        aucDelta,
        f1At05Delta: microMetrics.f1At05 - v1Metrics.f1At05,
        materialGainThreshold: { deltaAucMin: 0.03, microAucMin: 0.54 },
        materialGain,
        modestGain,
        recommendation:
          materialGain
            ? "Consider optional trainShadowModel featureSet flag for shadow_v1_micro in paper-only retrain experiments."
            : modestGain
              ? "Micro add-ons help marginally; collect more varying path_regime data and add nearResolution/illiquid/correlated numerics next."
              : "No material lift; dominant issue remains weak path features + label noise — expand snapshot-derived momentum/volatility backfill before more columns.",
      },
      candidateAdditionsRanked,
      smallestRecommendedFeatureRevisionForPaperExperiment: smallestRevision,
      enoughExistingRawDataToBuildBetterSetNow: enoughRawDataNow,
      conclusion: {
        primaryFinding:
          countsByClass.varying <= 10
            ? "Few varying features; many path_regime slots are zero-filled on this pool — shadow_v1 is policy-heavy."
            : "Feature inventory skews to policy/portfolio; market path signals are sparse.",
        microExperimentOutcome: materialGain
          ? "shadow_v1_micro shows material validation AUC gain vs shadow_v1 on this slice."
          : "shadow_v1_micro does not materially beat shadow_v1 on validation AUC — do not change default training yet.",
      },
    };

    await fs.writeFile(JSON_PATH, JSON.stringify(report, null, 2), "utf8");

    const md = `# Bootstrap feature signal audit

Generated: ${generatedAt}

## Pool

- Rows: **${valid.length}** (limit=${limit}), mixed \`labelGoodDecision12h\`

## shadow_v1 inventory (variance on pool)

| Class | Count |
|-------|------:|
| constant | ${countsByClass.constant} |
| near_constant | ${countsByClass.near_constant} |
| weak_varying | ${countsByClass.weak_varying} |
| varying | ${countsByClass.varying} |

### Constant (${countsByClass.constant})

${inventory
  .filter((x) => x.signalClass === "constant")
  .map((x) => `- ${x.name}`)
  .join("\n") || "- (none)"}

### Near-constant (var < ${NEAR_CONST_VAR})

${inventory
  .filter((x) => x.signalClass === "near_constant")
  .map((x) => `- ${x.name} (var=${x.variance.toExponential(2)})`)
  .join("\n") || "- (none)"}

### Varying

${inventory
  .filter((x) => x.signalClass === "varying")
  .map((x) => `- ${x.name} (var=${x.variance.toExponential(2)}, nonZero=${(x.nonZeroRate * 100).toFixed(1)}%)`)
  .join("\n") || "- (none)"}

## Feature groups (taxonomy)

- **Policy / execution gating:** ${report.shadowV1.groupsSummary.policy_execution_gating.join(", ")}
- **Market microstructure (entry):** ${report.shadowV1.groupsSummary.market_microstructure_entry.join(", ")}
- **Portfolio risk snapshot:** ${report.shadowV1.groupsSummary.portfolio_risk_snapshot.join(", ")}
- **Path / regime (historical slots):** ${report.shadowV1.groupsSummary.path_regime_historical.join(", ")}

## DB columns populated (non-null non-empty)

| Field | Count |
|-------|------:|
| depthSufficiency | ${dbColumnPopulation.depthSufficiencyNonNull} |
| quoteFreshnessState | ${dbColumnPopulation.quoteFreshnessStateNonNull} |
| workingOrderExposure | ${dbColumnPopulation.workingOrderExposureNonNull} |
| worstCaseLossEstimate | ${dbColumnPopulation.worstCaseLossEstimateNonNull} |
| nearResolutionExposure | ${dbColumnPopulation.nearResolutionExposureNonNull} |
| illiquidExposureEstimate | ${dbColumnPopulation.illiquidExposureEstimateNonNull} |
| correlatedExposureEstimate | ${dbColumnPopulation.correlatedExposureEstimateNonNull} |
| runtimeSafetyState | ${dbColumnPopulation.runtimeSafetyStateNonNull} |

**Enough raw data for richer vectors now?** → **${enoughRawDataNow ? "Partially — execution-quality + some risk strings are populated enough to justify micro add-ons." : "Limited — most optional columns sparse; prioritize backfilling path_regime fields into existing slots."}**

## A/B (same split, balanced LR, constant drop): shadow_v1 vs shadow_v1_micro

| Set | val ROC-AUC | F1@0.5 | active (after const drop) |
|-----|------------|--------|---------------------------|
| shadow_v1 | ${v1Metrics.validationRocAuc.toFixed(4)} | ${v1Metrics.f1At05.toFixed(4)} | ${v1Metrics.activeFeatureCount} |
| shadow_v1_micro | ${microMetrics.validationRocAuc.toFixed(4)} | ${microMetrics.f1At05.toFixed(4)} | ${microMetrics.activeFeatureCount} |

- ΔAUC = **${aucDelta.toFixed(4)}**
- Material gain (Δ≥0.03 and micro AUC≥0.54): **${materialGain}**
- **${report.conclusion.microExperimentOutcome}**

## Smallest paper-only revision

${smallestRevision}

## Top candidate additions (ranked)

${candidateAdditionsRanked.map((c) => `${c.rank}. **${c.feature}** (${c.implementationCost}) — ${c.rationale}`).join("\n\n")}
`;

    await fs.writeFile(MD_PATH, md, "utf8");
    console.log(`Wrote ${JSON_PATH}`);
    console.log(`Wrote ${MD_PATH}`);
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    await fs.writeFile(JSON_PATH, JSON.stringify({ generatedAt, error: err }, null, 2), "utf8");
    await fs.writeFile(MD_PATH, `# Bootstrap feature signal audit\n\nError: ${err}\n`, "utf8");
    throw e;
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
