/**
 * Post-policy signal impact report (read-only).
 * Evaluates signal mix + expectancy on post-fix cohort, with a same-size pre-cutoff baseline.
 */
import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";

const DUMP_DIR = path.join(process.cwd(), "dump");
const OUT_JSON = path.join(DUMP_DIR, "post-policy-signal-impact-report.json");
const OUT_MD = path.join(DUMP_DIR, "post-policy-signal-impact-report.md");
const OUT_CHAT = path.join(DUMP_DIR, "post-policy-signal-impact-report-chat-summary.md");

const AFTER_RAW = process.env.POSTFIX_LINKAGE_AFTER?.trim();
const N = Math.min(5000, Math.max(20, Number(process.env.POST_POLICY_SIGNAL_IMPACT_N ?? "200") || 200));

type PaperTradeRow = {
  id: string;
  entryTime: Date;
  botType: string;
  metadataJson: string | null;
  markout12h: string | null;
  pnlPct: string | null;
};

type SignalStats = {
  signalType: string;
  count: number;
  shareOfTrades: number;
  avgMarkout: number | null;
  positiveRate: number | null;
  medianMarkout: number | null;
};

function parseNum(v: string | null | undefined): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toMarkoutProxy(markout12h: string | null, pnlPct: string | null): number | null {
  return parseNum(markout12h) ?? parseNum(pnlPct);
}

function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

