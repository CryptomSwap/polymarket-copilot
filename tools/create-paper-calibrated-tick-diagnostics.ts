/**
 * Diagnostics for raw vs logit-temperature (calibrated) admission scores on the latest
 * persisted paper open tick. Writes JSON to stdout.
 *
 * Run: npx tsx tools/create-paper-calibrated-tick-diagnostics.ts
 *      npm run dump:paper-calibrated-tick-diagnostics > dump/paper-calibrated-tick-diagnostics.json
 *
 * Note: There is no `PaperTradingTick` Prisma model — only `PaperTradingState` (single row)
 * stores `lastOpenTickResultJson`. Historical ticks are not retained; `lookbackTicksRequested`
 * documents intent; `ticksReturned` is 0 or 1. Per-candidate rows come from
 * `decisionTraceBundle.traces` (bounded, may be fewer than `candidatesScored`).
 */

import "dotenv/config";
import { prisma } from "../lib/db";
import { getPaperTradingConfig } from "../lib/paper-trading/config";
import { applyPaperShadowLogitTemperature } from "../lib/paper-trading/paper-shadow-logit-calibration";
import type { PaperDecisionTraceBundle } from "../lib/paper-trading/decision-trace-types";

const LOOKBACK_TICKS_REQUESTED = 50;

