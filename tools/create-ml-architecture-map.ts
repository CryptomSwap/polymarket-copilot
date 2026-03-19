/**
 * Dump current ML pipeline architecture map for review.
 * Outputs: dump/ml-architecture-map.json, dump/ml-architecture-map.md
 * No runtime inspection; documents known paths and modules from codebase.
 */

import * as fs from "fs";
import * as path from "path";

const DUMP_DIR = path.join(process.cwd(), "dump");

const ARCHITECTURE_MAP = {
  version: "1.0",
  generatedAt: new Date().toISOString(),
  summary: {
    featurePaths: "Two pipelines: (1) recommendation ML: lib/ml/features.ts, dataset.ts; (2) shadow ML: lib/ml/shadow-train/features.ts, shadow-dataset/build.ts",
    targetDefinitions: "Recommendation: labelPositive6h, labelPositive24h from RecommendationEvaluation. Shadow: labelGoodDecision, labelGoodDecision6h, labelGoodDecision12h, labelMissedOpportunity from outcomeClassification + markouts",
    trainTestSplit: "Time-based: oldest 80% train, newest 20% val. loadTrainingDataTimeSplit (dataset.ts), trainShadowModel (shadow-train/train.ts)",
    modelPersistence: "MlModelRun (Prisma); metricsJson holds coefficients, intercept, means, stds for logistic regression",
    scoringPath: "lib/ml/shadow-score/score-live.ts: getActiveOrApprovedShadowModel, scoreShadowCandidate",
    thresholdUsage: "Paper engine: config.threshold + config.minScoreBuffer (lib/paper-trading/engine.ts). Bands: 0.4 medium, 0.6 high (score-live.ts)",
    candidateSelection: "Paper only: runPaperTradingTick scores each candidate, opens trade when score >= minScore (engine.ts). No ML in live execution path.",
    mlPaperFlow: "Candidates from getPaperTradingCandidatesWithDiagnostics; relaxed BLOCK snapshots built by relaxed-candidate-builder; scoreShadowCandidate per candidate; open if above threshold + risk limits",
    leakageRisks: "priorityScore in recommendation features (heuristic output). Shadow: outcomeBlockedVsAllowedVsSubmitted omitted at score time (null). Leakage check: lib/ml/leakage-check.ts",
    calibrationGaps: "No calibration applied to score output; raw logistic probability used. calibration.ts exists for diagnostics only.",
    overloadedScore: "Single shadowMlScore used for: (1) ranking candidates, (2) threshold gate for paper open, (3) display band. No separate ranking vs probability vs uncertainty.",
  },
  paths: {
    featureGeneration: {
      recommendation: {
        module: "lib/ml/features.ts",
        toFeatureVector: "toFeatureVector",
        toTrainingRow: "toTrainingRow",
        featureSet: "FEATURE_SET_V1",
        featureNames: "FEATURE_NAMES (21 features)",
      },
      shadow: {
        module: "lib/ml/shadow-train/features.ts",
        toShadowFeatureVector: "toShadowFeatureVector",
        featureSet: "SHADOW_FEATURE_SET_V1 (shadow_v1)",
        featureNames: "SHADOW_FEATURE_NAMES (26 features)",
        inputType: "ShadowFeatureInput",
      },
    },
    datasetBuild: {
      recommendation: {
        module: "lib/ml/dataset.ts",
        buildDataset: "buildDataset(funderAddress?)",
        loadTrainingData: "loadTrainingData(funder, targetLabel)",
        loadTrainingDataTimeSplit: "loadTrainingDataTimeSplit(funder, targetLabel, trainRatio)",
        table: "MlTrainingExample",
        labelSource: "Recommendation.evaluations[0] (priceChange6h/24h, wasPositive)",
      },
      shadow: {
        module: "lib/ml/shadow-dataset/build.ts",
        buildShadowTrainingExamples: "buildShadowTrainingExamples",
        persistShadowTrainingExamples: "persistShadowTrainingExamples",
        buildShadowTrainingRow: "buildShadowTrainingRow",
        deriveLabels: "deriveLabels(outcome, wasBlocked, executionQualityHadBlocks)",
        table: "MlShadowTrainingExample",
        labelSource: "outcomeClassification (good_allow, bad_allow, good_block, bad_block) -> labelGoodDecision, labelMissedOpportunity",
      },
      shadowOfflineHistorical: {
        module: "lib/ml/shadow-dataset/offline-historical.ts",
        buildOfflineHistorical: "buildOfflineHistoricalSnapshot / persist",
        labelSource: "markout at 6h/12h/24h + classify() -> outcomeClassification, then deriveLabels",
      },
    },
    targetsAndLabels: {
      recommendation: {
        targetLabels: ["labelPositive6h", "labelPositive24h"],
        definition: "forwardReturn > 0 at 6h or 24h from RecommendationEvaluation",
        module: "lib/ml/dataset.ts",
      },
      shadow: {
        targetLabels: ["labelGoodDecision", "labelGoodDecision6h", "labelGoodDecision12h", "labelMissedOpportunity"],
        definition: "labelGoodDecision from outcome (good_allow, good_block=true; bad_allow, bad_block=false). 6h/12h from markout horizons (schema present; build may not populate 6h/12h yet).",
        module: "lib/ml/shadow-dataset/build.ts (deriveLabels)",
        schema: "prisma/schema.prisma MlShadowTrainingExample labelGoodDecision, labelGoodDecision6h, labelGoodDecision12h",
      },
    },
    trainTestSplit: {
      method: "time-ordered split",
      recommendation: "lib/ml/dataset.ts loadTrainingDataTimeSplit orderBy createdAt asc, split at trainRatio (default 0.8)",
      shadow: "lib/ml/shadow-train/train.ts valid rows orderBy createdAt asc, splitIdx = floor(length * trainRatio)",
    },
    modelTraining: {
      recommendation: "lib/ml/train-and-persist.ts (if used); baseline: lib/ml/baseline.ts trainLogisticRegression",
      shadow: {
        module: "lib/ml/shadow-train/train.ts",
        trainShadowModel: "trainShadowModel(targetLabel?, options?)",
        modelType: "logistic_regression_shadow",
        baseline: "lib/ml/baseline.ts trainLogisticRegression, predictBatchLogistic",
        evaluate: "lib/ml/evaluate.ts computeMetrics",
      },
    },
    modelPersistence: {
      table: "MlModelRun",
      schema: "prisma/schema.prisma",
      fields: "modelType, targetLabel, featureSetName, status, trainCount, validationCount, trainedFrom, trainedTo, validatedFrom, validatedTo, metricsJson, artifactPath, leakageCheckPassed",
      metricsJsonContents: "accuracy, precision, recall, f1, rocAuc, threshold, coefficients, intercept, means, stds",
    },
    scoring: {
      module: "lib/ml/shadow-score/score-live.ts",
      getActiveOrApprovedShadowModel: "getActiveOrApprovedShadowModel()",
      scoreShadowCandidate: "scoreShadowCandidate(input: ShadowScoreInput)",
      parseModelFromMetricsJson: "parseModelFromMetricsJson(metricsJson)",
      bandLogic: "proba >= 0.6 high, >= 0.4 medium, else low",
      featureWarnings: "buildFeatureWarnings(input)",
    },
    thresholdUsage: {
      paperConfig: "lib/paper-trading/config.ts getPaperTradingConfig(), PAPER_TRADING_THRESHOLD (default 0.3), PAPER_TRADING_MIN_SCORE_BUFFER",
      paperEngine: "lib/paper-trading/engine.ts runPaperTradingTick: minScore = config.threshold + config.minScoreBuffer; open if score >= minScore",
    },
    candidateSelection: {
      paperOnly: "lib/paper-trading/engine.ts runPaperTradingTick",
      flow: "getPaperTradingCandidatesWithDiagnostics -> for each candidate scoreShadowCandidate -> if score >= minScore and risk/dedupe pass -> create PaperTrade",
      noLiveExecution: "Live execution uses staged decision engine only; no ML gate.",
    },
    calibrationAndEval: {
      calibrationModule: "lib/ml/calibration.ts",
      calibrationSummary: "calibrationSummary(probas, y, numBuckets)",
      calibrationReport: "calibrationReport(probas, y, numBuckets)",
      evaluateModule: "lib/ml/evaluate.ts",
      computeMetrics: "computeMetrics(probas, y, threshold)",
    },
    leakageAndPurity: {
      leakageCheck: "lib/ml/leakage-check.ts checkFeatureSetLeakage (FORBIDDEN_FEATURE_NAMES, POST_TRADE_FIELDS)",
      shadowScoreOmission: "outcomeBlockedVsAllowedVsSubmitted set to null at score time (score-live.ts)",
    },
  },
};

