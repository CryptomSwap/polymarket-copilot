/**
 * Calibration and threshold diagnostics: score buckets, decile lift, threshold sensitivity.
 * Outputs: dump/ml-calibration-threshold-report.json, dump/ml-calibration-threshold-report.md
 */

import * as fs from "fs";
import * as path from "path";
import { prisma } from "../lib/db";
import { calibrationReport } from "../lib/ml/calibration";
import { toShadowFeatureVector } from "../lib/ml/shadow-train/features";
import { predictBatchLogistic } from "../lib/ml/baseline";

const DUMP_DIR = path.join(process.cwd(), "dump");
const THRESHOLDS = [0.3, 0.4, 0.5, 0.6];
const NUM_BUCKETS = 10;

function ensureDumpDir(): void {
  if (!fs.existsSync(DUMP_DIR)) fs.mkdirSync(DUMP_DIR, { recursive: true });
}

function parseModelFromMetricsJson(metricsJson: string | null): { coefficients: number[]; intercept: number; means: number[]; stds: number[] } | null {
  if (!metricsJson) return null;
  try {
    const parsed = JSON.parse(metricsJson) as Record<string, unknown>;
    const coef = parsed.coefficients as number[] | undefined;
    const intercept = parsed.intercept as number | undefined;
    const means = parsed.means as number[] | undefined;
    const stds = parsed.stds as number[] | undefined;
    if (!Array.isArray(coef) || typeof intercept !== "number" || !Array.isArray(means) || !Array.isArray(stds))
      return null;
    return { coefficients: coef, intercept, means, stds };
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  ensureDumpDir();
  const report: {
    generatedAt: string;
    dataAvailable: boolean;
    calibration?: ReturnType<typeof calibrationReport>;
    thresholdSensitivity?: Array<{ threshold: number; precision: number; recall: number; tp: number; fp: number; tn: number; fn: number }>;
    bucketDefinitions: string;
    sparseWarning?: string;
  } = {
    generatedAt: new Date().toISOString(),
    dataAvailable: false,
    bucketDefinitions: `Buckets: ${NUM_BUCKETS} equal-width bins in [0,1]. Thresholds evaluated: ${THRESHOLDS.join(", ")}.`,
  };

  try {
    const run = await prisma.mlModelRun.findFirst({
      where: { modelType: "logistic_regression_shadow", status: { in: ["ACTIVE", "APPROVED"] } },
      orderBy: { updatedAt: "desc" },
    });
    if (!run?.metricsJson) {
      report.sparseWarning = "No ACTIVE/APPROVED shadow model found; calibration uses no model.";
    } else {
      const model = parseModelFromMetricsJson(run.metricsJson);
      const examples = await prisma.mlShadowTrainingExample.findMany({
        where: { [run.targetLabel]: { not: null } },
        orderBy: { createdAt: "asc" },
        take: 2000,
      });
      const valid = examples.filter(
        (r) => (r[run.targetLabel as keyof typeof r] === true || r[run.targetLabel as keyof typeof r] === false)
      );
      if (model && valid.length >= 20) {
        const toInput = (r: (typeof valid)[0]) => ({
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
          outcomeBlockedVsAllowedVsSubmitted: r.outcomeBlockedVsAllowedVsSubmitted as "blocked" | "allowed" | "submitted" | null,
          momentum1hBps: (r as { momentum1hBps?: string | null }).momentum1hBps,
          momentum6hBps: (r as { momentum6hBps?: string | null }).momentum6hBps,
          volatility1hBps: (r as { volatility1hBps?: string | null }).volatility1hBps,
          volatility6hBps: (r as { volatility6hBps?: string | null }).volatility6hBps,
          distanceFromMid: (r as { distanceFromMid?: string | null }).distanceFromMid,
          timeToCloseHours: (r as { timeToCloseHours?: string | null }).timeToCloseHours,
          liquidityTrend: (r as { liquidityTrend?: string | null }).liquidityTrend,
        });
        const X = valid.map((r) => toShadowFeatureVector(toInput(r)));
        const y = valid.map((r) => (r[run.targetLabel as keyof typeof r] === true ? 1 : 0));
        const probas = predictBatchLogistic(model, X);
        report.calibration = calibrationReport(probas, y, NUM_BUCKETS);
        report.dataAvailable = true;

        report.thresholdSensitivity = THRESHOLDS.map((th) => {
          let tp = 0, fp = 0, tn = 0, fn = 0;
          for (let i = 0; i < probas.length; i++) {
            const pred = (probas[i] ?? 0) >= th ? 1 : 0;
            const actual = y[i] ?? 0;
            if (pred === 1 && actual === 1) tp++;
            else if (pred === 1 && actual === 0) fp++;
            else if (pred === 0 && actual === 0) tn++;
            else fn++;
          }
          const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
          const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
          return { threshold: th, precision, recall, tp, fp, tn, fn };
        });
      } else {
        report.sparseWarning = `Insufficient data (${valid.length} rows) or model parse failed; skipping calibration.`;
      }
    }
  } catch (e) {
    report.sparseWarning = e instanceof Error ? e.message : String(e);
  }

  const jsonPath = path.join(DUMP_DIR, "ml-calibration-threshold-report.json");
  const mdPath = path.join(DUMP_DIR, "ml-calibration-threshold-report.md");
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf-8");
  console.log(`Wrote ${jsonPath}`);

  let md = `# ML Calibration & Threshold Report\n\nGenerated: ${report.generatedAt}\n\n${report.bucketDefinitions}\n\n`;
  if (report.sparseWarning) md += `**Note:** ${report.sparseWarning}\n\n`;
  if (report.calibration) {
    md += "## Calibration (MAE)\n\n";
    md += `MAE: ${report.calibration.mae.toFixed(4)}\n\n`;
    md += "| Bucket | Min | Max | Count | Actual rate |\n|--------|-----|-----|-------|-------------|\n";
    for (const b of report.calibration.buckets) {
      md += `| ${b.bucketIndex} | ${b.minProb.toFixed(2)} | ${b.maxProb.toFixed(2)} | ${b.count} | ${b.actualRate.toFixed(3)} |\n`;
    }
    md += "\n";
  }
  if (report.thresholdSensitivity) {
    md += "## Threshold sensitivity\n\n";
    md += "| Threshold | Precision | Recall | TP | FP | TN | FN |\n|--------|----------|--------|----|----|----|----|\n";
    for (const row of report.thresholdSensitivity) {
      md += `| ${row.threshold} | ${row.precision.toFixed(3)} | ${row.recall.toFixed(3)} | ${row.tp} | ${row.fp} | ${row.tn} | ${row.fn} |\n`;
    }
  }
  fs.writeFileSync(mdPath, md, "utf-8");
  console.log(`Wrote ${mdPath}`);
}

main();
