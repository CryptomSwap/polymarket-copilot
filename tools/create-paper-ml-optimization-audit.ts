/**
 * Condensed paper trading + ML optimization audit (read-only).
 * Writes dump/paper-ml-optimization-audit.{json,md}
 *
 * Run: npx tsx tools/create-paper-ml-optimization-audit.ts
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import { getPerBotAnalytics, getBotOverlapReport } from "../lib/paper-trading/analytics";
import { getPaperTradingConfig, getPaperTradingMaxHoldHours } from "../lib/paper-trading/config";
import { getEffectiveBotProfiles } from "../lib/paper-trading/bot-profiles";
import { parseOpenAttributionFromMetadataJson } from "../lib/paper-trading/paper-trade-open-attribution";
import { normalizeCloseTickResult } from "../lib/paper-trading/normalize-close-tick-result";
import type { PaperDecisionTraceBundle, PaperDecisionTraceEntry } from "../lib/paper-trading/decision-trace-types";
import { parseHeartbeatMetadataJson } from "../lib/ops/worker-heartbeat-canonical";

const DUMP = path.join(process.cwd(), "dump");
const JSON_PATH = path.join(DUMP, "paper-ml-optimization-audit.json");
const MD_PATH = path.join(DUMP, "paper-ml-optimization-audit.md");
const WORKER_NAME = "polymarket-copilot-worker";

const MS_D7 = 7 * 24 * 60 * 60 * 1000;
const MS_D30 = 30 * 24 * 60 * 60 * 1000;
const CLOSED_FOR_BANDS_LIMIT = 12_000;

const SCORE_BAND_LABELS = [
  "<0.75",
  "0.75-0.80",
  "0.80-0.85",
  "0.85-0.90",
  "0.90-0.95",
  "0.95+",
] as const;

function scoreToBand(s: number): (typeof SCORE_BAND_LABELS)[number] {
  if (s < 0.75) return "<0.75";
  if (s < 0.8) return "0.75-0.80";
  if (s < 0.85) return "0.80-0.85";
  if (s < 0.9) return "0.85-0.90";
  if (s < 0.95) return "0.90-0.95";
  return "0.95+";
}

function mean(nums: number[]): number | null {
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function medianSorted(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function parsePnl(p: string | null | undefined): number | null {
  if (p == null || p === "") return null;
  const n = parseFloat(p);
  return Number.isFinite(n) ? n : null;
}

function parseCloseReasonCode(metadataJson: string | null | undefined): string {
  if (!metadataJson) return "unknown";
  try {
    const o = JSON.parse(metadataJson) as Record<string, unknown>;
    const pc = o.paperClose as Record<string, unknown> | undefined;
    const c = pc?.closeReasonCode;
    return typeof c === "string" && c.length > 0 ? c : "unknown";
  } catch {
    return "unknown";
  }
}

function admissionScalarsFromTrade(metadataJson: string | null | undefined, rowScore: number) {
  const attr = parseOpenAttributionFromMetadataJson(metadataJson);
  const cal = attr?.paperShadowScoreCalibration;
  return {
    /** Score that gates admission when calibration metadata exists; else openAttribution.score; else DB column. */
    admissionForBand: cal?.admissionScore ?? attr?.score ?? rowScore,
    raw: cal?.shadowMlScoreRaw ?? attr?.score ?? rowScore,
    calibrated: cal?.shadowMlScoreCalibrated ?? null,
    usedCalibratedForAdmission: cal?.usedCalibratedForAdmission ?? null,
  };
}

interface ClosedRow {
  botType: string;
  score: number;
  pnlPct: string | null;
  entryTime: Date;
  exitTime: Date | null;
  metadataJson: string | null;
}

function aggregateClosedStats(rows: ClosedRow[]) {
  const pnls = rows.map((r) => parsePnl(r.pnlPct)).filter((n): n is number => n !== null);
  const holds = rows
    .filter((r) => r.exitTime)
    .map((r) => (r.exitTime!.getTime() - r.entryTime.getTime()) / (60 * 60 * 1000));
  const sorted = [...pnls].sort((a, b) => a - b);
  const wins = pnls.filter((p) => p > 0).length;
  return {
    tradeCount: rows.length,
    withPnl: pnls.length,
    winRate: pnls.length ? wins / pnls.length : null,
    avgPnlPct: mean(pnls),
    medianPnlPct: medianSorted(sorted),
    avgHoldHours: mean(holds),
  };
}

