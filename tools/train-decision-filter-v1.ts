/**
 * Train decision-filter v1 from dump/ml-training-dataset-v2.csv.
 *
 * Outputs:
 * - dump/decision-filter-v1-model.json
 * - dump/decision-filter-v1-report.md
 *
 * Design goals:
 * - Deterministic training/evaluation.
 * - No DB writes (artifact-only).
 * - Reuse existing logistic/eval utils to avoid parallel ML stacks.
 */

import * as fs from "fs/promises";
import * as path from "path";
import { trainLogisticRegression, predictBatchLogistic, getLogisticFeatureImportance } from "../lib/ml/baseline";
import { computeMetrics } from "../lib/ml/evaluate";

type Args = {
  inputCsv: string;
  outputModel: string;
  outputReport: string;
  trainRatio: number;
  trimOutliers: boolean;
  trimLowerQ: number;
  trimUpperQ: number;
  minThresholdSamples: number;
};

type InputRow = Record<string, string>;

type ParsedRow = {
  decisionId: string;
  decisionAt: Date;
  score: number;
  scoreThresholdGap: number;
  probabilityBand: string;
  entryPriceBand: string;
  botType: string;
  spreadBps: number | null;
  estimatedSlippageBps: number | null;
  numericReturn12h: number;
  labelGoodDecision12h: number;
};

type Encoded = {
  id: string;
  decisionAt: string;
  x: number[];
  y: number;
  ret: number;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    inputCsv: path.join(process.cwd(), "dump", "ml-training-dataset-v2.csv"),
    outputModel: path.join(process.cwd(), "dump", "decision-filter-v1-model.json"),
    outputReport: path.join(process.cwd(), "dump", "decision-filter-v1-report.md"),
    trainRatio: 0.8,
    trimOutliers: false,
    trimLowerQ: 0.01,
    trimUpperQ: 0.99,
    minThresholdSamples: 30,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--input" && argv[i + 1]) args.inputCsv = path.resolve(argv[++i]);
    else if (a === "--model-out" && argv[i + 1]) args.outputModel = path.resolve(argv[++i]);
    else if (a === "--report-out" && argv[i + 1]) args.outputReport = path.resolve(argv[++i]);
    else if (a === "--train-ratio" && argv[i + 1]) args.trainRatio = Math.max(0.5, Math.min(0.95, Number(argv[++i]) || 0.8));
    else if (a === "--trim-outliers") args.trimOutliers = true;
    else if (a === "--trim-lower-q" && argv[i + 1]) args.trimLowerQ = Math.max(0, Math.min(0.2, Number(argv[++i]) || 0.01));
    else if (a === "--trim-upper-q" && argv[i + 1]) args.trimUpperQ = Math.max(0.8, Math.min(1, Number(argv[++i]) || 0.99));
    else if (a === "--min-threshold-samples" && argv[i + 1]) args.minThresholdSamples = Math.max(5, Number(argv[++i]) || 30);
  }
  return args;
}

function parseNum(v: string | undefined): number | null {
  if (v == null || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1))));
  return sorted[idx] ?? null;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function parseCsv(content: string): InputRow[] {
  const lines = content.replace(/\r/g, "").split("\n").filter((l) => l.length > 0);
  if (lines.length < 2) return [];
  const headers = splitCsvLine(lines[0]);
  const rows: InputRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = splitCsvLine(lines[i]);
    const row: InputRow = {};
    for (let j = 0; j < headers.length; j++) row[headers[j]] = vals[j] ?? "";
    rows.push(row);
  }
  return rows;
}

