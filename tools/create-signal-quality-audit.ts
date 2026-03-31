/**
 * Read-only signal-quality audit (independent of ML gating).
 * Aggregates realized markout quality by signal context extracted from paper trades.
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import { parseOpenAttributionFromMetadataJson } from "../lib/paper-trading/paper-trade-open-attribution";

const DUMP_DIR = path.join(process.cwd(), "dump");
const OUT_JSON = path.join(DUMP_DIR, "signal-quality-audit.json");
const OUT_MD = path.join(DUMP_DIR, "signal-quality-audit.md");
const OUT_CHAT = path.join(DUMP_DIR, "signal-quality-audit-chat-summary.md");

const N = Math.min(10000, Math.max(50, Number(process.env.SIGNAL_QUALITY_AUDIT_N ?? "500") || 500));

function parseNum(s: string | null | undefined): number | null {
  if (s == null || s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function toHorizonBucket(timeToCloseHours: string | null | undefined): string {
  const h = parseNum(timeToCloseHours);
  if (h == null) return "unknown";
  if (h <= 12) return "0-12h";
  if (h <= 48) return "12-48h";
  if (h <= 168) return "2-7d";
  return ">7d";
}

function resolveSignalType(metadataJson: string | null): string {
  if (!metadataJson) return "unknown";
  try {
    const o = JSON.parse(metadataJson) as Record<string, unknown>;
    const cands = [
      o.signalType,
      o.derivationSource,
      o.candidateSource,
      (o.openAttribution as Record<string, unknown> | undefined)?.derivationSource,
    ];
    for (const v of cands) {
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}

type TradeRow = {
  id: string;
  entryTime: Date;
  marketId: string;
  assetId: string;
  side: string;
  category: string | null;
  entryPriceBand: string | null;
  score: number;
  metadataJson: string | null;
  markout12h: string | null;
  pnlPct: string | null;
};

function avg(values: number[]): number | null {
  return values.length ? values.reduce((a, c) => a + c, 0) / values.length : null;
}

function summarizeMarkout(rows: Array<{ markout: number | null }>) {
  const vals = rows.map((r) => r.markout).filter((x): x is number => x != null && Number.isFinite(x));
  return {
    n: rows.length,
    nWithMarkout: vals.length,
    avgMarkout: avg(vals),
    positiveRate: vals.length ? vals.filter((x) => x > 0).length / vals.length : null,
  };
}

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });

  const trades = (await prisma.paperTrade.findMany({
    where: { status: "closed" },
    orderBy: { entryTime: "desc" },
    take: N,
    select: {
      id: true,
      entryTime: true,
      marketId: true,
      assetId: true,
      side: true,
      category: true,
      entryPriceBand: true,
      score: true,
      metadataJson: true,
      markout12h: true,
      pnlPct: true,
    },
  })) as TradeRow[];

  const perTrade = trades.map((t) => {
    const attr = parseOpenAttributionFromMetadataJson(t.metadataJson);
    const signalType = resolveSignalType(t.metadataJson);
    const edgeEstimate = attr?.score ?? (Number.isFinite(t.score) ? t.score : null);
    const liquidityScore = attr?.executionContext?.tradable;
    const marketConditions = {
      qualityState: attr?.executionContext?.qualityState ?? null,
      policyState: attr?.executionContext?.policyState ?? null,
      tradable: attr?.executionContext?.tradable ?? null,
    };
    const timeToResolution =
      attr?.pathFeatureSummary?.timeToCloseHours != null
        ? String(attr.pathFeatureSummary.timeToCloseHours)
        : null;
    const spreadBps =
      attr?.paperRoiAdmission?.spreadBpsAtAdmission ?? attr?.executionContext?.spreadBps ?? null;
    const markout = parseNum(t.markout12h) ?? parseNum(t.pnlPct);
    return {
      paperTradeId: t.id,
      entryTime: t.entryTime.toISOString(),
      signalType,
      edgeEstimate,
      liquidityScore,
      marketConditions,
      timeToResolutionHours: timeToResolution,
      spreadBps,
      priceBand: t.entryPriceBand ?? null,
      marketCategory: t.category ?? "unknown",
      markout,
      side: t.side,
      assetId: t.assetId,
      marketId: t.marketId,
    };
  });

  const bySignalType = new Map<string, typeof perTrade>();
  const byCategory = new Map<string, typeof perTrade>();
  const byHorizon = new Map<string, typeof perTrade>();
  for (const r of perTrade) {
    const sArr = bySignalType.get(r.signalType) ?? [];
    sArr.push(r);
    bySignalType.set(r.signalType, sArr);

    const cArr = byCategory.get(r.marketCategory) ?? [];
    cArr.push(r);
    byCategory.set(r.marketCategory, cArr);

    const h = toHorizonBucket(r.timeToResolutionHours);
    const hArr = byHorizon.get(h) ?? [];
    hArr.push(r);
    byHorizon.set(h, hArr);
  }

  const signalTypeStats = [...bySignalType.entries()].map(([signalType, rows]) => ({
    signalType,
    ...summarizeMarkout(rows),
  }));
  const categoryStats = [...byCategory.entries()].map(([marketCategory, rows]) => ({
    marketCategory,
    ...summarizeMarkout(rows),
  }));
  const horizonStats = [...byHorizon.entries()].map(([horizonBucket, rows]) => ({
    horizonBucket,
    ...summarizeMarkout(rows),
  }));

  const topWorstSignals = [...signalTypeStats]
    .filter((x) => x.nWithMarkout >= 5 && x.avgMarkout != null)
    .sort((a, b) => (a.avgMarkout ?? 0) - (b.avgMarkout ?? 0))
    .slice(0, 10);

  const report = {
    generatedAt: new Date().toISOString(),
    rowsAnalyzed: perTrade.length,
    dataNotes: {
      closedOnly: true,
      markoutFieldPriority: "markout12h then pnlPct fallback",
      signalTypeResolution: "metadata.signalType -> metadata.derivationSource -> metadata.candidateSource -> openAttribution.derivationSource -> unknown",
      liquidityScoreType: "executionContext.tradable (boolean/null)",
      edgeEstimateSource: "openAttribution.score fallback PaperTrade.score",
    },
    perTrade,
    grouped: {
      bySignalType: signalTypeStats,
      byMarketCategory: categoryStats,
      byTimeHorizon: horizonStats,
    },
    topWorstSignals,
  };

  await fs.writeFile(OUT_JSON, JSON.stringify(report, null, 2), "utf8");

  const md = [
    "# Signal quality audit",
    "",
    `Rows analyzed: **${perTrade.length}** (closed paper trades)`,
    "",
    "## Avg markout by signal type",
    ...signalTypeStats
      .sort((a, b) => (b.nWithMarkout - a.nWithMarkout) || ((b.avgMarkout ?? -999) - (a.avgMarkout ?? -999)))
      .map(
        (x) =>
          `- ${x.signalType}: n=${x.n}, withMarkout=${x.nWithMarkout}, avg=${x.avgMarkout ?? "—"}, positiveRate=${x.positiveRate == null ? "—" : (100 * x.positiveRate).toFixed(1) + "%"}`
      ),
    "",
    "## Top worst signals",
    ...topWorstSignals.map(
      (x) =>
        `- ${x.signalType}: avgMarkout=${x.avgMarkout}, positiveRate=${x.positiveRate == null ? "—" : (100 * x.positiveRate).toFixed(1) + "%"}, nWithMarkout=${x.nWithMarkout}`
    ),
    "",
    `JSON: \`${OUT_JSON}\``,
  ].join("\n");
  await fs.writeFile(OUT_MD, md, "utf8");

  const chat = [
    "## Signal quality audit",
    `- rows analyzed: **${perTrade.length}**`,
    `- signal types found: **${signalTypeStats.length}**`,
    `- worst signals: ${topWorstSignals.map((x) => x.signalType).join(", ") || "none"}`,
    "- see `dump/signal-quality-audit.json` for full per-trade fields and grouped metrics",
  ].join("\n");
  await fs.writeFile(OUT_CHAT, chat, "utf8");

  console.log("[signal-quality-audit]", {
    rowsAnalyzed: perTrade.length,
    signalTypeGroups: signalTypeStats.length,
    topWorstSignals: topWorstSignals.map((x) => x.signalType),
    outputs: [OUT_JSON, OUT_MD, OUT_CHAT],
  });
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});