function bandStatsFromClosed(rows: ClosedRow[], scorePicker: (r: ClosedRow) => number | null) {
  const byBand: Record<string, ClosedRow[]> = {};
  for (const b of SCORE_BAND_LABELS) byBand[b] = [];
  for (const r of rows) {
    const s = scorePicker(r);
    if (s == null || !Number.isFinite(s)) continue;
    byBand[scoreToBand(s)]!.push(r);
  }
  const out: Record<
    string,
    ReturnType<typeof aggregateClosedStats> & { exitReasonCounts: Record<string, number> }
  > = {};
  for (const b of SCORE_BAND_LABELS) {
    const subset = byBand[b] ?? [];
    const base = aggregateClosedStats(subset);
    const exitReasonCounts: Record<string, number> = {};
    for (const t of subset) {
      const code = parseCloseReasonCode(t.metadataJson);
      exitReasonCounts[code] = (exitReasonCounts[code] ?? 0) + 1;
    }
    out[b] = { ...base, exitReasonCounts };
  }
  return out;
}

function monotonicityScore(bandAvgs: { band: string; avg: number | null; n: number }[]): string {
  const usable = bandAvgs.filter((x) => x.n >= 5 && x.avg != null) as { band: string; avg: number; n: number }[];
  if (usable.length < 3) return "insufficient_per_band_samples";
  let inv = 0;
  for (let i = 1; i < usable.length; i++) {
    if (usable[i]!.avg < usable[i - 1]!.avg - 1e-6) inv++;
  }
  if (inv === 0) return "non_decreasing_across_bands";
  if (inv <= 1) return "mostly_non_decreasing_one_inversion";
  return "non_monotonic_or_noisy";
}

