/**
 * CLI: evaluate a trained shadow model at multiple thresholds.
 * Loads latest shadow model run (or by --model-run-id), fetches MlShadowTrainingExample rows,
 * computes predictions, then prints metrics + confusion matrix at 0.1, 0.2, 0.3, 0.4, 0.5
 * and score distributions for positive vs negative labels.
 *
 * Run: npm run evaluate:shadow-model [--limit=2000] [--target=labelGoodDecision] [--model-run-id=...] [--from=YYYY-MM-DD] [--to=YYYY-MM-DD] [--source=offline_historical]
 */

import { prisma } from "../lib/db";
import { predictBatchLogistic } from "../lib/ml/baseline";
import { toShadowFeatureVector } from "../lib/ml/shadow-train/features";
import type { ShadowTargetLabel } from "../lib/ml/shadow-train";
import { SHADOW_MODEL_TYPE } from "../lib/ml/shadow-train";

const THRESHOLDS = [0.1, 0.2, 0.3, 0.4, 0.5];

function parseDate(s: string): Date {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${s}`);
  return d;
}

function expandArgs(argv: string[]): string[] {
  const out: string[] = [];
  for (const a of argv) {
    if (a.startsWith("--") && a.includes("=")) {
      const eq = a.indexOf("=");
      out.push(a.slice(0, eq), a.slice(eq + 1));
    } else {
      out.push(a);
    }
  }
  return out;
}

function dropScriptPath(args: string[]): string[] {
  if (args.length > 0 && !args[0].startsWith("-")) return args.slice(1);
  return args;
}

function confusionMatrix(tp: number, fp: number, tn: number, fn: number): string {
  return [
    `           pred=0   pred=1`,
    `actual=0   ${String(tn).padStart(5)}   ${String(fp).padStart(5)}`,
    `actual=1   ${String(fn).padStart(5)}   ${String(tp).padStart(5)}`,
  ].join("\n");
}

function metricsAtThreshold(probas: number[], y: number[], thresh: number): { tp: number; fp: number; tn: number; fn: number; precision: number; recall: number; f1: number; accuracy: number } {
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (let i = 0; i < probas.length; i++) {
    const pred = (probas[i] ?? 0) >= thresh ? 1 : 0;
    const actual = y[i] ?? 0;
    if (pred === 1 && actual === 1) tp++;
    else if (pred === 1 && actual === 0) fp++;
    else if (pred === 0 && actual === 0) tn++;
    else fn++;
  }
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  const accuracy = (tp + tn) / (tp + tn + fp + fn) || 0;
  return { tp, fp, tn, fn, precision, recall, f1, accuracy };
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx] ?? 0;
}

async function main(): Promise<void> {
  const rawArgv = process.argv.slice(2);
  let args = expandArgs(rawArgv);
  args = dropScriptPath(args);

  let limit = 2000;
  let targetLabel: ShadowTargetLabel = "labelGoodDecision";
  let modelRunId: string | null = null;
  let createdAfter: Date | undefined;
  let createdBefore: Date | undefined;
  let candidateSource: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--limit" && args[i + 1]) {
      limit = Math.max(100, parseInt(args[++i], 10) || 2000);
    } else if (args[i] === "--target" && args[i + 1]) {
      const t = args[++i];
      targetLabel = (t === "labelMissedOpportunity" || t === "labelGoodDecision6h" || t === "labelGoodDecision12h") ? t : "labelGoodDecision";
    } else if (args[i] === "--model-run-id" && args[i + 1]) {
      modelRunId = args[++i];
    } else if ((args[i] === "--from" || args[i] === "-f") && args[i + 1]) {
      createdAfter = parseDate(args[++i]);
    } else if ((args[i] === "--to" || args[i] === "-t") && args[i + 1]) {
      createdBefore = parseDate(args[++i]);
    } else if (args[i] === "--source" && args[i + 1]) {
      candidateSource = args[++i];
    }
  }

  const run = modelRunId
    ? await prisma.mlModelRun.findUnique({ where: { id: modelRunId } })
    : await prisma.mlModelRun.findFirst({
        where: { modelType: SHADOW_MODEL_TYPE, status: "TRAINED" },
        orderBy: { createdAt: "desc" },
      });

  if (!run?.metricsJson) {
    console.error("No shadow model run found. Train first: npm run train:shadow-model");
    process.exit(1);
  }

  const meta = JSON.parse(run.metricsJson) as {
    coefficients?: number[];
    intercept?: number;
    means?: number[];
    stds?: number[];
  };
  const model = {
    coefficients: meta.coefficients ?? [],
    intercept: meta.intercept ?? 0,
    means: meta.means ?? [],
    stds: meta.stds ?? [],
  };

  const where: { [k: string]: unknown } = { [targetLabel]: { not: null } };
  if (createdAfter ?? createdBefore) {
    const createdAt: { gte?: Date; lte?: Date } = {};
    if (createdAfter) createdAt.gte = createdAfter;
    if (createdBefore) createdAt.lte = createdBefore;
    where.createdAt = createdAt;
  }
  if (candidateSource) where.candidateSource = candidateSource;

  const rows = await prisma.mlShadowTrainingExample.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  const valid = rows.filter((r) => r[targetLabel] === true || r[targetLabel] === false);
  if (valid.length < 20) {
    console.error(`Too few rows with ${targetLabel} (${valid.length}). Need at least 20.`);
    process.exit(1);
  }

  const toInput = (r: (typeof valid)[0]) => {
    const ex = r as { momentum1hBps?: string | null; momentum6hBps?: string | null; volatility1hBps?: string | null; volatility6hBps?: string | null; distanceFromMid?: string | null; timeToCloseHours?: string | null; liquidityTrend?: string | null };
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
      outcomeBlockedVsAllowedVsSubmitted: r.outcomeBlockedVsAllowedVsSubmitted as "blocked" | "allowed" | "submitted" | null,
      momentum1hBps: ex.momentum1hBps,
      momentum6hBps: ex.momentum6hBps,
      volatility1hBps: ex.volatility1hBps,
      volatility6hBps: ex.volatility6hBps,
      distanceFromMid: ex.distanceFromMid,
      timeToCloseHours: ex.timeToCloseHours,
      liquidityTrend: ex.liquidityTrend,
    };
  };

  const X = valid.map((r) => toShadowFeatureVector(toInput(r)));
  const y = valid.map((r) => (r[targetLabel] === true ? 1 : 0));
  const probas = predictBatchLogistic(model, X);

  console.log("Shadow model evaluation");
  console.log("  [argv]", JSON.stringify(rawArgv));
  console.log("  modelRunId:", run.id);
  console.log("  targetLabel:", targetLabel);
  if (createdAfter) console.log("  createdAfter (--from):", createdAfter.toISOString());
  if (createdBefore) console.log("  createdBefore (--to):", createdBefore.toISOString());
  if (candidateSource) console.log("  candidateSource:", candidateSource);
  console.log("  n rows:", valid.length);
  console.log("  positive rate:", (y.filter((v) => v === 1).length / y.length * 100).toFixed(1) + "%");
  console.log("");

  const posScores = probas.filter((_, i) => y[i] === 1);
  const negScores = probas.filter((_, i) => y[i] === 0);
  console.log("--- Score distribution (predicted probability) ---");
  console.log("  Positive label (actual=1): n=" + posScores.length);
  console.log("    min=" + (Math.min(...posScores).toFixed(4)) + " max=" + (Math.max(...posScores).toFixed(4)) + " mean=" + (posScores.reduce((a, b) => a + b, 0) / posScores.length).toFixed(4));
  console.log("    p10=" + percentile(posScores, 10).toFixed(4) + " p50=" + percentile(posScores, 50).toFixed(4) + " p90=" + percentile(posScores, 90).toFixed(4));
  console.log("  Negative label (actual=0): n=" + negScores.length);
  console.log("    min=" + (Math.min(...negScores).toFixed(4)) + " max=" + (Math.max(...negScores).toFixed(4)) + " mean=" + (negScores.reduce((a, b) => a + b, 0) / negScores.length).toFixed(4));
  console.log("    p10=" + percentile(negScores, 10).toFixed(4) + " p50=" + percentile(negScores, 50).toFixed(4) + " p90=" + percentile(negScores, 90).toFixed(4));
  console.log("");

  for (const th of THRESHOLDS) {
    const m = metricsAtThreshold(probas, y, th);
    console.log(`--- Threshold ${th} ---`);
    console.log(confusionMatrix(m.tp, m.fp, m.tn, m.fn));
    console.log(`  precision=${m.precision.toFixed(4)} recall=${m.recall.toFixed(4)} f1=${m.f1.toFixed(4)} accuracy=${m.accuracy.toFixed(4)}`);
    console.log("");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