function resolveSignalType(metadataJson: string | null): string {
  if (!metadataJson) return "unknown";
  try {
    const o = JSON.parse(metadataJson) as Record<string, unknown>;
    const open = (o.openAttribution ?? {}) as Record<string, unknown>;
    const exec = (open.executionContext ?? {}) as Record<string, unknown>;
    const cands = [
      exec.policyState,
      o.signalType,
      o.derivationSource,
      o.candidateSource,
      o.executionPolicyState,
    ];
    for (const c of cands) {
      if (typeof c === "string" && c.trim()) return c.trim().toLowerCase();
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}

function summarizeSignalMix(rows: Array<{ signalType: string; markout: number | null }>): SignalStats[] {
  const bySignal = new Map<string, number[]>();
  const total = rows.length;
  for (const r of rows) {
    const arr = bySignal.get(r.signalType) ?? [];
    if (r.markout != null && Number.isFinite(r.markout)) arr.push(r.markout);
    bySignal.set(r.signalType, arr);
  }
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.signalType, (counts.get(r.signalType) ?? 0) + 1);

  const stats: SignalStats[] = [...counts.entries()].map(([signalType, count]) => {
    const vals = (bySignal.get(signalType) ?? []).slice().sort((a, b) => a - b);
    return {
      signalType,
      count,
      shareOfTrades: total > 0 ? count / total : 0,
      avgMarkout: vals.length ? vals.reduce((a, c) => a + c, 0) / vals.length : null,
      positiveRate: vals.length ? vals.filter((x) => x > 0).length / vals.length : null,
      medianMarkout: quantile(vals, 0.5),
    };
  });
  stats.sort((a, b) => b.count - a.count || a.signalType.localeCompare(b.signalType));
  return stats;
}

function summarizeOverall(rows: Array<{ signalType: string; markout: number | null }>) {
  const vals = rows.map((r) => r.markout).filter((x): x is number => x != null && Number.isFinite(x));
  const total = rows.length;
  const share = (k: string) => (total ? rows.filter((r) => r.signalType === k).length / total : 0);
  return {
    overallAvgMarkout: vals.length ? vals.reduce((a, c) => a + c, 0) / vals.length : null,
    overallPositiveRate: vals.length ? vals.filter((x) => x > 0).length / vals.length : null,
    allowShare: share("allow"),
    warnShare: share("warn"),
    unknownShare: share("unknown"),
  };
}

function summarizePerBot(
  rows: Array<{ botType: string; signalType: string; markout: number | null }>
): Array<{
  botType: string;
  count: number;
  avgMarkout: number | null;
  positiveRate: number | null;
  signalMix: Array<{ signalType: string; count: number; share: number }>;
}> {
  const byBot = new Map<string, typeof rows>();
  for (const r of rows) {
    const arr = byBot.get(r.botType) ?? [];
    arr.push(r);
    byBot.set(r.botType, arr);
  }
  const out: Array<{
    botType: string;
    count: number;
    avgMarkout: number | null;
    positiveRate: number | null;
    signalMix: Array<{ signalType: string; count: number; share: number }>;
  }> = [];
  for (const [botType, botRows] of byBot.entries()) {
    const vals = botRows.map((r) => r.markout).filter((x): x is number => x != null && Number.isFinite(x));
    const mixCounts = new Map<string, number>();
    for (const r of botRows) mixCounts.set(r.signalType, (mixCounts.get(r.signalType) ?? 0) + 1);
    const signalMix = [...mixCounts.entries()]
      .map(([signalType, count]) => ({
        signalType,
        count,
        share: botRows.length ? count / botRows.length : 0,
      }))
      .sort((a, b) => b.count - a.count || a.signalType.localeCompare(b.signalType));
    out.push({
      botType,
      count: botRows.length,
      avgMarkout: vals.length ? vals.reduce((a, c) => a + c, 0) / vals.length : null,
      positiveRate: vals.length ? vals.filter((x) => x > 0).length / vals.length : null,
      signalMix,
    });
  }
  out.sort((a, b) => b.count - a.count || a.botType.localeCompare(b.botType));
  return out;
}

function pct(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "n/a";
  return `${(n * 100).toFixed(1)}%`;
}

function num(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "n/a";
  return n.toFixed(4);
}

async function main(): Promise<void> {
  if (!AFTER_RAW) {
    console.error("POSTFIX_LINKAGE_AFTER is required.");
    process.exit(1);
  }
  const cutoff = new Date(AFTER_RAW);
  if (Number.isNaN(cutoff.getTime())) {
    console.error("POSTFIX_LINKAGE_AFTER invalid ISO date:", AFTER_RAW);
    process.exit(1);
  }

  await fs.mkdir(DUMP_DIR, { recursive: true });

  const postRows = (await prisma.paperTrade.findMany({
    where: { entryTime: { gte: cutoff } },
    orderBy: { entryTime: "desc" },
    take: N,
    select: {
      id: true,
      entryTime: true,
      botType: true,
      metadataJson: true,
      markout12h: true,
      pnlPct: true,
    },
  })) as PaperTradeRow[];

  const preRows = (await prisma.paperTrade.findMany({
    where: { entryTime: { lt: cutoff } },
    orderBy: { entryTime: "desc" },
    take: Math.max(50, postRows.length || N),
    select: {
      id: true,
      entryTime: true,
      botType: true,
      metadataJson: true,
      markout12h: true,
      pnlPct: true,
    },
  })) as PaperTradeRow[];

  const post = postRows.map((r) => ({
    paperTradeId: r.id,
    entryTime: r.entryTime.toISOString(),
    botType: r.botType || "unknown",
    signalType: resolveSignalType(r.metadataJson),
    markout: toMarkoutProxy(r.markout12h, r.pnlPct),
  }));
  const pre = preRows.map((r) => ({
    paperTradeId: r.id,
    entryTime: r.entryTime.toISOString(),
    botType: r.botType || "unknown",
    signalType: resolveSignalType(r.metadataJson),
    markout: toMarkoutProxy(r.markout12h, r.pnlPct),
  }));

  const rowsWithMarkout = post.filter((r) => r.markout != null).length;
  const postSignalMix = summarizeSignalMix(post);
  const overallPost = summarizeOverall(post);
  const overallPre = summarizeOverall(pre);
  const perBot = summarizePerBot(post);

  const dominantSignalAfterPolicy = postSignalMix.length ? postSignalMix[0]!.signalType : "unknown";
  const didAllowExposureDrop = overallPost.allowShare < overallPre.allowShare;
  const didOverallExpectancyImprove =
    overallPost.overallAvgMarkout != null &&
    overallPre.overallAvgMarkout != null &&
    overallPost.overallAvgMarkout > overallPre.overallAvgMarkout;

  const recommendation = (() => {
    if (!rowsWithMarkout || rowsWithMarkout < 30) return "collect more data";
    if (overallPost.overallAvgMarkout != null && overallPost.overallAvgMarkout > 0 && didAllowExposureDrop) {
      return "keep policy";
    }
    if (overallPost.allowShare > 0.2 && (overallPost.overallAvgMarkout ?? -1) < 0) return "hard-disable allow";
    if ((overallPost.overallAvgMarkout ?? -1) < 0 && overallPost.allowShare > 0.05) return "further penalize allow";
    if ((overallPost.unknownShare > overallPost.allowShare && (overallPost.overallAvgMarkout ?? -1) > 0)) {
      return "promote unknown";
    }
    return "collect more data";
  })();

  const report = {
    generatedAt: new Date().toISOString(),
    env: {
      POSTFIX_LINKAGE_AFTER: AFTER_RAW,
      POST_POLICY_SIGNAL_IMPACT_N: N,
    },
    scope: {
      cutoffUsed: cutoff.toISOString(),
      paperRowsScanned: post.length,
      rowsWithMarkoutOrPnl: rowsWithMarkout,
      baselineRowsBeforeCutoff: pre.length,
    },
    signalMixAfterPolicy: postSignalMix,
    overallImpact: {
      ...overallPost,
      baselineBeforeCutoff: overallPre,
    },
    perBotImpact: perBot,
    interpretation: {
      didAllowExposureDrop,
      didOverallExpectancyImprove,
      dominantSignalAfterPolicy,
      recommendation,
    },
    samples: {
      post: post.slice(0, 40),
      baselineBeforeCutoff: pre.slice(0, 40),
    },
  };

  await fs.writeFile(OUT_JSON, JSON.stringify(report, null, 2), "utf8");

  const md = [
    "# Post-Policy Signal Impact Report",
    "",
    "## A) Scope",
    `- cutoff used: ${report.scope.cutoffUsed}`,
    `- paper rows scanned: ${report.scope.paperRowsScanned}`,
    `- rows with markout/pnl: ${report.scope.rowsWithMarkoutOrPnl}`,
    `- baseline rows before cutoff: ${report.scope.baselineRowsBeforeCutoff}`,
    "",
    "## B) Signal Mix After Policy",
    ...report.signalMixAfterPolicy.map(
      (s) =>
        `- ${s.signalType}: n=${s.count}, share=${pct(s.shareOfTrades)}, avg=${num(s.avgMarkout)}, positive=${pct(
          s.positiveRate
        )}, median=${num(s.medianMarkout)}`
    ),
    "",
    "## C) Overall Impact",
    `- overall avg markout: ${num(report.overallImpact.overallAvgMarkout)}`,
    `- overall positive rate: ${pct(report.overallImpact.overallPositiveRate)}`,
    `- allowShare: ${pct(report.overallImpact.allowShare)}`,
    `- warnShare: ${pct(report.overallImpact.warnShare)}`,
    `- unknownShare: ${pct(report.overallImpact.unknownShare)}`,
    `- baseline avg markout (before cutoff): ${num(report.overallImpact.baselineBeforeCutoff.overallAvgMarkout)}`,
    `- baseline allowShare (before cutoff): ${pct(report.overallImpact.baselineBeforeCutoff.allowShare)}`,
    "",
    "## D) Per-Bot Impact",
    ...report.perBotImpact.map(
      (b) =>
        `- ${b.botType}: n=${b.count}, avg=${num(b.avgMarkout)}, positive=${pct(b.positiveRate)}, top mix=${b.signalMix
          .slice(0, 3)
          .map((x) => `${x.signalType}:${pct(x.share)}`)
          .join(", ")}`
    ),
    "",
    "## E) Interpretation",
    `- didAllowExposureDrop: ${report.interpretation.didAllowExposureDrop ? "yes" : "no"}`,
    `- didOverallExpectancyImprove: ${report.interpretation.didOverallExpectancyImprove ? "yes" : "no"}`,
    `- dominantSignalAfterPolicy: ${report.interpretation.dominantSignalAfterPolicy}`,
    `- recommendation: ${report.interpretation.recommendation}`,
    "",
    `- full JSON: \`dump/post-policy-signal-impact-report.json\``,
  ].join("\n");

  await fs.writeFile(OUT_MD, md, "utf8");

  const chat = [
    "# Post-Policy Signal Impact (Chat Summary)",
    "",
    `- rows scanned: ${report.scope.paperRowsScanned} (with markout/pnl: ${report.scope.rowsWithMarkoutOrPnl})`,
    `- allow share: ${pct(report.overallImpact.allowShare)} (baseline ${pct(
      report.overallImpact.baselineBeforeCutoff.allowShare
    )})`,
    `- unknown share: ${pct(report.overallImpact.unknownShare)}`,
    `- overall avg markout: ${num(report.overallImpact.overallAvgMarkout)} (baseline ${num(
      report.overallImpact.baselineBeforeCutoff.overallAvgMarkout
    )})`,
    `- overall positive rate: ${pct(report.overallImpact.overallPositiveRate)}`,
    `- didAllowExposureDrop: ${report.interpretation.didAllowExposureDrop ? "yes" : "no"}`,
    `- didOverallExpectancyImprove: ${report.interpretation.didOverallExpectancyImprove ? "yes" : "no"}`,
    `- dominant signal: ${report.interpretation.dominantSignalAfterPolicy}`,
    `- recommendation: ${report.interpretation.recommendation}`,
    "",
    "- paste this file back into chat: `dump/post-policy-signal-impact-report-chat-summary.md`",
  ].join("\n");

  await fs.writeFile(OUT_CHAT, chat, "utf8");

  console.log("[post-policy-signal-impact-report]");
  console.log("rows scanned:", report.scope.paperRowsScanned);
  console.log("allow share:", pct(report.overallImpact.allowShare));
  console.log("unknown share:", pct(report.overallImpact.unknownShare));
  console.log("overall avg markout:", num(report.overallImpact.overallAvgMarkout));
  console.log("overall positive rate:", pct(report.overallImpact.overallPositiveRate));
  console.log("recommendation:", report.interpretation.recommendation);
  console.log("output files:", OUT_JSON, OUT_MD, OUT_CHAT);
}

main().catch((err) => {
  console.error("[post-policy-signal-impact-report] failed", err);
  process.exitCode = 1;
});