async function main(): Promise<void> {
  await fs.mkdir(DUMP, { recursive: true });
  const generatedAt = new Date().toISOString();
  const now = Date.now();
  const since7 = new Date(now - MS_D7);
  const since30 = new Date(now - MS_D30);

  let dbOk = false;
  let dbError: string | null = null;
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbOk = true;
  } catch (e) {
    dbError = e instanceof Error ? e.message : String(e);
  }

  if (!dbOk) {
    const partial = {
      generatedAt,
      dbReachable: false,
      dbError,
      section1_executiveSummary: {
        systemHealth: "Database unreachable — audit incomplete.",
        dominantBlockers: [],
        paperPerformanceSnapshot: null,
        mlEconomicallyUseful: "unknown",
        top3OptimizationOpportunities: [],
      },
    };
    await fs.writeFile(JSON_PATH, JSON.stringify(partial, null, 2), "utf8");
    await fs.writeFile(
      MD_PATH,
      [
        "# Paper + ML optimization audit",
        "",
        `Generated: ${generatedAt}`,
        "",
        "## DB unavailable",
        "",
        "```",
        dbError ?? "",
        "```",
        "",
      ].join("\n"),
      "utf8"
    );
    console.log("DB unreachable:", dbError);
    console.log("strongest bot: n/a");
    console.log("weakest bot: n/a");
    console.log("ML score vs outcomes: unknown (no DB)");
    console.log("top paper optimization: verify DATABASE_URL and re-run");
    console.log("top ML optimization: verify DATABASE_URL and re-run");
    process.exit(0);
  }

  const [globalConfig, maxHoldHours, effectiveProfiles, perBotAllTime, overlap, paperState, workerHb] =
    await Promise.all([
      Promise.resolve(getPaperTradingConfig()),
      Promise.resolve(getPaperTradingMaxHoldHours()),
      getEffectiveBotProfiles(),
      getPerBotAnalytics(),
      getBotOverlapReport(),
      prisma.paperTradingState.findUnique({ where: { id: "default" } }),
      prisma.workerHeartbeat.findUnique({
        where: { workerName: WORKER_NAME },
        select: { lastSeenAt: true, metadataJson: true },
      }),
    ]);

  let lastOpenTick: Record<string, unknown> | null = null;
  if (paperState?.lastOpenTickResultJson) {
    try {
      lastOpenTick = JSON.parse(paperState.lastOpenTickResultJson) as Record<string, unknown>;
    } catch {
      lastOpenTick = null;
    }
  }

  let lastCloseParsed: Record<string, unknown> | null = null;
  if (paperState?.lastCloseTickResultJson) {
    try {
      lastCloseParsed = JSON.parse(paperState.lastCloseTickResultJson) as Record<string, unknown>;
    } catch {
      lastCloseParsed = null;
    }
  }
  const closeNorm = normalizeCloseTickResult(lastCloseParsed);

  const traces: PaperDecisionTraceEntry[] =
    (lastOpenTick?.decisionTraceBundle as PaperDecisionTraceBundle | undefined)?.traces ?? [];
  const traceBundleMeta = lastOpenTick?.decisionTraceBundle
    ? {
        generatedAt: (lastOpenTick.decisionTraceBundle as PaperDecisionTraceBundle).generatedAt,
        totalCandidatesConsidered: (lastOpenTick.decisionTraceBundle as PaperDecisionTraceBundle)
          .totalCandidatesConsidered,
        maxTracesStored: (lastOpenTick.decisionTraceBundle as PaperDecisionTraceBundle).maxTracesStored,
      }
    : null;

  const rejectCounts: Record<string, number> = {};
  for (const t of traces) {
    const code = typeof t.rejectReasonCode === "string" ? t.rejectReasonCode : null;
    if (code) rejectCounts[code] = (rejectCounts[code] ?? 0) + 1;
  }

  function traceNum(x: unknown): number | null {
    if (typeof x === "number" && Number.isFinite(x)) return x;
    return null;
  }

  const admitted = traces.filter((t) => t.finalDisposition === "admitted");
  const rejected = traces.filter((t) => t.finalDisposition === "rejected");
  const thresholdEligibleRejected = rejected.filter((t) => t.thresholdEligible === true);

  function avgTraceField(ts: PaperDecisionTraceEntry[], key: keyof PaperDecisionTraceEntry): number | null {
    const vals = ts.map((x) => traceNum(x[key] as unknown)).filter((n): n is number => n !== null);
    return mean(vals);
  }

  const compareAdmittedVsRejected = {
    nAdmitted: admitted.length,
    nRejected: rejected.length,
    avgAdmissionScoreAdmitted: avgTraceField(admitted, "admissionScore"),
    avgAdmissionScoreRejected: avgTraceField(rejected, "admissionScore"),
    avgSpreadBpsAdmitted: avgTraceField(admitted, "spreadBps"),
    avgSpreadBpsRejected: avgTraceField(rejected, "spreadBps"),
    avgSlippageBpsAdmitted: avgTraceField(admitted, "estimatedSlippageBps"),
    avgSlippageBpsRejected: avgTraceField(rejected, "estimatedSlippageBps"),
    thresholdEligibleRejectedCount: thresholdEligibleRejected.length,
    thresholdEligibleRejectedTopReasons: (() => {
      const m: Record<string, number> = {};
      for (const t of thresholdEligibleRejected) {
        const c = t.rejectReasonCode ?? "unknown";
        m[c] = (m[c] ?? 0) + 1;
      }
      return Object.entries(m)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([reason, count]) => ({ reason, count }));
    })(),
  };

  const perBotAggregates = (lastOpenTick?.decisionTraceBundle as PaperDecisionTraceBundle | undefined)
    ?.perBotAggregates;

  const openedLastTick =
    typeof lastOpenTick?.opened === "number"
      ? lastOpenTick.opened
      : Object.values(
          (lastOpenTick?.perBotResults ?? {}) as Record<string, { opened?: number }>
        ).reduce((s, x) => s + (typeof x.opened === "number" ? x.opened : 0), 0) || null;

  const hbMeta = parseHeartbeatMetadataJson(workerHb?.metadataJson ?? null);
  const runtimeSafety = hbMeta?.runtimeSafety as Record<string, unknown> | undefined;
  const runtimeState = typeof runtimeSafety?.state === "string" ? runtimeSafety.state : null;

  const closed7d = await prisma.paperTrade.findMany({
    where: { status: "closed", exitTime: { gte: since7 } },
    select: {
      botType: true,
      score: true,
      pnlPct: true,
      entryTime: true,
      exitTime: true,
      metadataJson: true,
    },
  });

  const closed30dForBands = await prisma.paperTrade.findMany({
    where: { status: "closed", exitTime: { gte: since30 } },
    orderBy: { exitTime: "desc" },
    take: CLOSED_FOR_BANDS_LIMIT,
    select: {
      botType: true,
      score: true,
      pnlPct: true,
      entryTime: true,
      exitTime: true,
      metadataJson: true,
    },
  });

  const openByBot = await prisma.paperTrade.groupBy({
    by: ["botType"],
    where: { status: "open" },
    _count: { _all: true },
  });
  const openByBotMap: Record<string, number> = {};
  for (const r of openByBot) {
    openByBotMap[r.botType ?? "default"] = r._count._all;
  }

  const closed7dByBot = await prisma.paperTrade.groupBy({
    by: ["botType"],
    where: { status: "closed", exitTime: { gte: since7 } },
    _count: { _all: true },
  });
  const closed7dByBotMap: Record<string, number> = {};
  for (const r of closed7dByBot) {
    closed7dByBotMap[r.botType ?? "default"] = r._count._all;
  }

  const perBot7d: Record<string, ReturnType<typeof aggregateClosedStats> & { exitReasonCounts: Record<string, number> }> =
    {};
  for (const b of [...new Set(closed7d.map((x) => x.botType ?? "default"))]) {
    const subset = closed7d.filter((x) => (x.botType ?? "default") === b);
    const st = aggregateClosedStats(subset);
    const exitReasonCounts: Record<string, number> = {};
    for (const t of subset) {
      const code = parseCloseReasonCode(t.metadataJson);
      exitReasonCounts[code] = (exitReasonCounts[code] ?? 0) + 1;
    }
    perBot7d[b] = { ...st, exitReasonCounts };
  }

  const allClosedForExitAudit = await prisma.paperTrade.findMany({
    where: { status: "closed" },
    select: { pnlPct: true, entryTime: true, exitTime: true, metadataJson: true },
    take: 20_000,
    orderBy: { exitTime: "desc" },
  });

  const exitReasonGlobal: Record<string, { count: number; pnls: number[]; holds: number[] }> = {};
  for (const t of allClosedForExitAudit) {
    const code = parseCloseReasonCode(t.metadataJson);
    if (!exitReasonGlobal[code]) exitReasonGlobal[code] = { count: 0, pnls: [], holds: [] };
    exitReasonGlobal[code].count++;
    const p = parsePnl(t.pnlPct);
    if (p != null) exitReasonGlobal[code].pnls.push(p);
    if (t.exitTime) {
      exitReasonGlobal[code].holds.push((t.exitTime.getTime() - t.entryTime.getTime()) / (60 * 60 * 1000));
    }
  }
  const exitReasonSummary = Object.entries(exitReasonGlobal)
    .map(([reason, v]) => ({
      reason,
      count: v.count,
      avgPnlPct: mean(v.pnls),
      medianPnlPct: medianSorted([...v.pnls].sort((a, b) => a - b)),
      avgHoldHours: mean(v.holds),
    }))
    .sort((a, b) => b.count - a.count);

  const rowsForBands: ClosedRow[] = closed30dForBands.map((r) => ({
    botType: r.botType ?? "default",
    score: r.score,
    pnlPct: r.pnlPct,
    entryTime: r.entryTime,
    exitTime: r.exitTime,
    metadataJson: r.metadataJson,
  }));

  const bandByAdmission = bandStatsFromClosed(rowsForBands, (r) => {
    const { admissionForBand } = admissionScalarsFromTrade(r.metadataJson, r.score);
    return admissionForBand;
  });
  const bandByRaw = bandStatsFromClosed(rowsForBands, (r) => {
    const { raw } = admissionScalarsFromTrade(r.metadataJson, r.score);
    return raw;
  });

  const bandAvgSeries = SCORE_BAND_LABELS.map((b) => ({
    band: b,
    avg: bandByAdmission[b]?.avgPnlPct ?? null,
    n: bandByAdmission[b]?.tradeCount ?? 0,
  }));
  const mono = monotonicityScore(bandAvgSeries);

  let calibrationCoverage = 0;
  for (const r of rowsForBands) {
    const a = parseOpenAttributionFromMetadataJson(r.metadataJson);
    if (a?.paperShadowScoreCalibration) calibrationCoverage++;
  }
  const calibrationCoveragePct =
    rowsForBands.length > 0 ? calibrationCoverage / rowsForBands.length : 0;

  const mlUsefulnessVerdict =
    rowsForBands.length < 30
      ? "insufficient_closed_sample"
      : mono === "non_decreasing_across_bands"
        ? "higher_admission_score_bands_show_non_worse_avg_pnl_in_window"
        : mono === "mostly_non_decreasing_one_inversion"
          ? "weak_positive_pattern_with_noise"
          : mono === "insufficient_per_band_samples"
            ? "sparse_bands_need_more_data"
            : "no_clear_monotonic_edge_by_score_band";

  const botRows7d = Object.entries(perBot7d).map(([botType, s]) => ({
    botType,
    ...s,
    openNow: openByBotMap[botType] ?? 0,
    closedLast7d: closed7dByBotMap[botType] ?? 0,
  }));
  botRows7d.sort((a, b) => (b.avgPnlPct ?? -999) - (a.avgPnlPct ?? -999));

  const minTradesForRank = 5;
  let cohort = botRows7d.filter((b) => b.withPnl >= minTradesForRank);
  if (cohort.length < 2) cohort = botRows7d.filter((b) => b.withPnl >= 1);
  const sortedPnl = [...cohort].sort((a, b) => (a.avgPnlPct ?? -1e9) - (b.avgPnlPct ?? -1e9));
  const weakestBot = sortedPnl.length ? sortedPnl[0]!.botType : "n/a";
  const strongestBot = sortedPnl.length ? sortedPnl[sortedPnl.length - 1]!.botType : "n/a";

  const capUsageByBot = effectiveProfiles.map((p) => ({
    botType: p.botType,
    maxOpenTotal: p.maxOpenTotal,
    openNow: openByBotMap[p.botType] ?? 0,
    utilizationVsCap:
      p.maxOpenTotal > 0 ? (openByBotMap[p.botType] ?? 0) / p.maxOpenTotal : null,
    closed7d: closed7dByBotMap[p.botType] ?? 0,
    avgPnl7d: perBot7d[p.botType]?.avgPnlPct ?? null,
    enabled: p.effectiveEnabled,
  }));

  const dominantBlockers = perBotAggregates
    ? perBotAggregates
        .map((a) => {
          const bot = a.botType;
          const pairs = [
            ["rejectedByCooldown", a.rejectedByCooldown],
            ["rejectedBySpreadGuard", a.rejectedBySpreadGuard],
            ["rejectedBySlippageGuard", a.rejectedBySlippageGuard],
            ["rejectedByCaps", a.rejectedByCaps],
            ["rejectedByBudget", a.rejectedByBudget],
            ["rejectedByThreshold", a.rejectedByThreshold],
            ["rejectedByDedupe", a.rejectedByDedupe],
          ] as const;
          const top = [...pairs].sort((x, y) => y[1] - x[1])[0];
          return { botType: bot, topReject: top[0], topRejectCount: top[1], totalCandidates: a.totalCandidates };
        })
        .filter((x) => x.topRejectCount > 0)
        .sort((a, b) => b.topRejectCount - a.topRejectCount)
    : [];

  const maxHoldReasonShare =
    allClosedForExitAudit.length > 0
      ? (exitReasonGlobal[`max_hold_${maxHoldHours}h`]?.count ?? 0) / allClosedForExitAudit.length
      : null;

  const section5SmarterExits = {
    currentMaxHoldHours: maxHoldHours,
    note: "Paper closes use snapshot/markout-based exit price at hold horizon (see lib/paper-trading/engine.ts closeDuePaperTrades).",
    maxHoldReasonFractionOfRecentClosedSample: maxHoldReasonShare,
    interpretation:
      maxHoldReasonShare != null && maxHoldReasonShare > 0.85
        ? "Most sampled closes align with scheduled max-hold horizon — PnL is largely 'markout at horizon', not discretionary exits."
        : "Exit reasons are mixed; review exitReasonSummary for non-max-hold share.",
    wouldSmarterExitsLikelyHelpEvidence:
      maxHoldHours <= 2 && maxHoldReasonShare != null && maxHoldReasonShare > 0.9
        ? "Short horizon + overwhelming max-hold codes: economic outcome is dominated by fixed holding period; earlier/later exits could change results materially — but this tool does not observe counterfactual paths."
        : "Insufficient evidence from codes alone; compare avgPnl and hold by reason in exitReasonSummary.",
  };

  const section1 = {
    systemHealth: [
      workerHb?.lastSeenAt
        ? `Worker heartbeat lastSeenAt=${workerHb.lastSeenAt.toISOString()} state=${runtimeState ?? "unknown"}`
        : "No worker heartbeat row found.",
      paperState?.lastOpenTickAt
        ? `Paper last open tick at ${paperState.lastOpenTickAt.toISOString()}`
        : "No paper open tick timestamp.",
      paperState?.lastCloseTickAt
        ? `Paper last close tick at ${paperState.lastCloseTickAt.toISOString()}`
        : "No paper close tick timestamp.",
    ],
    dominantThroughputBlockers: [
      ...Object.entries(rejectCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([k, v]) => `${k}: ${v} (last tick trace sample)`),
      ...(dominantBlockers.length
        ? [`Per-bot aggregate hint: ${dominantBlockers[0]!.botType} → ${dominantBlockers[0]!.topReject} (${dominantBlockers[0]!.topRejectCount})`]
        : []),
    ],
    paperPerformanceSnapshot: {
      perBotAllTimeHeadline: perBotAllTime.map((b) => ({
        botType: b.botType,
        open: b.openTrades,
        closed: b.closedTrades,
        winRate: b.winRate,
        avgPnlPct: b.averagePnlPct,
      })),
      perBotLast7dClosed: botRows7d,
      openedLastTickTotal: openedLastTick,
      closeTickNormalized: {
        closed: closeNorm.closed,
        dueCount: closeNorm.dueCount,
        closeReasonCounts: closeNorm.closeReasonCounts,
      },
    },
    mlAppearsEconomicallyUseful: mlUsefulnessVerdict,
    top3OptimizationOpportunities: [
      {
        area: "paper",
        item: maxHoldReasonShare != null && maxHoldReasonShare > 0.85 ? "Re-evaluate max hold vs markout signal" : "Tune liquidity guards vs admission",
        rationale: "Dominant exit driver and/or spread/slippage rejections in traces shape realized paper PnL.",
      },
      {
        area: "ml",
        item:
          mono !== "non_decreasing_across_bands"
            ? "Recalibrate or retrain so admission score aligns with realized band PnL"
            : "Raise selectivity at very high scores if saturation — see paper-score-calibration report",
        rationale: `Score-band monotonicity: ${mono}; calibration metadata present on ${(calibrationCoveragePct * 100).toFixed(1)}% of band sample rows.`,
      },
      {
        area: "capacity",
        item: "Rebalance per-bot caps using utilization × avgPnl7d",
        rationale: "Some bots may monopolize slots while others stay under cap with better recent mean PnL.",
      },
    ],
  };

  const section7 = {
    ruleLayerBeforeMl: [
      "Candidates originate from ShadowCandidate / decision snapshots; bot profiles filter policy state, price band, theme/category exclusions (lib/paper-trading/engine.ts + bot-profiles).",
      "Liquidity guards (spread/slippage bps) and caps/cooldowns/dedupe/budget run after scoring.",
    ],
    mlDecides: [
      "Shadow logistic score (raw); optional logit-temperature 'calibrated' probability for admission when PAPER_SHADOW_USE_CALIBRATED_SCORE_FOR_PAPER is enabled (lib/paper-trading/config.ts).",
      "Threshold and exploration band vs effective min score determine eligibility before non-ML gates.",
    ],
    mlRoleAssessment: [
      compareAdmittedVsRejected.avgAdmissionScoreRejected != null &&
      compareAdmittedVsRejected.avgAdmissionScoreAdmitted != null
        ? `Last-tick trace: mean admissionScore admitted=${compareAdmittedVsRejected.avgAdmissionScoreAdmitted?.toFixed(4)} vs rejected=${compareAdmittedVsRejected.avgAdmissionScoreRejected?.toFixed(4)}`
        : "Last-tick trace: admission scores not fully populated for comparison.",
      thresholdEligibleRejected.length > 0
        ? `${thresholdEligibleRejected.length} threshold-eligible candidates were still rejected (non-ML gates dominate for that subset).`
        : "No threshold-eligible rejections in bounded last-tick trace (or traces empty).",
    ],
    thresholdsPermissiveOrRestrictive:
      rejectCounts.below_threshold != null && traces.length > 0 && rejectCounts.below_threshold / traces.length > 0.4
        ? "Threshold rejections are a large share of last-tick trace — floor may be restrictive vs candidate pool."
        : rejectCounts.below_threshold != null && rejectCounts.below_threshold < traces.length * 0.1
          ? "Few below_threshold rejections in last-tick trace — most mass is post-score gates or admission."
          : "Inspect rejectCounts for mix.",
  };

  const section8 = {
    paperModuleOptimizations: [
      {
        recommendation: "Per-bot max hold or staggered horizons",
        expectedBenefit: "Align markout window to signal half-life per bot/theme.",
        risk: "Changes comparability vs historical paper series.",
        implementationDifficulty: "medium",
        confidence: "medium",
      },
      {
        recommendation: "Tighten or relax spread/slippage caps using admitted vs rejected spread deltas from traces",
        expectedBenefit: "Fewer toxic entries or fewer false blocks.",
        risk: "Overfitting to short sample.",
        implementationDifficulty: "low",
        confidence: "medium",
      },
      {
        recommendation: "Bot-specific cooldowns when cooldown_asset dominates a bot",
        expectedBenefit: "More diverse throughput without opening duplicates.",
        risk: "More concurrent risk exposure.",
        implementationDifficulty: "low",
        confidence: "medium",
      },
    ],
    mlOptimizations: [
      {
        recommendation: "Score-band dashboards + threshold per bot",
        expectedBenefit: "Exploit non-linear returns if bands are informative.",
        risk: "Fragmented samples per bot.",
        implementationDifficulty: "medium",
        confidence: mono.includes("non_decreasing") ? "medium" : "low",
      },
      {
        recommendation: "Ensure openAttribution.paperShadowScoreCalibration populated + monitor raw vs admission drift",
        expectedBenefit: "Auditable linkage between gate score and raw model output.",
        risk: "None for read path; storage size.",
        implementationDifficulty: "low",
        confidence: "high",
      },
      {
        recommendation: "Retrain with labels aligned to paper hold horizon (not only 12h training label if mismatched)",
        expectedBenefit: "Model objective matches deployment horizon.",
        risk: "Label noise; engineering cost.",
        implementationDifficulty: "high",
        confidence: "medium",
      },
    ],
  };

  const section9 = {
    caveats: [
      `Decision traces are from the latest open tick only, capped at ~400 entries (${traceBundleMeta ? "present" : "missing"}).`,
      `Score-band analysis uses up to ${CLOSED_FOR_BANDS_LIMIT} most recent closes in 30d — not full history.`,
      `PaperTrade.score column is raw shadow probability; admission bucketing prefers calibration metadata when present (${(calibrationCoveragePct * 100).toFixed(1)}% rows).`,
      "ShadowCandidate markouts are not joined here — 'later outcome proxy for blocked rows' is limited to trace fields only.",
      "Bot ranking uses 7d closed trades with min 5 PnL rows when possible; sparse bots fall back to noisy ordering.",
    ],
  };

  const report = {
    generatedAt,
    dbReachable: true,
    configEcho: {
      threshold: globalConfig.threshold,
      maxHoldHours,
      paperShadowUseCalibratedScoreForPaper: globalConfig.paperShadowUseCalibratedScoreForPaper,
      maxSpreadBps: globalConfig.paperMaxSpreadBps,
      maxEstimatedSlippageBps: globalConfig.paperMaxEstimatedSlippageBps,
    },
    section1_executiveSummary: section1,
    section2_paperPerformanceByBot: {
      allTime: perBotAllTime,
      last7dClosedDetail: botRows7d,
      openCountByBot: openByBotMap,
      overlapTop: overlap.slice(0, 12),
      strongestBot,
      weakestBot,
      rankingNote:
        "strongest/weakest use 7d closed trades with PnL: prefer bots with ≥5 such rows, else ≥1; compare mean pnlPct.",
    },
    section3_mlUsefulness: {
      lookbackDaysForBands: 30,
      bandCap: CLOSED_FOR_BANDS_LIMIT,
      calibrationMetadataCoverageFraction: calibrationCoveragePct,
      byAdmissionScoreBand: bandByAdmission,
      byRawScoreBand: bandByRaw,
      bandAveragePnlSeries: bandAvgSeries,
      monotonicity: mono,
      verdict: mlUsefulnessVerdict,
    },
    section4_entryFilterEffectiveness: {
      lastTickTraceMeta: traceBundleMeta,
      rejectReasonCountsLastTickTrace: rejectCounts,
      perBotAggregatesLastTick: perBotAggregates ?? null,
      admittedVsRejectedComparison: compareAdmittedVsRejected,
      note: "Blocked vs admitted comparison uses only the bounded last successful open-tick trace, not historical logs.",
    },
    section5_exitQuality: {
      exitReasonSummary,
      maxHoldHoursConfigured: maxHoldHours,
      smarterExitsAssessment: section5SmarterExits,
    },
    section6_capacityBotAllocation: {
      capUsageByBot,
      profilesEffective: effectiveProfiles.map((p) => ({
        botType: p.botType,
        effectiveEnabled: p.effectiveEnabled,
        maxOpenTotal: p.maxOpenTotal,
        threshold: p.threshold,
      })),
    },
    section7_mlVsRules: section7,
    section8_optimizerRecommendations: section8,
    section9_trustCaveats: section9,
    terminalSummary: {
      strongestBot,
      weakestBot,
      mlScoreOutcomeCorrelation: mlUsefulnessVerdict,
      topPaperOptimization: section8.paperModuleOptimizations[0]!.recommendation,
      topMlOptimization: section8.mlOptimizations[0]!.recommendation,
    },
  };

  await fs.writeFile(JSON_PATH, JSON.stringify(report, null, 2), "utf8");

  const md: string[] = [];
  md.push("# Paper trading + ML optimization audit");
  md.push("");
  md.push(`Generated: ${generatedAt}`);
  md.push("");
  md.push("## Section 1 — Executive summary");
  md.push("");
  md.push("### System health");
  for (const x of section1.systemHealth) md.push(`- ${x}`);
  md.push("");
  md.push("### Dominant throughput blockers");
  for (const x of section1.dominantThroughputBlockers) md.push(`- ${x}`);
  md.push("");
  md.push("### ML usefulness (heuristic)");
  md.push("");
  md.push(section1.mlAppearsEconomicallyUseful);
  md.push("");
  md.push("### Top 3 optimization opportunities");
  for (const o of section1.top3OptimizationOpportunities) {
    md.push(`- **${o.area}:** ${o.item} — ${o.rationale}`);
  }
  md.push("");
  md.push("## Section 2 — Paper performance by bot (7d closed + open now)");
  md.push("");
  md.push("| bot | open | closed7d | nPnl | winRate | avgPnl | medPnl | avgHoldH |");
  md.push("|-----|------|----------|------|---------|--------|--------|----------|");
  for (const b of botRows7d) {
    md.push(
      `| ${b.botType} | ${b.openNow} | ${b.closedLast7d} | ${b.withPnl} | ${b.winRate != null ? (b.winRate * 100).toFixed(1) + "%" : "—"} | ${b.avgPnlPct != null ? (b.avgPnlPct * 100).toFixed(3) + "%" : "—"} | ${b.medianPnlPct != null ? (b.medianPnlPct * 100).toFixed(3) + "%" : "—"} | ${b.avgHoldHours != null ? b.avgHoldHours.toFixed(2) : "—"} |`
    );
  }
  md.push("");
  md.push("## Section 3 — ML usefulness (admission score bands, closed ≤30d sample)");
  md.push("");
  md.push(`Monotonicity check: **${mono}** (${mlUsefulnessVerdict})`);
  md.push("");
  md.push("| band | n | winRate | avgPnl | medPnl | avgHoldH |");
  md.push("|------|---|---------|--------|--------|----------|");
  for (const b of SCORE_BAND_LABELS) {
    const s = bandByAdmission[b];
    md.push(
      `| ${b} | ${s.tradeCount} | ${s.winRate != null ? (s.winRate * 100).toFixed(1) + "%" : "—"} | ${s.avgPnlPct != null ? (s.avgPnlPct * 100).toFixed(3) + "%" : "—"} | ${s.medianPnlPct != null ? (s.medianPnlPct * 100).toFixed(3) + "%" : "—"} | ${s.avgHoldHours != null ? s.avgHoldHours.toFixed(2) : "—"} |`
    );
  }
  md.push("");
  md.push("## Section 4 — Entry filters (last tick trace)");
  md.push("");
  md.push("```json");
  md.push(JSON.stringify(rejectCounts, null, 2));
  md.push("```");
  md.push("");
  md.push("### Admitted vs rejected (trace averages)");
  md.push("");
  md.push("```json");
  md.push(JSON.stringify(compareAdmittedVsRejected, null, 2));
  md.push("```");
  md.push("");
  md.push("## Section 5 — Exit quality");
  md.push("");
  md.push("```json");
  md.push(JSON.stringify(exitReasonSummary.slice(0, 15), null, 2));
  md.push("```");
  md.push("");
  md.push("### Would smarter exits likely help?");
  md.push("");
  md.push(section5SmarterExits.wouldSmarterExitsLikelyHelpEvidence);
  md.push("");
  md.push("## Section 6 — Capacity / allocation");
  md.push("");
  md.push("| bot | open | maxOpen | util | closed7d | avgPnl7d |");
  md.push("|-----|------|---------|------|----------|----------|");
  for (const c of capUsageByBot) {
    md.push(
      `| ${c.botType} | ${c.openNow} | ${c.maxOpenTotal} | ${c.utilizationVsCap != null ? (c.utilizationVsCap * 100).toFixed(1) + "%" : "—"} | ${c.closed7d} | ${c.avgPnl7d != null ? (c.avgPnl7d * 100).toFixed(3) + "%" : "—"} |`
    );
  }
  md.push("");
  md.push("## Section 7 — ML vs rules");
  md.push("");
  for (const x of section7.ruleLayerBeforeMl) md.push(`- ${x}`);
  md.push("");
  for (const x of section7.mlDecides) md.push(`- ${x}`);
  md.push("");
  md.push(String(section7.thresholdsPermissiveOrRestrictive));
  md.push("");
  md.push("## Section 8 — Optimizer recommendations");
  md.push("");
  md.push("### A. Paper module");
  for (const r of section8.paperModuleOptimizations) {
    md.push(`- **${r.recommendation}** — benefit: ${r.expectedBenefit}; risk: ${r.risk}; difficulty: ${r.implementationDifficulty}; confidence: ${r.confidence}`);
  }
  md.push("");
  md.push("### B. ML");
  for (const r of section8.mlOptimizations) {
    md.push(`- **${r.recommendation}** — benefit: ${r.expectedBenefit}; risk: ${r.risk}; difficulty: ${r.implementationDifficulty}; confidence: ${r.confidence}`);
  }
  md.push("");
  md.push("## Section 9 — Trust / caveats");
  for (const c of section9.caveats) md.push(`- ${c}`);
  md.push("");
  md.push("---");
  md.push("");
  md.push("## Terminal summary");
  md.push(`- **strongest bot:** ${strongestBot}`);
  md.push(`- **weakest bot:** ${weakestBot}`);
  md.push(`- **ML scores vs outcomes:** ${mlUsefulnessVerdict}`);
  md.push(`- **top paper optimization:** ${section8.paperModuleOptimizations[0]!.recommendation}`);
  md.push(`- **top ML optimization:** ${section8.mlOptimizations[0]!.recommendation}`);

  await fs.writeFile(MD_PATH, md.join("\n"), "utf8");

  console.log("Wrote", JSON_PATH);
  console.log("Wrote", MD_PATH);
  console.log("strongest bot:", strongestBot);
  console.log("weakest bot:", weakestBot);
  console.log("ML score vs outcomes:", mlUsefulnessVerdict);
  console.log("top paper optimization:", section8.paperModuleOptimizations[0]!.recommendation);
  console.log("top ML optimization:", section8.mlOptimizations[0]!.recommendation);

  await prisma.$disconnect().catch(() => undefined);
}

main().catch(async (e) => {
  console.error(e);
  try {
    await prisma.$disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