function mean(nums: number[]): number | null {
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

async function main(): Promise<void> {
  const cfg = getPaperTradingConfig();
  const T = cfg.paperShadowLogitTemperature;

  let state: Awaited<ReturnType<typeof prisma.paperTradingState.findUnique>>;
  try {
    state = await prisma.paperTradingState.findUnique({ where: { id: "default" } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("[create-paper-calibrated-tick-diagnostics] DB unavailable:", msg);
    console.log(
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          dataSource: {
            error: msg.slice(0, 500),
            lookbackTicksRequested: LOOKBACK_TICKS_REQUESTED,
            ticksReturned: 0,
          },
          configEcho: {
            paperShadowLogitTemperature: T,
            paperShadowUseCalibratedScoreForPaper: cfg.paperShadowUseCalibratedScoreForPaper,
            paperMinScoreOverrideGlobal: cfg.paperMinScoreOverrideGlobal,
            paperMaxSpreadBps: cfg.paperMaxSpreadBps,
            paperMaxEstimatedSlippageBps: cfg.paperMaxEstimatedSlippageBps,
          },
          ticks: [],
          sanityHints: { note: "Regenerate when DATABASE_URL reaches Postgres (e.g. docker compose up)." },
        },
        null,
        2
      )
    );
    return;
  }

  const dataSource = {
    persistedOpenTickRows:
      "Prisma has no PaperTradingTick model. Latest open tick only: PaperTradingState.lastOpenTickResultJson (id=default).",
    lookbackTicksRequested: LOOKBACK_TICKS_REQUESTED,
    ticksReturned: 0 as number,
    tracesCappedNote:
      "decisionTraceBundle.traces is bounded (see MAX_DECISION_TRACES_STORED in decision-trace-types.ts); trace-based averages may omit tail candidates.",
  };

  const configEcho = {
    paperShadowLogitTemperature: T,
    paperShadowUseCalibratedScoreForPaper: cfg.paperShadowUseCalibratedScoreForPaper,
    paperMinScoreOverrideGlobal: cfg.paperMinScoreOverrideGlobal,
    paperMaxSpreadBps: cfg.paperMaxSpreadBps,
    paperMaxEstimatedSlippageBps: cfg.paperMaxEstimatedSlippageBps,
  };

  if (!state?.lastOpenTickResultJson) {
    const output = {
      generatedAt: new Date().toISOString(),
      dataSource,
      configEcho,
      lastOpenTickAt: state?.lastOpenTickAt ?? null,
      lastOpenTickError: state?.lastOpenTickError ?? null,
      ticks: [] as unknown[],
      sanityHints: {
        selectivity:
          "No persisted tick JSON — run a paper tick first (POST /api/paper-trading/tick).",
        tradeDensity: "—",
        calibration: "—",
        guardrails: "—",
      },
    };
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  let tickJson: Record<string, unknown>;
  try {
    tickJson = JSON.parse(state.lastOpenTickResultJson) as Record<string, unknown>;
  } catch {
    const output = {
      generatedAt: new Date().toISOString(),
      dataSource: { ...dataSource, ticksReturned: 0 },
      configEcho,
      lastOpenTickAt: state.lastOpenTickAt?.toISOString() ?? null,
      parseError: "lastOpenTickResultJson is not valid JSON",
      ticks: [],
    };
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  const candidatesScored = typeof tickJson.candidatesScored === "number" ? tickJson.candidatesScored : 0;
  const aboveThresholdCount =
    typeof tickJson.aboveThresholdCount === "number" ? tickJson.aboveThresholdCount : 0;
  const opened = typeof tickJson.opened === "number" ? tickJson.opened : 0;
  const skipped = typeof tickJson.skipped === "number" ? tickJson.skipped : 0;
  const avgAdmissionFromTick = typeof tickJson.avgScore === "number" ? tickJson.avgScore : null;

  const bundleRaw = tickJson.decisionTraceBundle;
  const bundle = bundleRaw as PaperDecisionTraceBundle | undefined;
  const traces = Array.isArray(bundle?.traces) ? bundle!.traces : [];

  const raws: number[] = [];
  const calibratedFromRaw: number[] = [];
  for (const t of traces) {
    const r = t.championScore;
    if (r != null && Number.isFinite(r)) {
      raws.push(r);
      calibratedFromRaw.push(applyPaperShadowLogitTemperature(r, T));
    }
  }

  const spreadFiltered = traces.filter((t) => t.rejectReasonCode === "spread_guard").length;
  const slippageFiltered = traces.filter((t) => t.rejectReasonCode === "slippage_guard").length;

  const passedByTrace = traces.filter((t) => t.thresholdEligible === true).length;
  const totalTrace = traces.length;

  let aggSpread = 0;
  let aggSlip = 0;
  for (const a of bundle?.perBotAggregates ?? []) {
    aggSpread += a.rejectedBySpreadGuard ?? 0;
    aggSlip += a.rejectedBySlippageGuard ?? 0;
  }

  const passRateOfficial = candidatesScored > 0 ? aboveThresholdCount / candidatesScored : 0;
  const passRateTraces = totalTrace > 0 ? passedByTrace / totalTrace : null;

  const avgRawScore = mean(raws);
  const avgCalibratedFromTraceRaw = mean(calibratedFromRaw);
  const avgCalibratedScore = avgAdmissionFromTick ?? avgCalibratedFromTraceRaw;

  const tickId = `default:${state.lastOpenTickAt?.toISOString() ?? "unknown"}`;
  const tickRow = {
    tickId,
    createdAt: state.lastOpenTickAt?.toISOString() ?? null,
    totalCandidates: candidatesScored,
    /** From tick result: count with admission score >= effective min (same as engine aboveThresholdCount). */
    passedScoreThreshold: aboveThresholdCount,
    passRate: passRateOfficial,
    tradesOpened: opened,
    skipped,
    avgRawScore,
    /** Mean admission score on all scored candidates (engine); preferred over trace-only mean. */
    avgCalibratedScore,
    avgCalibratedRecomputedFromTraceChampion: avgCalibratedFromTraceRaw,
    spreadGuardRejectionsInTraces: spreadFiltered,
    slippageGuardRejectionsInTraces: slippageFiltered,
    spreadGuardRejectionsPerBotAggregates: aggSpread,
    slippageGuardRejectionsPerBotAggregates: aggSlip,
    traceCount: totalTrace,
    passRateFromTracesThresholdEligible: passRateTraces,
    rejectedBySpreadGuardCountTick:
      typeof tickJson.rejectedBySpreadGuardCount === "number" ? tickJson.rejectedBySpreadGuardCount : null,
    rejectedBySlippageGuardCountTick:
      typeof tickJson.rejectedBySlippageGuardCount === "number" ? tickJson.rejectedBySlippageGuardCount : null,
  };

  dataSource.ticksReturned = 1;

  const passRate = passRateOfficial;
  const sanityHints = {
    selectivity: {
      passRate,
      targetBandPct: [5, 30] as const,
      inTargetBand: passRate > 0 && passRate < 1 && passRate >= 0.05 && passRate <= 0.3,
      note:
        passRate >= 0.99
          ? "passRate ~100% → threshold not selective or saturated scores (check calibration / override)."
          : passRate === 0
            ? "passRate 0% → threshold may be too tight vs current calibrated distribution."
            : "Review passRate vs target 5–30% (operator judgment).",
    },
    tradeDensity: {
      tradesOpened: opened,
      totalCandidates: candidatesScored,
      openedOverCandidates: candidatesScored > 0 ? opened / candidatesScored : null,
      note:
        candidatesScored > 0 && opened >= candidatesScored
          ? "opened equals or exceeds all scored candidates — threshold unlikely binding (unexpected)."
          : "opened should be much lower than totalCandidates when selective.",
    },
    calibration: {
      avgRawScore,
      avgCalibratedScore,
      note:
        avgRawScore != null && avgRawScore > 0.99 && avgCalibratedScore != null && avgCalibratedScore < 0.95
          ? "Raw ~1.0 with lower mean admission score suggests temperature/calibrated path is spreading scores."
          : "Compare avgRawScore (from trace championScore) to avgCalibratedScore (tick avgScore / recomputed).",
    },
    guardrails: {
      spreadRejections_traces: spreadFiltered,
      slippageRejections_traces: slippageFiltered,
      spreadRejections_aggregates: aggSpread,
      slippageRejections_aggregates: aggSlip,
      note:
        spreadFiltered === 0 && slippageFiltered === 0 && aggSpread === 0 && aggSlip === 0
          ? "No spread/slippage rejections this tick — guards loose, not hit, or all candidates failed score first."
          : "Non-zero spread/slippage rejections observed.",
    },
  };

  const output = {
    generatedAt: new Date().toISOString(),
    dataSource,
    configEcho,
    lastOpenTickError: state.lastOpenTickError,
    ticks: [tickRow],
    sanityHints,
  };

  console.log(JSON.stringify(output, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
