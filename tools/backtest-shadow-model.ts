/**
 * CLI: offline backtest of shadow model on MlShadowTrainingExample.
 * Loads a trained shadow run, scores historical examples, simulates trades when score >= threshold,
 * uses intendedPrice / markout12h with starting bankroll and fixed fraction per trade.
 *
 * Run: npm run backtest:shadow-model -- [options]
 * Options: --limit, --model-run-id, --from, --to, --source, --slippage-bps, --cost-bps, --bankroll, --size-pct
 *
 * Offline only — no live trading or execution.
 */

import { prisma } from "../lib/db";
import type { LogisticRegressionModel } from "../lib/ml/baseline";
import { SHADOW_MODEL_TYPE } from "../lib/ml/shadow-train";
import { runBacktest, type BacktestRow } from "../lib/ml/backtest";

const DEFAULT_TARGET = "labelGoodDecision12h";
const THRESHOLDS = [0.2, 0.25, 0.3];

function parseDate(s: string): Date {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${s}`);
  return d;
}

/** Expand --key=value to ["--key", "value"] so all flags can be parsed uniformly. */
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

/** Remove first element only if it looks like a script path (no leading -). */
function dropScriptPath(args: string[]): string[] {
  if (args.length > 0 && !args[0].startsWith("-")) return args.slice(1);
  return args;
}

/** Get value for a flag: from next token or from --key=value in same token. */
function flagValue(arg: string, next: string | undefined, flagName: string): string | undefined {
  const prefix = "--" + flagName + "=";
  if (arg.startsWith(prefix)) return arg.slice(prefix.length).trim() || undefined;
  if (arg === "--" + flagName && next !== undefined && !next.startsWith("--")) return next.trim();
  return undefined;
}

/** Parse non-negative int; allows 0. Default only when value is missing or invalid. */
function parseNonNegativeInt(val: string | undefined, defaultVal: number): number {
  if (val === undefined || val === "") return defaultVal;
  const n = parseInt(String(val).trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : defaultVal;
}

/** Parse positive int for limit. */
function parsePositiveInt(val: string | undefined, defaultVal: number): number {
  const n = parseInt(String(val).trim(), 10);
  return Number.isFinite(n) && n >= 1 ? n : defaultVal;
}

/** Parse positive float for bankroll or size-pct. */
function parsePositiveFloat(val: string | undefined, defaultVal: number): number {
  if (val === undefined || val === "") return defaultVal;
  const n = parseFloat(String(val).trim());
  return Number.isFinite(n) && n > 0 ? n : defaultVal;
}

async function main(): Promise<void> {
  const rawArgv = process.argv.slice(2);
  let args = expandArgs(rawArgv);
  args = dropScriptPath(args);

  let limit = 5000;
  let modelRunId: string | null = null;
  let createdAfter: Date | undefined;
  let createdBefore: Date | undefined;
  let candidateSource: string | undefined;
  let slippageBps = 10;
  let costBps = 0;
  let startingBankroll = 10_000;
  let sizePct = 2;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    const limitVal = flagValue(arg, next, "limit") ?? (arg === "--limit" ? next : undefined);
    if (limitVal !== undefined) {
      limit = Math.max(1, parsePositiveInt(limitVal, 5000));
      if (arg === "--limit") i++;
      continue;
    }
    const modelRunIdVal = flagValue(arg, next, "model-run-id") ?? (arg === "--model-run-id" ? next : undefined);
    if (modelRunIdVal !== undefined) {
      modelRunId = modelRunIdVal;
      if (arg === "--model-run-id") i++;
      continue;
    }
    const fromVal = flagValue(arg, next, "from") ?? (arg === "--from" || arg === "-f" ? next : undefined);
    if (fromVal !== undefined) {
      createdAfter = parseDate(fromVal);
      if (arg === "--from" || arg === "-f") i++;
      continue;
    }
    const toVal = flagValue(arg, next, "to") ?? (arg === "--to" || arg === "-t" ? next : undefined);
    if (toVal !== undefined) {
      createdBefore = parseDate(toVal);
      if (arg === "--to" || arg === "-t") i++;
      continue;
    }
    const sourceVal = flagValue(arg, next, "source") ?? (arg === "--source" ? next : undefined);
    if (sourceVal !== undefined) {
      candidateSource = sourceVal;
      if (arg === "--source") i++;
      continue;
    }
    const slippageVal = flagValue(arg, next, "slippage-bps") ?? (arg === "--slippage-bps" ? next : undefined);
    if (slippageVal !== undefined) {
      slippageBps = parseNonNegativeInt(slippageVal, 10);
      if (arg === "--slippage-bps") i++;
      continue;
    }
    const costVal = flagValue(arg, next, "cost-bps") ?? (arg === "--cost-bps" ? next : undefined);
    if (costVal !== undefined) {
      costBps = parseNonNegativeInt(costVal, 0);
      if (arg === "--cost-bps") i++;
      continue;
    }
    const bankrollVal = flagValue(arg, next, "bankroll") ?? (arg === "--bankroll" ? next : undefined);
    if (bankrollVal !== undefined) {
      startingBankroll = parsePositiveFloat(bankrollVal, 10_000);
      if (arg === "--bankroll") i++;
      continue;
    }
    const sizePctVal = flagValue(arg, next, "size-pct") ?? (arg === "--size-pct" ? next : undefined);
    if (sizePctVal !== undefined) {
      const pct = parsePositiveFloat(sizePctVal, 2);
      sizePct = Math.min(100, Math.max(0.01, pct));
      if (arg === "--size-pct") i++;
      continue;
    }
  }

  if (args.length === 0) {
    const e = process.env;
    if (e.BACKTEST_SLIPPAGE_BPS != null && e.BACKTEST_SLIPPAGE_BPS !== "") slippageBps = parseNonNegativeInt(e.BACKTEST_SLIPPAGE_BPS, 10);
    if (e.BACKTEST_COST_BPS != null && e.BACKTEST_COST_BPS !== "") costBps = parseNonNegativeInt(e.BACKTEST_COST_BPS, 0);
    if (e.BACKTEST_LIMIT != null && e.BACKTEST_LIMIT !== "") limit = Math.max(1, parsePositiveInt(e.BACKTEST_LIMIT, 5000));
    if (e.BACKTEST_BANKROLL != null && e.BACKTEST_BANKROLL !== "") startingBankroll = parsePositiveFloat(e.BACKTEST_BANKROLL, 10_000);
    if (e.BACKTEST_SIZE_PCT != null && e.BACKTEST_SIZE_PCT !== "") sizePct = Math.min(100, Math.max(0.01, parsePositiveFloat(e.BACKTEST_SIZE_PCT, 2)));
    if (e.BACKTEST_FROM != null && e.BACKTEST_FROM !== "") createdAfter = parseDate(e.BACKTEST_FROM);
    if (e.BACKTEST_TO != null && e.BACKTEST_TO !== "") createdBefore = parseDate(e.BACKTEST_TO);
    if (e.BACKTEST_SOURCE != null && e.BACKTEST_SOURCE !== "") candidateSource = e.BACKTEST_SOURCE;
  }

  const parsed = {
    limit,
    modelRunId: modelRunId ?? "(latest)",
    from: createdAfter?.toISOString().slice(0, 10) ?? "(none)",
    to: createdBefore?.toISOString().slice(0, 10) ?? "(none)",
    source: candidateSource ?? "(none)",
    slippageBps,
    costBps,
    bankroll: startingBankroll,
    sizePct,
  };
  console.log("argv (after script path):", JSON.stringify(args));
  console.log("parsed:", JSON.stringify(parsed, null, 2));
  if (args.length === 0) {
    console.log("Note: No argv flags received. Use either:");
    console.log("  npx tsx tools/backtest-shadow-model.ts --slippage-bps=15 --cost-bps=5 --limit=100");
    console.log("  npm run backtest:shadow-model -- --slippage-bps=15 --cost-bps=5 --limit=100");
    console.log("");
  }
  console.log("");

  const run = modelRunId
    ? await prisma.mlModelRun.findUnique({ where: { id: modelRunId } })
    : await prisma.mlModelRun.findFirst({
        where: { modelType: SHADOW_MODEL_TYPE, status: "TRAINED" },
        orderBy: { createdAt: "desc" },
      });

  if (!run?.metricsJson) {
    console.error("No shadow model run found. Train first: npm run train:shadow-model -- --target=labelGoodDecision12h");
    process.exit(1);
  }

  const meta = JSON.parse(run.metricsJson) as {
    coefficients?: number[];
    intercept?: number;
    means?: number[];
    stds?: number[];
  };
  const model: LogisticRegressionModel = {
    coefficients: meta.coefficients ?? [],
    intercept: meta.intercept ?? 0,
    means: meta.means ?? [],
    stds: meta.stds ?? [],
  };

  const where: { [k: string]: unknown } = {
    [DEFAULT_TARGET]: { not: null },
    markout12h: { not: null },
  };
  if (createdAfter ?? createdBefore) {
    const createdAt: { gte?: Date; lte?: Date } = {};
    if (createdAfter) createdAt.gte = createdAfter;
    if (createdBefore) createdAt.lte = createdBefore;
    where.createdAt = createdAt;
  }
  if (candidateSource) where.candidateSource = candidateSource;

  const rows = await prisma.mlShadowTrainingExample.findMany({
    where,
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  const backtestRows: BacktestRow[] = rows.map((r) => ({
    intendedPrice: r.intendedPrice,
    intendedSize: r.intendedSize,
    side: r.side,
    markout12h: r.markout12h,
    labelGoodDecision12h: r.labelGoodDecision12h,
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
    recommendationPresent: r.recommendationPresent,
    outcomeBlockedVsAllowedVsSubmitted: r.outcomeBlockedVsAllowedVsSubmitted,
    momentum1hBps: (r as { momentum1hBps?: string | null }).momentum1hBps,
    momentum6hBps: (r as { momentum6hBps?: string | null }).momentum6hBps,
    volatility1hBps: (r as { volatility1hBps?: string | null }).volatility1hBps,
    volatility6hBps: (r as { volatility6hBps?: string | null }).volatility6hBps,
    distanceFromMid: (r as { distanceFromMid?: string | null }).distanceFromMid,
    timeToCloseHours: (r as { timeToCloseHours?: string | null }).timeToCloseHours,
    liquidityTrend: (r as { liquidityTrend?: string | null }).liquidityTrend,
  }));

  const slippageDecimal = slippageBps / 10000;
  const costDecimal = costBps / 10000;
  const sizeFraction = sizePct / 100;
  const options = {
    slippageDecimal,
    fixedCostPerTrade: costDecimal,
    startingBankroll,
    sizeFractionPerTrade: sizeFraction,
  };

  console.log("Shadow model backtest (offline only)");
  console.log("  target:", DEFAULT_TARGET);
  console.log("  modelRunId:", run.id);
  console.log("  rows loaded:", backtestRows.length);
  console.log("  starting bankroll: $", startingBankroll.toLocaleString());
  console.log("  size per trade:", sizePct + "% of bankroll");
  console.log("  slippage:", slippageBps, "bps");
  console.log("  cost per trade:", costBps, "bps");
  if (createdAfter) console.log("  from:", createdAfter.toISOString().slice(0, 10));
  if (createdBefore) console.log("  to:", createdBefore.toISOString().slice(0, 10));
  if (candidateSource) console.log("  source:", candidateSource);
  console.log("");

  for (const th of THRESHOLDS) {
    const result = runBacktest(model, backtestRows, th, options);
    console.log("--- Threshold " + th + " ---");
    console.log("  numTrades:        ", result.numTrades);
    console.log("  winRate:          ", (result.winRate * 100).toFixed(1) + "%");
    console.log("  avg return/trade: ", (result.avgReturnPerTrade * 100).toFixed(4) + "%");
    console.log("  starting bankroll: $", result.startingBankroll.toLocaleString());
    console.log("  ending bankroll:   $", result.endingBankroll.toLocaleString());
    console.log("  total return:     ", (result.totalReturn * 100).toFixed(2) + "%");
    console.log("  max drawdown:     ", (result.maxDrawdown * 100).toFixed(2) + "%");
    console.log("");
  }

  console.log("(Offline simulation only — no live trading or execution.)");
  const cmdParts = [
    "npm run backtest:shadow-model --",
    "--limit=" + limit,
    "--slippage-bps=" + slippageBps,
    "--cost-bps=" + costBps,
    "--bankroll=" + startingBankroll,
    "--size-pct=" + sizePct,
  ];
  if (modelRunId) cmdParts.push("--model-run-id=" + modelRunId);
  if (createdAfter) cmdParts.push("--from=" + createdAfter.toISOString().slice(0, 10));
  if (createdBefore) cmdParts.push("--to=" + createdBefore.toISOString().slice(0, 10));
  if (candidateSource) cmdParts.push("--source=" + candidateSource);
  console.log("Rerun with (reflects parsed values): " + cmdParts.join(" "));
  console.log("");
  console.log("Harsher-friction test (15 bps slippage, 5 bps cost):");
  console.log("  npx tsx tools/backtest-shadow-model.ts --slippage-bps=15 --cost-bps=5 --limit=5000 --bankroll=10000 --size-pct=2");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
