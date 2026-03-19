/**
 * CLI: train shadow ML model on MlShadowTrainingExample (e.g. offline historical data).
 * Uses existing pipeline: load rows, toShadowFeatureVector, logistic regression, persist to MlModelRun.
 * Run from project root: npm run train:shadow-model [--limit=2000] [--save [path]]
 * Supports both --key value and --key=value.
 */

import { prisma } from "../lib/db";
import { trainShadowModel } from "../lib/ml/shadow-train";
import type { ShadowTargetLabel } from "../lib/ml/shadow-train";
import * as fs from "fs";
import * as path from "path";

/** Expand --key=value to ["--key", "value"]. */
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

function parseDate(s: string): Date {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${s}`);
  return d;
}

async function main(): Promise<void> {
  const rawArgv = process.argv.slice(2);
  let args = expandArgs(rawArgv);
  args = dropScriptPath(args);

  let limit = 2000;
  let trainRatio = 0.8;
  let targetLabel: ShadowTargetLabel = "labelGoodDecision";
  let funderAddress: string | undefined;
  let candidateSource: string | undefined;
  let createdAfter: Date | undefined;
  let createdBefore: Date | undefined;
  let savePath: string | null = null;
  let debug = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--debug") {
      debug = true;
    } else if (args[i] === "--limit" && args[i + 1]) {
      limit = Math.max(10, parseInt(args[++i], 10) || 2000);
    } else if (args[i] === "--train-ratio" && args[i + 1]) {
      trainRatio = Math.max(0.1, Math.min(0.99, parseFloat(args[++i]) || 0.8));
    } else if (args[i] === "--target" && args[i + 1]) {
      const t = args[++i];
      if (t === "labelMissedOpportunity" || t === "labelGoodDecision6h" || t === "labelGoodDecision12h") targetLabel = t;
      else targetLabel = "labelGoodDecision";
    } else if (args[i] === "--funder" && args[i + 1]) {
      funderAddress = args[++i];
    } else if (args[i] === "--source" && args[i + 1]) {
      candidateSource = args[++i];
    } else if (args[i] === "--from" && args[i + 1]) {
      createdAfter = parseDate(args[++i]);
    } else if (args[i] === "--to" && args[i + 1]) {
      createdBefore = parseDate(args[++i]);
    } else if (args[i] === "--save") {
      savePath = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : "shadow-model.json";
    }
  }

  console.log("Shadow model training (MlShadowTrainingExample -> logistic regression)");
  console.log("  [argv]", JSON.stringify(rawArgv));
  console.log("  targetLabel:", targetLabel);
  console.log("  limit:", limit);
  console.log("  trainRatio:", trainRatio);
  if (funderAddress) console.log("  funderAddress:", funderAddress);
  if (candidateSource) console.log("  candidateSource:", candidateSource);
  if (createdAfter) console.log("  createdAfter:", createdAfter.toISOString());
  if (createdBefore) console.log("  createdBefore:", createdBefore.toISOString());
  if (savePath) console.log("  save model to:", path.resolve(savePath));

  const result = await trainShadowModel(targetLabel, {
    funderAddress,
    candidateSource,
    limit,
    createdAfter,
    createdBefore,
    trainRatio,
    debug,
  });

  if (!result.success) {
    console.error("Training failed:", result.error);
    process.exit(1);
  }

  console.log("");
  console.log("--- Result ---");
  console.log("  modelRunId:", result.modelRunId);
  console.log("  datasetSize:", result.datasetSize);
  console.log("  trainCount:", result.trainCount);
  console.log("  validationCount:", result.validationCount);
  console.log("  trainedFrom:", result.trainedFrom ?? "—");
  console.log("  trainedTo:", result.trainedTo ?? "—");
  if (result.metrics) {
    console.log("");
    console.log("--- Metrics (validation) ---");
    console.log("  accuracy: ", result.metrics.accuracy.toFixed(4));
    console.log("  precision:", result.metrics.precision.toFixed(4));
    console.log("  recall:   ", result.metrics.recall.toFixed(4));
    console.log("  f1:       ", result.metrics.f1.toFixed(4));
    console.log("  rocAuc:   ", result.metrics.rocAuc.toFixed(4));
  }
  if (result.featureImportance && result.featureImportance.length > 0) {
    console.log("");
    console.log("--- Top feature importance (|coefficient|) ---");
    const top = result.featureImportance
      .slice()
      .sort((a, b) => b.absCoefficient - a.absCoefficient)
      .slice(0, 10);
    top.forEach((f) => console.log("  ", f.name, f.absCoefficient.toFixed(4)));
  }

  if (savePath && result.modelRunId) {
    const run = await prisma.mlModelRun.findUnique({
      where: { id: result.modelRunId },
      select: { metricsJson: true, targetLabel: true, trainedFrom: true, trainedTo: true },
    });
    if (run?.metricsJson) {
      const artifact = {
        modelRunId: result.modelRunId,
        targetLabel: run.targetLabel,
        trainedFrom: run.trainedFrom?.toISOString() ?? null,
        trainedTo: run.trainedTo?.toISOString() ?? null,
        exportedAt: new Date().toISOString(),
        ...JSON.parse(run.metricsJson),
      };
      fs.writeFileSync(savePath, JSON.stringify(artifact, null, 2), "utf-8");
      console.log("");
      console.log("Model saved to", path.resolve(savePath));
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
