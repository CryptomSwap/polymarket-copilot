/**
 * Read-only evidence pack for V2/structured live paper regime.
 * Run: npx tsx tools/create-v2-structured-live-regime-report.ts
 */
import "dotenv/config";
import * as fs from "fs/promises";
import * as path from "path";
import { prisma } from "../lib/db";

type PaperRow = {
  id: string;
  score: number;
  entryPrice: string;
  status: string;
  markout12h: string | null;
  pnlPct: string | null;
  pnlDollars: string | null;
  botType: string;
  dedupeKey: string;
  createdAt: Date;
};

type TickTraceRow = {
  candidateId: string | null;
  recommendationId: string | null;
  botType: string | null;
  admissionScore: number | null;
  championScore: number | null;
  thresholdEligible: boolean;
  finalDisposition: "admitted" | "rejected" | "unknown";
  rejectReasonCode: string | null;
};

const PRICE_BANDS = ["<0.1", "0.1-0.2", "0.2-0.3", "0.3-0.4", "0.4-0.6", "0.6-0.8", "0.8-0.9", ">=0.9"] as const;
type PriceBand = (typeof PRICE_BANDS)[number];

function parseNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).trim());
  return Number.isFinite(n) ? n : null;
}
function avg(nums: number[]): number | null {
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}
function median(nums: number[]): number | null {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
function pct(n: number | null): string {
  return n == null ? "-" : `${(n * 100).toFixed(2)}%`;
}
function fmt(n: number | null, d = 6): string {
  return n == null ? "-" : n.toFixed(d);
}
function markoutOrPnl(r: { markout12h: string | null; pnlPct: string | null }): number | null {
  return parseNum(r.markout12h) ?? parseNum(r.pnlPct);
}
function markoutOnly(r: { markout12h: string | null }): number | null {
  return parseNum(r.markout12h);
}
function classifyPriceBand(price: number | null): PriceBand | "unknown" {
  if (price == null) return "unknown";
  if (price < 0.1) return "<0.1";
  if (price < 0.2) return "0.1-0.2";
  if (price < 0.3) return "0.2-0.3";
  if (price < 0.4) return "0.3-0.4";
  if (price < 0.6) return "0.4-0.6";
  if (price < 0.8) return "0.6-0.8";
  if (price < 0.9) return "0.8-0.9";
  return ">=0.9";
}
function scoreBucketEdges(scores: number[]): number[] {
  // Deterministic fixed buckets when sample is small, deciles when sufficiently large.
  if (scores.length < 80) return [0, 0.2, 0.4, 0.6, 0.8, 1.000001];
  const sorted = [...scores].sort((a, b) => a - b);
  const qs: number[] = [0];
  for (let i = 1; i < 10; i++) {
    const idx = Math.min(sorted.length - 1, Math.floor((i / 10) * (sorted.length - 1)));
    qs.push(sorted[idx]!);
  }
  qs.push(1.000001);
  for (let i = 1; i < qs.length; i++) {
    if (qs[i]! <= qs[i - 1]!) qs[i] = qs[i - 1]! + 1e-9;
  }
  return qs;
}
function scoreBucketLabel(edges: number[], score: number): string {
  for (let i = 0; i < edges.length - 1; i++) {
    const lo = edges[i]!;
    const hi = edges[i + 1]!;
    if ((i === edges.length - 2 && score <= hi) || (score >= lo && score < hi)) {
      return `[${lo.toFixed(3)}, ${Math.min(hi, 1).toFixed(3)}${i === edges.length - 2 ? "]" : ")"}`;
    }
  }
  return "[unknown]";
}
function summarizeCohort(rows: PaperRow[]) {
  const closed = rows.filter((r) => r.status === "closed");
  const markouts = closed.map(markoutOnly).filter((x): x is number => x != null);
  const usable = closed.map(markoutOrPnl).filter((x): x is number => x != null);
  const pnl = closed.map((r) => parseNum(r.pnlPct)).filter((x): x is number => x != null);
  const pnlDollars = closed.map((r) => parseNum(r.pnlDollars)).filter((x): x is number => x != null);
  return {
    totalOpens: rows.length,
    totalClosed: closed.length,
    closeRate: rows.length > 0 ? closed.length / rows.length : null,
    avgMarkout: avg(markouts),
    medianMarkout: median(markouts),
    avgRealizedPnlPct: avg(pnl),
    avgRealizedPnlDollars: avg(pnlDollars),
    totalRealizedPnlDollars: pnlDollars.length > 0 ? pnlDollars.reduce((a, b) => a + b, 0) : null,
    winRate: usable.length ? usable.filter((x) => x > 0).length / usable.length : null,
    closedWithMarkout: markouts.length,
  };
}
function parseJsonObj(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as unknown;
    return p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
function histogramByBand(vals: Array<number | null>): Record<PriceBand | "unknown", number> {
  const out: Record<PriceBand | "unknown", number> = {
    "<0.1": 0,
    "0.1-0.2": 0,
    "0.2-0.3": 0,
    "0.3-0.4": 0,
    "0.4-0.6": 0,
    "0.6-0.8": 0,
    "0.8-0.9": 0,
    ">=0.9": 0,
    unknown: 0,
  };
  for (const v of vals) out[classifyPriceBand(v)]++;
  return out;
}
async function resolveRegimeStart(): Promise<{ since: Date; source: string }> {
  const envRaw = process.env.PAPER_V2_STRUCTURED_REGIME_SINCE?.trim();
  if (envRaw) {
    const d = new Date(envRaw);
    if (!Number.isFinite(d.getTime())) throw new Error(`Invalid PAPER_V2_STRUCTURED_REGIME_SINCE: ${envRaw}`);
    return { since: d, source: "env:PAPER_V2_STRUCTURED_REGIME_SINCE" };
  }
  const first = await prisma.paperTrade.findFirst({
    where: { dedupeKey: { contains: "|v2|" } },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true },
  });
  if (!first) {
    throw new Error("No PaperTrade row with dedupeKey containing '|v2|'.");
  }
  return {
    since: first.createdAt,
    source: "inferred:min(createdAt) where dedupeKey contains |v2|",
  };
}

async function main(): Promise<void> {
  const generatedAt = new Date().toISOString();
  const { since: regimeStart, source: regimeStartSource } = await resolveRegimeStart();

  const regimeRows = await prisma.paperTrade.findMany({
    where: { createdAt: { gte: regimeStart }, dedupeKey: { contains: "|v2|" } },
    select: {
      id: true,
      score: true,
      entryPrice: true,
      status: true,
      markout12h: true,
      pnlPct: true,
      pnlDollars: true,
      botType: true,
      dedupeKey: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  });
  const closedRegime = regimeRows.filter((r) => r.status === "closed");
  const baselineRows = await prisma.paperTrade.findMany({
    where: { createdAt: { lt: regimeStart }, status: "closed", NOT: { dedupeKey: { contains: "|v2|" } } },
    select: {
      id: true,
      score: true,
      entryPrice: true,
      status: true,
      markout12h: true,
      pnlPct: true,
      pnlDollars: true,
      botType: true,
      dedupeKey: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
    take: Math.max(1, closedRegime.length),
  });
  const overall = summarizeCohort(regimeRows);
  const baseline = summarizeCohort(baselineRows);

  // A2 by price band
  const priceBandRows = PRICE_BANDS.map((band) => {
    const opens = regimeRows.filter((r) => classifyPriceBand(parseNum(r.entryPrice)) === band);
    const closed = opens.filter((r) => r.status === "closed");
    const markouts = closed.map(markoutOnly).filter((x): x is number => x != null);
    const usable = closed.map(markoutOrPnl).filter((x): x is number => x != null);
    const pnl = closed.map((r) => parseNum(r.pnlPct)).filter((x): x is number => x != null);
    return {
      band,
      openCount: opens.length,
      closedCount: closed.length,
      avgMarkout: avg(markouts),
      medianMarkout: median(markouts),
      winRate: usable.length ? usable.filter((x) => x > 0).length / usable.length : null,
      avgRealizedPnlPct: avg(pnl),
    };
  });

  // A3/A4/C score buckets and cross-sections on closed cohort
  const closedWithOutcome = closedRegime.filter((r) => markoutOrPnl(r) != null);
  const scoreEdges = scoreBucketEdges(closedWithOutcome.map((r) => r.score));
  const byScoreBucketMap = new Map<string, PaperRow[]>();
  for (const r of closedWithOutcome) {
    const b = scoreBucketLabel(scoreEdges, r.score);
    byScoreBucketMap.set(b, [...(byScoreBucketMap.get(b) ?? []), r]);
  }
  const scoreBucketRows = [...byScoreBucketMap.entries()]
    .map(([bucket, rows]) => {
      const usable = rows.map(markoutOrPnl).filter((x): x is number => x != null);
      const markouts = rows.map(markoutOnly).filter((x): x is number => x != null);
      return {
        bucket,
        count: rows.length,
        avgMarkout: avg(markouts),
        medianMarkout: median(markouts),
        winRate: usable.length ? usable.filter((x) => x > 0).length / usable.length : null,
      };
    })
    .sort((a, b) => a.bucket.localeCompare(b.bucket));
  const topBottomCompare = (() => {
    if (closedWithOutcome.length < 2) return null;
    const s = [...closedWithOutcome].sort((a, b) => a.score - b.score);
    const k = Math.max(1, Math.floor(s.length * 0.2));
    const bot = s.slice(0, k);
    const top = s.slice(s.length - k);
    const toStats = (rows: PaperRow[]) => {
      const u = rows.map(markoutOrPnl).filter((x): x is number => x != null);
      const m = rows.map(markoutOnly).filter((x): x is number => x != null);
      return { n: rows.length, avgMarkout: avg(m), winRate: u.length ? u.filter((x) => x > 0).length / u.length : null };
    };
    return { k, top: toStats(top), bottom: toStats(bot) };
  })();

  const cross = (() => {
    const out: Array<{ priceBand: string; scoreBucket: string; count: number; avgMarkout: number | null; winRate: number | null }> = [];
    for (const band of PRICE_BANDS) {
      const inBand = closedWithOutcome.filter((r) => classifyPriceBand(parseNum(r.entryPrice)) === band);
      if (inBand.length < 5) continue;
      const map = new Map<string, PaperRow[]>();
      for (const r of inBand) {
        const b = scoreBucketLabel(scoreEdges, r.score);
        map.set(b, [...(map.get(b) ?? []), r]);
      }
      for (const [sb, rows] of map.entries()) {
        if (rows.length < 3) continue;
        const u = rows.map(markoutOrPnl).filter((x): x is number => x != null);
        const m = rows.map(markoutOnly).filter((x): x is number => x != null);
        out.push({
          priceBand: band,
          scoreBucket: sb,
          count: rows.length,
          avgMarkout: avg(m),
          winRate: u.length ? u.filter((x) => x > 0).length / u.length : null,
        });
      }
    }
    return out.sort((a, b) => (a.priceBand === b.priceBand ? a.scoreBucket.localeCompare(b.scoreBucket) : a.priceBand.localeCompare(b.priceBand)));
  })();

  // B: recent tick/candidate mix from persisted latest tick + shadow rows
  const state = await prisma.paperTradingState.findUnique({
    where: { id: "default" },
    select: { lastOpenTickAt: true, lastOpenTickResultJson: true, lastOpenTickError: true },
  });
  const tickObj = parseJsonObj(state?.lastOpenTickResultJson ?? null);
  const tickLoadDiagnostics = (tickObj?.loadDiagnostics ?? null) as Record<string, unknown> | null;
  const tickBundle = (tickObj?.decisionTraceBundle ?? null) as Record<string, unknown> | null;
  const tracesRaw = Array.isArray(tickBundle?.traces) ? (tickBundle?.traces as unknown[]) : [];
  const traceRows: TickTraceRow[] = tracesRaw
    .map((t) => (t && typeof t === "object" ? (t as Record<string, unknown>) : null))
    .filter((t): t is Record<string, unknown> => t != null)
    .map((t) => ({
      candidateId: typeof t.candidateId === "string" ? t.candidateId : null,
      recommendationId: typeof t.recommendationId === "string" ? t.recommendationId : null,
      botType: typeof t.botType === "string" ? t.botType : null,
      admissionScore: parseNum(t.admissionScore),
      championScore: parseNum(t.championScore),
      thresholdEligible: t.thresholdEligible === true,
      finalDisposition:
        t.finalDisposition === "admitted" || t.finalDisposition === "rejected"
          ? t.finalDisposition
          : (t.rejectReasonCode ? "rejected" : "unknown"),
      rejectReasonCode: typeof t.rejectReasonCode === "string" ? t.rejectReasonCode : null,
    }));
  const candidateIds = [...new Set(traceRows.map((r) => r.candidateId).filter((x): x is string => !!x))];
  const shadowRows = candidateIds.length
    ? await prisma.shadowCandidate.findMany({
        where: { id: { in: candidateIds } },
        select: { id: true, intendedPrice: true },
      })
    : [];
  const priceByCandidateId = new Map(shadowRows.map((r) => [r.id, parseNum(r.intendedPrice)]));

  const tickWindowMinutes = parseNum(tickLoadDiagnostics?.shadowLookbackMinutes) ?? null;
  const tickFunderUsed = typeof tickLoadDiagnostics?.shadowFunderUsedForLoad === "string" ? String(tickLoadDiagnostics.shadowFunderUsedForLoad) : null;
  const tickAt = state?.lastOpenTickAt ?? null;
  const beforeFilterShadowRows =
    tickAt && tickWindowMinutes != null && tickWindowMinutes > 0
      ? await prisma.shadowCandidate.findMany({
          where: {
            createdAt: { gte: new Date(tickAt.getTime() - tickWindowMinutes * 60 * 1000), lte: tickAt },
            wasSubmitted: true,
            wasBlocked: false,
            candidateSource: "runtime_automated",
            ...(tickFunderUsed ? { funderAddress: tickFunderUsed } : {}),
          },
          select: { id: true, intendedPrice: true },
        })
      : [];
  const beforeBandHist = histogramByBand(beforeFilterShadowRows.map((r) => parseNum(r.intendedPrice)));
  const afterBandHist = histogramByBand(shadowRows.map((r) => parseNum(r.intendedPrice)));
  const admitted = traceRows.filter((r) => r.finalDisposition === "admitted");
  const rejected = traceRows.filter((r) => r.finalDisposition === "rejected");
  const admittedBandHist = histogramByBand(admitted.map((r) => (r.candidateId ? priceByCandidateId.get(r.candidateId) ?? null : null)));
  const admittedByBot: Record<string, number> = {};
  const admittedByBotBand: Record<string, Record<string, number>> = {};
  for (const row of admitted) {
    const bot = row.botType ?? "unknown";
    const band = classifyPriceBand(row.candidateId ? priceByCandidateId.get(row.candidateId) ?? null : null);
    admittedByBot[bot] = (admittedByBot[bot] ?? 0) + 1;
    admittedByBotBand[bot] = admittedByBotBand[bot] ?? {};
    admittedByBotBand[bot][band] = (admittedByBotBand[bot][band] ?? 0) + 1;
  }
  const rejectReasons: Record<string, number> = {};
  for (const row of rejected) {
    const k = row.rejectReasonCode ?? "unknown_rejection";
    rejectReasons[k] = (rejectReasons[k] ?? 0) + 1;
  }
  const scoreDist = (rows: TickTraceRow[]) => {
    const vals = rows.map((r) => r.admissionScore ?? r.championScore).filter((x): x is number => x != null);
    return { countWithScore: vals.length, mean: avg(vals), median: median(vals) };
  };

  // C: closed cohort ranking quality (latest meaningful closed cohort)
  const cWindowClosed = closedRegime.filter((r) => markoutOrPnl(r) != null);
  const winners = cWindowClosed.filter((r) => (markoutOrPnl(r) ?? 0) > 0);
  const losers = cWindowClosed.filter((r) => (markoutOrPnl(r) ?? 0) <= 0);
  const inBandRanking = ["0.1-0.2", "0.2-0.3", "0.3-0.4"].map((band) => {
    const rows = cWindowClosed.filter((r) => classifyPriceBand(parseNum(r.entryPrice)) === band);
    if (rows.length < 6) return { band, count: rows.length, note: "insufficient_sample" };
    const sorted = [...rows].sort((a, b) => a.score - b.score);
    const k = Math.max(1, Math.floor(sorted.length * 0.5));
    const low = sorted.slice(0, k);
    const high = sorted.slice(sorted.length - k);
    const m = (x: PaperRow[]) => x.map(markoutOrPnl).filter((v): v is number => v != null);
    const hiVals = m(high);
    const loVals = m(low);
    return {
      band,
      count: rows.length,
      highHalfAvgOutcome: avg(hiVals),
      lowHalfAvgOutcome: avg(loVals),
      highHalfWinRate: hiVals.length ? hiVals.filter((v) => v > 0).length / hiVals.length : null,
      lowHalfWinRate: loVals.length ? loVals.filter((v) => v > 0).length / loVals.length : null,
    };
  });

  const report = {
    generatedAt,
    dataSources: {
      regimeRows: "PaperTrade where dedupeKey contains '|v2|' and createdAt >= regimeStart",
      baselineRows: "PaperTrade closed rows before regimeStart where dedupeKey does not contain '|v2|'",
      tickSource: "PaperTradingState.lastOpenTickResultJson (latest persisted open tick only)",
      tickShadowJoin: "decisionTraceBundle.traces[].candidateId -> ShadowCandidate.id for intendedPrice bands",
      tickBeforeFilterSource:
        tickAt && tickWindowMinutes != null
          ? `ShadowCandidate runtime_automated window [${new Date(tickAt.getTime() - tickWindowMinutes * 60 * 1000).toISOString()}, ${tickAt.toISOString()}]`
          : "unavailable (missing lastOpenTickAt or shadowLookbackMinutes)",
    },
    regime: {
      regimeStart: regimeStart.toISOString(),
      regimeStartSource,
      cohortSummary: overall,
      baselineSummary: baseline,
      byPriceBand: priceBandRows,
      scoreBuckets: scoreBucketRows,
      topVsBottomScoreBuckets: topBottomCompare,
      crossPriceBandByScoreBucket: cross,
    },
    recentTickMix: {
      latestTickAt: tickAt?.toISOString() ?? null,
      lastOpenTickError: state?.lastOpenTickError ?? null,
      windowMinutesUsed: tickWindowMinutes,
      funderUsedForLoad: tickFunderUsed,
      candidateMixBeforeFilter: {
        totalCandidates: beforeFilterShadowRows.length,
        byPriceBand: beforeBandHist,
      },
      candidateMixAfterFilter: {
        totalCandidates: shadowRows.length,
        byPriceBand: afterBandHist,
      },
      admittedTrades: {
        total: admitted.length,
        byPriceBand: admittedBandHist,
        byBotType: admittedByBot,
        byBotTypeByPriceBand: admittedByBotBand,
      },
      rejectReasons: Object.entries(rejectReasons)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([reason, count]) => ({ reason, count })),
      noopReasons: {
        zeroCandidatesReason:
          typeof tickLoadDiagnostics?.zeroCandidatesReason === "string" ? tickLoadDiagnostics.zeroCandidatesReason : null,
        notes:
          tickObj == null
            ? "No persisted latest tick JSON; cannot compute tick-level no-op reasons."
            : "Tick result has no explicit noop taxonomy beyond zeroCandidatesReason and rejectReasonCode counts.",
      },
      structuredScoreDistribution: {
        available: traceRows.some((r) => (r.admissionScore ?? r.championScore) != null),
        admitted: scoreDist(admitted),
        rejected: scoreDist(rejected),
      },
    },
    closedCohortRankingQuality: {
      cohortSizeClosedWithOutcome: cWindowClosed.length,
      winnerCount: winners.length,
      loserCount: losers.length,
      winnerScoreMean: avg(winners.map((r) => r.score)),
      winnerScoreMedian: median(winners.map((r) => r.score)),
      loserScoreMean: avg(losers.map((r) => r.score)),
      loserScoreMedian: median(losers.map((r) => r.score)),
      markoutByScoreBucket: scoreBucketRows,
      inBandRankingQuality: inBandRanking,
      sampleSizeLimitations:
        cWindowClosed.length < 20
          ? "Small closed cohort; treat bucket and in-band ranking results as noisy."
          : "In-band slices with <6 rows are flagged insufficient_sample.",
    },
  };

  const outDir = path.join(process.cwd(), "diagnostics");
  await fs.mkdir(outDir, { recursive: true });
  const outJson = path.join(outDir, "v2-structured-live-evidence-pack.json");
  const outMd = path.join(outDir, "v2-structured-live-evidence-pack.md");
  await fs.writeFile(outJson, JSON.stringify(report, null, 2), "utf8");

  const lines: string[] = [];
  lines.push("# V2 Structured Live Evidence Pack");
  lines.push("");
  lines.push(`- Generated: ${generatedAt}`);
  lines.push(`- Regime start: ${report.regime.regimeStart}`);
  lines.push(`- Regime start source: ${report.regime.regimeStartSource}`);
  lines.push("");
  lines.push("## A. Latest structured live regime report");
  lines.push("");
  lines.push("### Cohort summary");
  lines.push(`- total opens: ${overall.totalOpens}`);
  lines.push(`- total closed: ${overall.totalClosed}`);
  lines.push(`- close rate: ${pct(overall.closeRate)}`);
  lines.push(`- avg markout: ${fmt(overall.avgMarkout)}`);
  lines.push(`- median markout: ${fmt(overall.medianMarkout)}`);
  lines.push(`- total realized pnl dollars: ${fmt(overall.totalRealizedPnlDollars)}`);
  lines.push(`- win rate (markout>0 fallback pnlPct): ${pct(overall.winRate)}`);
  lines.push("");
  lines.push("### Performance by entry price band");
  lines.push("| price band | open count | closed count | avg markout | median markout | win rate | avg realized pnl% |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const r of priceBandRows) {
    lines.push(
      `| ${r.band} | ${r.openCount} | ${r.closedCount} | ${fmt(r.avgMarkout)} | ${fmt(r.medianMarkout)} | ${pct(r.winRate)} | ${fmt(r.avgRealizedPnlPct)} |`
    );
  }
  lines.push("");
  lines.push("### Structured score separation");
  lines.push("| score bucket | count | avg markout | median markout | win rate |");
  lines.push("| --- | ---: | ---: | ---: | ---: |");
  for (const r of scoreBucketRows) {
    lines.push(`| ${r.bucket} | ${r.count} | ${fmt(r.avgMarkout)} | ${fmt(r.medianMarkout)} | ${pct(r.winRate)} |`);
  }
  if (topBottomCompare) {
    lines.push("");
    lines.push(
      `- top-vs-bottom (each ${topBottomCompare.k} rows): avg markout ${fmt(topBottomCompare.top.avgMarkout)} vs ${fmt(topBottomCompare.bottom.avgMarkout)}, win rate ${pct(topBottomCompare.top.winRate)} vs ${pct(topBottomCompare.bottom.winRate)}`
    );
  }
  lines.push("");
  lines.push("### Cross section: price band x score bucket (cells with n>=3)");
  lines.push("| price band | score bucket | count | avg markout | win rate |");
  lines.push("| --- | --- | ---: | ---: | ---: |");
  for (const r of cross) {
    lines.push(`| ${r.priceBand} | ${r.scoreBucket} | ${r.count} | ${fmt(r.avgMarkout)} | ${pct(r.winRate)} |`);
  }
  lines.push("");
  lines.push("### Recent vs prior comparison");
  lines.push("| metric | latest regime closed | prior baseline closed (size-matched) |");
  lines.push("| --- | ---: | ---: |");
  lines.push(`| n closed | ${overall.totalClosed} | ${baseline.totalClosed} |`);
  lines.push(`| avg markout | ${fmt(overall.avgMarkout)} | ${fmt(baseline.avgMarkout)} |`);
  lines.push(`| median markout | ${fmt(overall.medianMarkout)} | ${fmt(baseline.medianMarkout)} |`);
  lines.push(`| win rate | ${pct(overall.winRate)} | ${pct(baseline.winRate)} |`);
  lines.push("");
  lines.push("## B. Recent tick / candidate mix report");
  lines.push("");
  lines.push(`- latest tick at: ${report.recentTickMix.latestTickAt ?? "-"}`);
  lines.push(`- tick window minutes used: ${report.recentTickMix.windowMinutesUsed ?? "-"}`);
  lines.push(`- funder used for load: ${report.recentTickMix.funderUsedForLoad ?? "-"}`);
  lines.push("");
  lines.push("### Candidate mix before filter");
  lines.push(`- total candidates: ${report.recentTickMix.candidateMixBeforeFilter.totalCandidates}`);
  lines.push(`- by price band: \`${JSON.stringify(report.recentTickMix.candidateMixBeforeFilter.byPriceBand)}\``);
  lines.push("");
  lines.push("### Candidate mix after filter");
  lines.push(`- total candidates: ${report.recentTickMix.candidateMixAfterFilter.totalCandidates}`);
  lines.push(`- by price band: \`${JSON.stringify(report.recentTickMix.candidateMixAfterFilter.byPriceBand)}\``);
  lines.push("");
  lines.push("### Admitted trades");
  lines.push(`- total admitted: ${report.recentTickMix.admittedTrades.total}`);
  lines.push(`- by price band: \`${JSON.stringify(report.recentTickMix.admittedTrades.byPriceBand)}\``);
  lines.push(`- by botType: \`${JSON.stringify(report.recentTickMix.admittedTrades.byBotType)}\``);
  lines.push(`- by botType x price band: \`${JSON.stringify(report.recentTickMix.admittedTrades.byBotTypeByPriceBand)}\``);
  lines.push("");
  lines.push("### Reject/noop reasons");
  lines.push(`- reject reasons: \`${JSON.stringify(report.recentTickMix.rejectReasons)}\``);
  lines.push(`- noop zeroCandidatesReason: ${report.recentTickMix.noopReasons.zeroCandidatesReason ?? "-"}`);
  lines.push("");
  lines.push("### Structured score distribution admitted vs rejected");
  lines.push(
    `- available: ${report.recentTickMix.structuredScoreDistribution.available}, admitted(mean=${fmt(
      report.recentTickMix.structuredScoreDistribution.admitted.mean
    )}, median=${fmt(report.recentTickMix.structuredScoreDistribution.admitted.median)}), rejected(mean=${fmt(
      report.recentTickMix.structuredScoreDistribution.rejected.mean
    )}, median=${fmt(report.recentTickMix.structuredScoreDistribution.rejected.median)})`
  );
  lines.push("");
  lines.push("## C. Closed cohort / ranking quality report");
  lines.push("");
  lines.push(`- winner count: ${report.closedCohortRankingQuality.winnerCount}`);
  lines.push(`- loser count: ${report.closedCohortRankingQuality.loserCount}`);
  lines.push(
    `- winner score mean/median: ${fmt(report.closedCohortRankingQuality.winnerScoreMean)} / ${fmt(report.closedCohortRankingQuality.winnerScoreMedian)}`
  );
  lines.push(
    `- loser score mean/median: ${fmt(report.closedCohortRankingQuality.loserScoreMean)} / ${fmt(report.closedCohortRankingQuality.loserScoreMedian)}`
  );
  lines.push("");
  lines.push("### In-band ranking quality");
  lines.push("| band | count | high-half avg outcome | low-half avg outcome | high-half win rate | low-half win rate | note |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | --- |");
  for (const r of report.closedCohortRankingQuality.inBandRankingQuality) {
    lines.push(
      `| ${r.band} | ${r.count} | ${"highHalfAvgOutcome" in r ? fmt(r.highHalfAvgOutcome ?? null) : "-"} | ${
        "lowHalfAvgOutcome" in r ? fmt(r.lowHalfAvgOutcome ?? null) : "-"
      } | ${"highHalfWinRate" in r ? pct(r.highHalfWinRate ?? null) : "-"} | ${
        "lowHalfWinRate" in r ? pct(r.lowHalfWinRate ?? null) : "-"
      } | ${"note" in r ? r.note : ""} |`
    );
  }
  lines.push("");
  lines.push("## Caveats");
  lines.push("- Latest tick report uses only persisted `PaperTradingState.lastOpenTickResultJson` (single latest tick, no historical tick table).");
  lines.push("- Candidate price bands in section B come from joining trace candidate IDs to `ShadowCandidate.intendedPrice`; rows without candidateId remain unknown band.");
  lines.push("- If `PAPER_V2_STRUCTURED_REGIME_SINCE` is unset, regime start is inferred from earliest `|v2|` dedupe key.");
  lines.push("- All outputs are read-only diagnostics; no strategy logic or runtime behavior changed.");
  await fs.writeFile(outMd, lines.join("\n"), "utf8");

  console.log(`Wrote ${outMd}`);
  console.log(`Wrote ${outJson}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