function parseRows(rows: InputRow[]): ParsedRow[] {
  const out: ParsedRow[] = [];
  for (const r of rows) {
    const decisionAt = new Date(r.decisionAt ?? "");
    if (Number.isNaN(decisionAt.getTime())) continue;
    const score = parseNum(r.score);
    const gap = parseNum(r.scoreThresholdGap);
    const ret = parseNum(r.numericReturn12h);
    const labelRaw = (r.labelGoodDecision12h ?? "").toLowerCase();
    if (score == null || gap == null || ret == null) continue;
    if (labelRaw !== "true" && labelRaw !== "false") continue;
    out.push({
      decisionId: r.decisionId ?? "",
      decisionAt,
      score,
      scoreThresholdGap: gap,
      probabilityBand: r.probabilityBand ?? "unknown",
      entryPriceBand: r.entryPriceBand ?? "unknown",
      botType: r.botType ?? "unknown",
      spreadBps: parseNum(r.spreadBps),
      estimatedSlippageBps: parseNum(r.estimatedSlippageBps),
      numericReturn12h: ret,
      labelGoodDecision12h: labelRaw === "true" ? 1 : 0,
    });
  }
  return out.sort((a, b) =>
    a.decisionAt.getTime() === b.decisionAt.getTime()
      ? a.decisionId.localeCompare(b.decisionId)
      : a.decisionAt.getTime() - b.decisionAt.getTime()
  );
}

function oneHot(value: string, categories: string[]): number[] {
  return categories.map((c) => (value === c ? 1 : 0));
}