function ensureDumpDir(): void {
  if (!fs.existsSync(DUMP_DIR)) {
    fs.mkdirSync(DUMP_DIR, { recursive: true });
  }
}

function main(): void {
  ensureDumpDir();
  const jsonPath = path.join(DUMP_DIR, "ml-architecture-map.json");
  const mdPath = path.join(DUMP_DIR, "ml-architecture-map.md");
  fs.writeFileSync(jsonPath, JSON.stringify(ARCHITECTURE_MAP, null, 2), "utf-8");
  console.log(`Wrote ${jsonPath}`);

  const md = [
    "# ML Architecture Map",
    "",
    `Generated: ${ARCHITECTURE_MAP.generatedAt}`,
    "",
    "## Summary",
    "",
    ...Object.entries(ARCHITECTURE_MAP.summary).map(([k, v]) => `- **${k}**: ${v}`),
    "",
    "## Paths (files / functions)",
    "",
    "### Feature generation",
    "- Recommendation: `lib/ml/features.ts` — `toFeatureVector`, `toTrainingRow`, `FEATURE_NAMES` (21 features)",
    "- Shadow: `lib/ml/shadow-train/features.ts` — `toShadowFeatureVector`, `SHADOW_FEATURE_NAMES` (26)",
    "",
    "### Dataset build",
    "- Recommendation: `lib/ml/dataset.ts` — `buildDataset`, `loadTrainingData`, `loadTrainingDataTimeSplit`; table `MlTrainingExample`",
    "- Shadow: `lib/ml/shadow-dataset/build.ts` — `buildShadowTrainingExamples`, `persistShadowTrainingExamples`, `deriveLabels`; table `MlShadowTrainingExample`",
    "- Shadow offline: `lib/ml/shadow-dataset/offline-historical.ts` — build from MarketPriceSnapshot + markout",
    "",
    "### Targets / labels",
    "- Recommendation: `labelPositive6h`, `labelPositive24h` (forward return > 0 from RecommendationEvaluation)",
    "- Shadow: `labelGoodDecision`, `labelGoodDecision6h`, `labelGoodDecision12h`, `labelMissedOpportunity` (from outcomeClassification; 6h/12h in schema, build may not populate)",
    "",
    "### Train/test split",
    "- Time-ordered; train on oldest 80%, validate on newest 20%. `dataset.ts` / `shadow-train/train.ts`",
    "",
    "### Model training",
    "- Shadow: `lib/ml/shadow-train/train.ts` — `trainShadowModel`; `lib/ml/baseline.ts` — `trainLogisticRegression`",
    "",
    "### Model persistence",
    "- `MlModelRun` (Prisma); `metricsJson` holds coefficients, intercept, means, stds",
    "",
    "### Scoring",
    "- `lib/ml/shadow-score/score-live.ts` — `getActiveOrApprovedShadowModel`, `scoreShadowCandidate`; bands 0.4 / 0.6",
    "",
    "### Threshold usage",
    "- `lib/paper-trading/config.ts` — `PAPER_TRADING_THRESHOLD` (default 0.3); `lib/paper-trading/engine.ts` — open when score >= threshold + minScoreBuffer",
    "",
    "### Candidate selection",
    "- Paper only: `lib/paper-trading/engine.ts` — `runPaperTradingTick`; no ML in live execution",
    "",
    "### Calibration / evaluation",
    "- `lib/ml/calibration.ts` — bucket calibration; `lib/ml/evaluate.ts` — `computeMetrics`",
    "",
    "### Leakage / purity",
    "- `lib/ml/leakage-check.ts`; shadow score omits `outcomeBlockedVsAllowedVsSubmitted` at score time",
    "",
  ].join("\n");
  fs.writeFileSync(mdPath, md, "utf-8");
  console.log(`Wrote ${mdPath}`);
}

main();
