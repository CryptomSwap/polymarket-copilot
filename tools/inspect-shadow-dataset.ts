/**
 * CLI: inspect MlShadowTrainingExample dataset (counts, label balance, date range, per-feature variance).
 * Run: npm run inspect:shadow-dataset [--limit=5000] [--funder=offline] [--source=offline_historical] [--from=YYYY-MM-DD] [--to=YYYY-MM-DD]
 */

import { prisma } from "../lib/db";
import { toShadowFeatureVector } from "../lib/ml/shadow-train/features";
import { SHADOW_FEATURE_NAMES } from "../lib/ml/shadow-train/features";

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

async function main(): Promise<void> {
  let args = expandArgs(process.argv.slice(2));
  args = dropScriptPath(args);
  let limit = 10_000;
  let funder: string | undefined;
  let source: string | undefined;
  let createdAfter: Date | undefined;
  let createdBefore: Date | undefined;
  let debug = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--limit" && args[i + 1]) {
      limit = Math.max(1, parseInt(args[++i], 10) || 10_000);
    } else if ((args[i] === "--from" || args[i] === "-f") && args[i + 1]) {
      createdAfter = parseDate(args[++i]);
    } else if ((args[i] === "--to" || args[i] === "-t") && args[i + 1]) {
      createdBefore = parseDate(args[++i]);
    } else if (args[i] === "--funder" && args[i + 1]) {
      funder = args[++i];
    } else if (args[i] === "--source" && args[i + 1]) {
      source = args[++i];
    } else if (args[i] === "--debug") {
      debug = true;
    }
  }

  const where: { funderAddress?: string; candidateSource?: string; createdAt?: { gte?: Date; lte?: Date } } = {};
  if (funder) where.funderAddress = funder;
  if (source) where.candidateSource = source;
  if (createdAfter ?? createdBefore) {
    where.createdAt = {};
    if (createdAfter) where.createdAt.gte = createdAfter;
    if (createdBefore) where.createdAt.lte = createdBefore;
  }

  const rows = await prisma.mlShadowTrainingExample.findMany({
    where,
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  const total = rows.length;
  const withLabel = rows.filter((r) => r.labelGoodDecision === true || r.labelGoodDecision === false);
  const positive = withLabel.filter((r) => r.labelGoodDecision === true).length;
  const negative = withLabel.filter((r) => r.labelGoodDecision === false).length;
  const positiveRate = withLabel.length > 0 ? positive / withLabel.length : 0;

  const funders = new Set(rows.map((r) => r.funderAddress));
  const minCreated = rows.length > 0 ? new Date(Math.min(...rows.map((r) => r.createdAt.getTime()))) : null;
  const maxCreated = rows.length > 0 ? new Date(Math.max(...rows.map((r) => r.createdAt.getTime()))) : null;

  console.log("MlShadowTrainingExample dataset inspection");
  console.log("  limit:", limit);
  if (funder) console.log("  funder filter:", funder);
  if (source) console.log("  candidateSource filter:", source);
  if (createdAfter) console.log("  createdAfter (--from):", createdAfter.toISOString());
  if (createdBefore) console.log("  createdBefore (--to):", createdBefore.toISOString());
  console.log("");
  console.log("--- Counts ---");
  console.log("  total rows:", total);
  console.log("  with labelGoodDecision:", withLabel.length);
  console.log("  positive (good decision):", positive);
  console.log("  negative (bad decision):", negative);
  console.log("  positive rate:", (positiveRate * 100).toFixed(1) + "%");
  console.log("");
  console.log("--- Date range ---");
  console.log("  min createdAt:", minCreated?.toISOString() ?? "—");
  console.log("  max createdAt:", maxCreated?.toISOString() ?? "—");
  console.log("");
  console.log("--- Distinct funderAddress ---");
  console.log("  count:", funders.size);
  console.log("  values:", Array.from(funders).slice(0, 10).join(", ") + (funders.size > 10 ? " ..." : ""));

  if (rows.length === 0) {
    console.log("");
    console.log("No rows; skipping feature stats.");
    return;
  }

  type RowWithFeatures = (typeof rows)[0] & {
    momentum1hBps?: string | null;
    momentum6hBps?: string | null;
    volatility1hBps?: string | null;
    volatility6hBps?: string | null;
    distanceFromMid?: string | null;
    timeToCloseHours?: string | null;
    liquidityTrend?: string | null;
  };
  const toInput = (r: RowWithFeatures) => ({
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
    momentum1hBps: r.momentum1hBps,
    momentum6hBps: r.momentum6hBps,
    volatility1hBps: r.volatility1hBps,
    volatility6hBps: r.volatility6hBps,
    distanceFromMid: r.distanceFromMid,
    timeToCloseHours: r.timeToCloseHours,
    liquidityTrend: r.liquidityTrend,
  });

  const vectors = rows.map((r) => toShadowFeatureVector(toInput(r as RowWithFeatures)));
  const d = SHADOW_FEATURE_NAMES.length;

  if (debug && vectors.length > 0) {
    console.log("");
    console.log("--- Debug: feature names and first 3 vectors (same order as toShadowFeatureVector) ---");
    console.log("  featureNames:", SHADOW_FEATURE_NAMES.join(", "));
    vectors.slice(0, 3).forEach((vec, idx) => {
      console.log(`  vector ${idx + 1}:`, JSON.stringify(vec));
    });
    console.log("");
  }

  const nonDefaultCount: number[] = new Array(d).fill(0);
  const sum: number[] = new Array(d).fill(0);
  const sumSq: number[] = new Array(d).fill(0);

  for (const v of vectors) {
    for (let j = 0; j < d; j++) {
      const x = v[j] ?? 0;
      if (x !== 0) nonDefaultCount[j]++;
      sum[j] += x;
      sumSq[j] += x * x;
    }
  }

  const n = vectors.length;
  const variance: number[] = new Array(d).fill(0);
  for (let j = 0; j < d; j++) {
    const mean = sum[j] / n;
    variance[j] = n > 1 ? sumSq[j] / n - mean * mean : 0;
    if (variance[j] < 0) variance[j] = 0;
  }

  console.log("");
  console.log("--- Per-feature (training vector) ---");
  console.log("  (non-default = value !== 0; variance = Var across rows)");
  console.log("");
  for (let j = 0; j < d; j++) {
    const name = SHADOW_FEATURE_NAMES[j];
    const nd = nonDefaultCount[j];
    const v = variance[j];
    const pct = n > 0 ? ((nd / n) * 100).toFixed(1) : "0";
    console.log(`  ${name}: non-default ${nd}/${n} (${pct}%), variance ${v.toFixed(6)}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