function aucOnly(probas: number[], labels: number[]): number {
  return computeMetrics(probas, labels).rocAuc;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const raw = await fs.readFile(args.inputCsv, "utf8");
  const allRows = parseRows(parseCsv(raw));
  if (allRows.length < 50) {
    throw new Error(`Not enough valid rows: ${allRows.length}. Need at least 50.`);
  }

  let rows = allRows;
  let trimInfo: { enabled: boolean; lowerCut: number | null; upperCut: number | null; dropped: number } = {
    enabled: args.trimOutliers,
    lowerCut: null,
    upperCut: null,
    dropped: 0,
  };
  if (args.trimOutliers) {
    const returnsSorted = rows.map((r) => r.numericReturn12h).sort((a, b) => a - b);
    const lo = quantile(returnsSorted, args.trimLowerQ);
    const hi = quantile(returnsSorted, args.trimUpperQ);
    trimInfo.lowerCut = lo;
    trimInfo.upperCut = hi;
    if (lo != null && hi != null && lo <= hi) {
      const before = rows.length;
      rows = rows.filter((r) => r.numericReturn12h >= lo && r.numericReturn12h <= hi);
      trimInfo.dropped = before - rows.length;
    }
  }

  const split = Math.max(20, Math.floor(rows.length * args.trainRatio));
  const train = rows.slice(0, split);
  const val = rows.slice(split);
  if (val.length < 20) throw new Error(`Validation window too small: ${val.length}`);

  const botCats = Array.from(new Set(train.map((r) => r.botType || "unknown"))).sort();
  const probCats = Array.from(new Set(train.map((r) => r.probabilityBand || "unknown"))).sort();
  const priceCats = Array.from(new Set(train.map((r) => r.entryPriceBand || "unknown"))).sort();

  const featureNames = [
    "score",
    "scoreThresholdGap",
    ...probCats.map((c) => `probabilityBand=${c}`),
    ...priceCats.map((c) => `entryPriceBand=${c}`),
    ...botCats.map((c) => `botType=${c}`),
    "spreadBps",
    "estimatedSlippageBps",
  ];

  const encode = (r: ParsedRow): Encoded => {
    const x = [
      r.score,
      r.scoreThresholdGap,
      ...oneHot(r.probabilityBand || "unknown", probCats),
      ...oneHot(r.entryPriceBand || "unknown", priceCats),
      ...oneHot(r.botType || "unknown", botCats),
      r.spreadBps ?? 0,
      r.estimatedSlippageBps ?? 0,
    ];
    return {
      id: r.decisionId,
      decisionAt: r.decisionAt.toISOString(),
      x,
      y: r.labelGoodDecision12h,
      ret: r.numericReturn12h,
    };
  };

  const trainE = train.map(encode);
  const valE = val.map(encode);

  const model = trainLogisticRegression(
    trainE.map((r) => r.x),
    trainE.map((r) => r.y),
    { learningRate: 0.1, maxIter: 800, l2Lambda: 0.02 }
  );
  const valProbas = predictBatchLogistic(model, valE.map((r) => r.x));
  const valLabels = valE.map((r) => r.y);
  const metrics = computeMetrics(valProbas, valLabels, 0.5);

  const calBuckets: Array<{ bucket: string; n: number; avgPred: number | null; empirical: number | null }> = [];
  for (let b = 0; b < 10; b++) {
    const lo = b / 10;
    const hi = (b + 1) / 10;
    const idx = valProbas
      .map((p, i) => ({ p, i }))
      .filter((x) => (b === 9 ? x.p >= lo && x.p <= hi : x.p >= lo && x.p < hi))
      .map((x) => x.i);
    const n = idx.length;
    const avgPred = n > 0 ? idx.reduce((acc, i) => acc + valProbas[i], 0) / n : null;
    const empirical = n > 0 ? idx.reduce((acc, i) => acc + valLabels[i], 0) / n : null;
    calBuckets.push({ bucket: `[${lo.toFixed(1)},${hi.toFixed(1)}${b === 9 ? "]" : ")"}`, n, avgPred, empirical });
  }

  const sortedByProba = valProbas.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  const decileRows: Array<{ decile: number; n: number; avgPred: number; meanReturn: number; hitRate: number }> = [];
  for (let d = 0; d < 10; d++) {
    const start = Math.floor((d * sortedByProba.length) / 10);
    const end = Math.floor(((d + 1) * sortedByProba.length) / 10);
    const slice = sortedByProba.slice(start, end);
    const n = slice.length;
    const avgPred = n > 0 ? slice.reduce((acc, x) => acc + x.p, 0) / n : 0;
    const meanReturn = n > 0 ? slice.reduce((acc, x) => acc + valE[x.i].ret, 0) / n : 0;
    const hitRate = n > 0 ? slice.filter((x) => valE[x.i].ret > 0).length / n : 0;
    decileRows.push({ decile: d + 1, n, avgPred, meanReturn, hitRate });
  }

  const baselineMean = valE.reduce((acc, r) => acc + r.ret, 0) / valE.length;
  const baselineHit = valE.filter((r) => r.ret > 0).length / valE.length;
  let bestThreshold = 0.5;
  let bestFilteredMean = -Infinity;
  let bestFilteredN = 0;
  let bestFilteredHit = 0;
  for (let t = 0.1; t <= 0.9 + 1e-9; t += 0.02) {
    const kept = valE.filter((_, i) => valProbas[i] >= t);
    if (kept.length < args.minThresholdSamples) continue;
    const m = kept.reduce((acc, r) => acc + r.ret, 0) / kept.length;
    if (m > bestFilteredMean || (Math.abs(m - bestFilteredMean) < 1e-12 && kept.length > bestFilteredN)) {
      bestThreshold = Number(t.toFixed(2));
      bestFilteredMean = m;
      bestFilteredN = kept.length;
      bestFilteredHit = kept.filter((r) => r.ret > 0).length / kept.length;
    }
  }

  const importance = getLogisticFeatureImportance(model, featureNames).slice(0, 20);

  const modelArtifact = {
    modelType: "logistic_regression_shadow_decision_filter_v1",
    featureSetName: "decision_filter_v1_from_dataset_v2",
    targetLabel: "labelGoodDecision12h",
    trainedAt: new Date().toISOString(),
    train: {
      rows: trainE.length,
      from: trainE[0]?.decisionAt ?? null,
      to: trainE[trainE.length - 1]?.decisionAt ?? null,
    },
    validation: {
      rows: valE.length,
      from: valE[0]?.decisionAt ?? null,
      to: valE[valE.length - 1]?.decisionAt ?? null,
    },
    features: {
      names: featureNames,
      categories: {
        probabilityBand: probCats,
        entryPriceBand: priceCats,
        botType: botCats,
      },
    },
    model: {
      coefficients: model.coefficients,
      intercept: model.intercept,
      means: model.means,
      stds: model.stds,
    },
    metrics: {
      auc: aucOnly(valProbas, valLabels),
      accuracy: metrics.accuracy,
      precision: metrics.precision,
      recall: metrics.recall,
      f1: metrics.f1,
    },
    calibration: calBuckets,
    pnl: {
      baseline: {
        n: valE.length,
        meanReturn12h: baselineMean,
        hitRate: baselineHit,
      },
      filtered: {
        threshold: bestThreshold,
        n: bestFilteredN,
        meanReturn12h: Number.isFinite(bestFilteredMean) ? bestFilteredMean : null,
        hitRate: bestFilteredN > 0 ? bestFilteredHit : null,
        upliftVsBaseline: Number.isFinite(bestFilteredMean) ? bestFilteredMean - baselineMean : null,
      },
      byPredictedProbabilityDecile: decileRows,
    },
    trainingConfig: {
      trainRatio: args.trainRatio,
      trimOutliers: trimInfo.enabled,
      trimLowerQ: args.trimLowerQ,
      trimUpperQ: args.trimUpperQ,
      trimLowerCut: trimInfo.lowerCut,
      trimUpperCut: trimInfo.upperCut,
      trimDroppedRows: trimInfo.dropped,
      minThresholdSamples: args.minThresholdSamples,
    },
  };

  const report = [
    "# Decision Filter V1 Training Report",
    "",
    `- Input: \`${args.inputCsv}\``,
    `- Rows used: ${rows.length} (train ${trainE.length}, validation ${valE.length})`,
    `- Target: \`labelGoodDecision12h\``,
    "",
    "## Validation Metrics",
    "",
    `- AUC: ${modelArtifact.metrics.auc.toFixed(4)}`,
    `- Accuracy: ${metrics.accuracy.toFixed(4)}`,
    `- Precision: ${metrics.precision.toFixed(4)}`,
    `- Recall: ${metrics.recall.toFixed(4)}`,
    `- F1: ${metrics.f1.toFixed(4)}`,
    "",
    "## Recommended Filtering Threshold",
    "",
    `- Threshold: **${bestThreshold.toFixed(2)}**`,
    `- Baseline mean return12h: ${baselineMean.toFixed(6)} (n=${valE.length})`,
    `- Filtered mean return12h: ${Number.isFinite(bestFilteredMean) ? bestFilteredMean.toFixed(6) : "n/a"} (n=${bestFilteredN})`,
    `- PnL uplift vs baseline: ${Number.isFinite(bestFilteredMean) ? (bestFilteredMean - baselineMean).toFixed(6) : "n/a"}`,
    "",
    "## Feature Importance (Top 15 by |coef|)",
    "",
    "| feature | coefficient | |coef| |",
    "|---|---:|---:|",
    ...importance.slice(0, 15).map((f) => `| ${f.name} | ${f.coefficient.toFixed(6)} | ${f.absCoefficient.toFixed(6)} |`),
    "",
    "## Calibration (Bucketed)",
    "",
    "| bucket | n | avg predicted | empirical positive rate |",
    "|---|---:|---:|---:|",
    ...calBuckets.map((b) => `| ${b.bucket} | ${b.n} | ${b.avgPred == null ? "n/a" : b.avgPred.toFixed(4)} | ${b.empirical == null ? "n/a" : b.empirical.toFixed(4)} |`),
    "",
    "## PnL by Predicted Probability Decile",
    "",
    "| decile (low->high) | n | avg pred | mean return12h | hit rate |",
    "|---:|---:|---:|---:|---:|",
    ...decileRows.map((d) => `| ${d.decile} | ${d.n} | ${d.avgPred.toFixed(4)} | ${d.meanReturn.toFixed(6)} | ${d.hitRate.toFixed(4)} |`),
    "",
  ].join("\n");

  await fs.mkdir(path.dirname(args.outputModel), { recursive: true });
  await fs.mkdir(path.dirname(args.outputReport), { recursive: true });
  await fs.writeFile(args.outputModel, JSON.stringify(modelArtifact, null, 2), "utf8");
  await fs.writeFile(args.outputReport, report, "utf8");

  console.log(`Wrote ${args.outputModel}`);
  console.log(`Wrote ${args.outputReport}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

