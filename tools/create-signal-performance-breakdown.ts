/**
 * Read-only signal performance breakdown.
 * Computes signal-type statistics and grouped cuts by botType / market category.
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import { parseOpenAttributionFromMetadataJson } from "../lib/paper-trading/paper-trade-open-attribution";

const DUMP_DIR = path.join(process.cwd(), "dump");
const OUT_JSON = path.join(DUMP_DIR, "signal-performance-breakdown.json");
const OUT_MD = path.join(DUMP_DIR, "signal-performance-breakdown.md");
const OUT_CHAT = path.join(DUMP_DIR, "signal-performance-breakdown-chat-summary.md");

const N = Math.min(20000, Math.max(50, Number(process.env.SIGNAL_PERFORMANCE_BREAKDOWN_N ?? "2000") || 2000));

function parseNum(v: string | null | undefined): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

function stddevSample(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((a, c) => a + c, 0) / values.length;
  const varN = values.reduce((a, c) => a + (c - mean) * (c - mean), 0) / (values.length - 1);
  return Math.sqrt(varN);
}

function resolveSignalType(metadataJson: string | null): string {
  if (!metadataJson) return "unknown";
  try {
    const o = JSON.parse(metadataJson) as Record<string, unknown>;
    const open = parseOpenAttributionFromMetadataJson(metadataJson);
    const cands = [
      o.signalType,
      o.derivationSource,
      o.candidateSource,
      open?.executionContext?.policyState,
    ];
    for (const v of cands) {
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}

type Trade = {
  signalType: string;
  botType: string;
  category: string;
  markout: number;
};

function computeStats(rows: Trade[]) {
  const vals = rows.map((r) => r.markout).filter((x) => Number.isFinite(x));
  const s = [...vals].sort((a, b) => a - b);
  return {
    count: vals.length,
    avgMarkout12h: vals.length ? vals.reduce((a, c) => a + c, 0) / vals.length : null,
    positiveRate: vals.length ? vals.filter((x) => x > 0).length / vals.length : null,
    medianMarkout: quantile(s, 0.5),
    stdDeviation: stddevSample(vals),
  };
}

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });

  const rows = await prisma.paperTrade.findMany({
    where: { status: "closed" },
    orderBy: { entryTime: "desc" },
    take: N,
    select: {
      metadataJson: true,
      botType: true,
      category: true,
      markout12h: true,
      pnlPct: true,
    },
  });

  const trades: Trade[] = [];
  for (const r of rows) {
    const m = parseNum(r.markout12h) ?? parseNum(r.pnlPct);
    if (m == null) continue;
    trades.push({
      signalType: resolveSignalType(r.metadataJson),
      botType: r.botType || "unknown",
      category: r.category || "unknown",
      markout: m,
    });
  }

  const signalGroups = new Map<string, Trade[]>();
  const byBotThenSignal = new Map<string, Map<string, Trade[]>>();
  const byCategoryThenSignal = new Map<string, Map<string, Trade[]>>();

  for (const t of trades) {
    const sg = signalGroups.get(t.signalType) ?? [];
    sg.push(t);
    signalGroups.set(t.signalType, sg);

    const botMap = byBotThenSignal.get(t.botType) ?? new Map<string, Trade[]>();
    const botArr = botMap.get(t.signalType) ?? [];
    botArr.push(t);
    botMap.set(t.signalType, botArr);
    byBotThenSignal.set(t.botType, botMap);

    const catMap = byCategoryThenSignal.get(t.category) ?? new Map<string, Trade[]>();
    const catArr = catMap.get(t.signalType) ?? [];
    catArr.push(t);
    catMap.set(t.signalType, catArr);
    byCategoryThenSignal.set(t.category, catMap);
  }

  const signalStats = [...signalGroups.entries()].map(([signalType, g]) => ({
    signalType,
    ...computeStats(g),
  }));

  const topBestSignals = [...signalStats]
    .filter((x) => x.count >= 5 && x.avgMarkout12h != null)
    .sort((a, b) => (b.avgMarkout12h ?? 0) - (a.avgMarkout12h ?? 0))
    .slice(0, 5);
  const topWorstSignals = [...signalStats]
    .filter((x) => x.count >= 5 && x.avgMarkout12h != null)
    .sort((a, b) => (a.avgMarkout12h ?? 0) - (b.avgMarkout12h ?? 0))
    .slice(0, 5);
  const negativeExpectancySignals = [...signalStats]
    .filter((x) => x.count >= 5 && (x.avgMarkout12h ?? 0) < 0)
    .sort((a, b) => (a.avgMarkout12h ?? 0) - (b.avgMarkout12h ?? 0));

  const botGrouped = [...byBotThenSignal.entries()].map(([botType, sigMap]) => ({
    botType,
    signals: [...sigMap.entries()].map(([signalType, g]) => ({
      signalType,
      ...computeStats(g),
    })),
  }));
  const categoryGrouped = [...byCategoryThenSignal.entries()].map(([marketCategory, sigMap]) => ({
    marketCategory,
    signals: [...sigMap.entries()].map(([signalType, g]) => ({
      signalType,
      ...computeStats(g),
    })),
  }));

  const report = {
    generatedAt: new Date().toISOString(),
    rowsScanned: rows.length,
    rowsWithMarkoutOrPnl: trades.length,
    bySignalType: signalStats,
    groupedByBotType: botGrouped,
    groupedByMarketCategory: categoryGrouped,
    top5BestSignals: topBestSignals,
    top5WorstSignals: topWorstSignals,
    signalsWithNegativeExpectancy: negativeExpectancySignals,
  };

  await fs.writeFile(OUT_JSON, JSON.stringify(report, null, 2), "utf8");

  const md = [
    "# Signal performance breakdown",
    "",
    `Rows scanned: **${rows.length}**, with markout/pnl: **${trades.length}**`,
    "",
    "## Top 5 best signals",
    ...topBestSignals.map(
      (x) =>
        `- ${x.signalType}: avg=${x.avgMarkout12h}, posRate=${x.positiveRate == null ? "—" : (100 * x.positiveRate).toFixed(1) + "%"}, n=${x.count}`
    ),
    "",
    "## Top 5 worst signals",
    ...topWorstSignals.map(
      (x) =>
        `- ${x.signalType}: avg=${x.avgMarkout12h}, posRate=${x.positiveRate == null ? "—" : (100 * x.positiveRate).toFixed(1) + "%"}, n=${x.count}`
    ),
    "",
    "## Negative expectancy signals",
    ...negativeExpectancySignals.map((x) => `- ${x.signalType}: avg=${x.avgMarkout12h}, n=${x.count}`),
    "",
    `JSON: \`${OUT_JSON}\``,
  ].join("\n");
  await fs.writeFile(OUT_MD, md, "utf8");

  const chat = [
    "## Signal performance breakdown",
    `- rows with markout/pnl: **${trades.length}**`,
    `- top best: ${topBestSignals.map((x) => x.signalType).join(", ") || "none"}`,
    `- top worst: ${topWorstSignals.map((x) => x.signalType).join(", ") || "none"}`,
    `- negative expectancy signals: **${negativeExpectancySignals.length}**`,
    "- files: `dump/signal-performance-breakdown.{json,md,-chat-summary.md}`",
  ].join("\n");
  await fs.writeFile(OUT_CHAT, chat, "utf8");

  console.log("[signal-performance-breakdown]", {
    rowsWithMarkoutOrPnl: trades.length,
    signalTypes: signalStats.length,
    topBestSignals: topBestSignals.map((x) => x.signalType),
    topWorstSignals: topWorstSignals.map((x) => x.signalType),
    negativeExpectancySignals: negativeExpectancySignals.length,
    outputs: [OUT_JSON, OUT_MD, OUT_CHAT],
  });
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});

