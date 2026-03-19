/**
 * Paper relaxed cohort analysis: outcome quality, score/pnl distributions, splits by reason and score band.
 * Outputs: dump/paper-relaxed-cohort-analysis.json, dump/paper-relaxed-cohort-analysis.md
 * Run: npx tsx tools/create-paper-relaxed-cohort-analysis.ts
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import { getFunderForDecisionRecompute } from "../lib/decision/recompute";
import { getActiveOrApprovedShadowModel } from "../lib/ml/shadow-score";
import { getPaperTradingConfig } from "../lib/paper-trading/config";
import {
  ENTRY_PRICE_BAND_DEFINITIONS,
  classifyEntryPriceBand,
  parseEntryPrice,
} from "../lib/paper-trading/price-bands";

const DUMP_DIR = path.join(process.cwd(), "dump");

const SCORE_BANDS = [
  { label: "<0.3", min: 0, max: 0.3 },
  { label: "0.3-0.4", min: 0.3, max: 0.4 },
  { label: "0.4-0.5", min: 0.4, max: 0.5 },
  { label: "0.5-0.6", min: 0.5, max: 0.6 },
  { label: ">=0.6", min: 0.6, max: 2 },
] as const;

// Price band definitions and helpers are imported from shared paper-trading/price-bands.

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (i - lo) * (sorted[hi] - sorted[lo]);
}

function distStats(values: number[], pctKeys: number[] = [10, 25, 50, 75, 90]) {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const out: Record<string, number> = {
    count: sorted.length,
    min: sorted.length ? sorted[0] : 0,
    max: sorted.length ? sorted[sorted.length - 1] : 0,
    avg: sorted.length ? sum / sorted.length : 0,
  };
  for (const p of pctKeys) {
    out[`p${p}`] = percentile(sorted, p);
  }
  return out;
}

interface ClosedRow {
  openedAt: string;
  closedAt: string;
  marketTitle: string | null;
  marketSlug: string | null;
  side: string;
  entryPrice: string;
  exitPrice: string | null;
  modelScore: number;
  paperRelaxationReason: string | null;
  originalBlockingReasons: unknown;
  derivationSource: string | null;
  pnl: number | null;
  evaluationOutcome: string;
}

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });

  const timestamp = new Date().toISOString();
  const funder = await getFunderForDecisionRecompute();
  const active = await getActiveOrApprovedShadowModel();
  const config = getPaperTradingConfig();

  const allTrades = await prisma.paperTrade.findMany({
    orderBy: { entryTime: "desc" },
  });

  const normalTrades = allTrades.filter((t) => (t.paperPolicyMode ?? "normal") !== "relaxed_block_candidate");
  const relaxedTrades = allTrades.filter((t) => (t.paperPolicyMode ?? "") === "relaxed_block_candidate");
  const relaxedOpen = relaxedTrades.filter((t) => t.status === "open");
  const relaxedClosed = relaxedTrades.filter((t) => t.status === "closed");

  const relaxedScores = relaxedTrades.map((t) => t.score);
  const relaxedClosedPnls = relaxedClosed
    .map((t) => parseFloat(t.pnlPct ?? ""))
    .filter((n) => Number.isFinite(n));
  const wins = relaxedClosedPnls.filter((p) => p > 0).length;
  const losses = relaxedClosedPnls.filter((p) => p < 0).length;
  const flatOrUnknown = relaxedClosed.length - wins - losses;

  const scoreDist = distStats(relaxedScores, [10, 25, 50, 75, 90]);
  const pnlDist = distStats(relaxedClosedPnls, [10, 25, 50, 75, 90]);
  const avgPnl = relaxedClosedPnls.length ? relaxedClosedPnls.reduce((a, b) => a + b, 0) / relaxedClosedPnls.length : null;
  const medianPnl = relaxedClosedPnls.length ? percentile([...relaxedClosedPnls].sort((a, b) => a - b), 50) : null;

  const reasonKeys = [...new Set(relaxedTrades.map((t) => t.paperRelaxationReason ?? "unknown"))].sort();
  const byReason: Record<string, { opened: number; closed: number; winRate: number | null; avgPnl: number | null; medianPnl: number | null; cumulativePnl: number | null }> = {};
  for (const reason of reasonKeys) {
    const subset = relaxedTrades.filter((t) => (t.paperRelaxationReason ?? "unknown") === reason);
    const closedSub = subset.filter((t) => t.status === "closed");
    const pnls = closedSub.map((t) => parseFloat(t.pnlPct ?? "")).filter((n) => Number.isFinite(n));
    const w = pnls.filter((p) => p > 0).length;
    byReason[reason] = {
      opened: subset.length,
      closed: closedSub.length,
      winRate: pnls.length ? w / pnls.length : null,
      avgPnl: pnls.length ? pnls.reduce((a, b) => a + b, 0) / pnls.length : null,
      medianPnl: pnls.length ? percentile([...pnls].sort((a, b) => a - b), 50) : null,
      cumulativePnl: pnls.length ? pnls.reduce((a, b) => a + b, 0) : null,
    };
  }

  const byScoreBand: Record<string, { opened: number; closed: number; winRate: number | null; avgPnl: number | null; medianPnl: number | null; cumulativePnl: number | null }> = {};
  for (const b of SCORE_BANDS) {
    const subset = relaxedTrades.filter((t) => {
      const s = t.score;
      return s >= b.min && (b.max >= 2 || s < b.max);
    });
    const closedSub = subset.filter((t) => t.status === "closed");
    const pnls = closedSub.map((t) => parseFloat(t.pnlPct ?? "")).filter((n) => Number.isFinite(n));
    const w = pnls.filter((p) => p > 0).length;
    byScoreBand[b.label] = {
      opened: subset.length,
      closed: closedSub.length,
      winRate: pnls.length ? w / pnls.length : null,
      avgPnl: pnls.length ? pnls.reduce((a, b) => a + b, 0) / pnls.length : null,
      medianPnl: pnls.length ? percentile([...pnls].sort((a, b) => a - b), 50) : null,
      cumulativePnl: pnls.length ? pnls.reduce((a, b) => a + b, 0) : null,
    };
  }

  const marketIds = [...new Set(relaxedClosed.map((t) => t.marketId))];
  const markets = await prisma.syncedMarket.findMany({
    where: { id: { in: marketIds } },
    select: { id: true, title: true, slug: true },
  });
  const marketMap = new Map(markets.map((m) => [m.id, m]));

  const closedRows: ClosedRow[] = relaxedClosed.map((t) => {
    const meta = t.metadataJson ? (() => { try { return JSON.parse(t.metadataJson) as Record<string, unknown>; } catch { return {}; } })() : {};
    const m = marketMap.get(t.marketId);
    const pnl = t.pnlPct != null && Number.isFinite(parseFloat(t.pnlPct)) ? parseFloat(t.pnlPct) : null;
    let evaluationOutcome = "closed";
    if (pnl != null) {
      if (pnl > 0) evaluationOutcome = "win";
      else if (pnl < 0) evaluationOutcome = "loss";
      else evaluationOutcome = "flat";
    }
    return {
      openedAt: t.entryTime?.toISOString() ?? "",
      closedAt: t.exitTime?.toISOString() ?? "",
      marketTitle: m?.title ?? null,
      marketSlug: m?.slug ?? null,
      side: t.side,
      entryPrice: t.entryPrice,
      exitPrice: t.exitPrice,
      modelScore: t.score,
      paperRelaxationReason: t.paperRelaxationReason,
      originalBlockingReasons: t.originalBlockingReasons,
      derivationSource: (meta.derivationSource as string) ?? null,
      pnl,
      evaluationOutcome,
    };
  });

  const withPnl = closedRows.filter((r) => r.pnl != null) as (ClosedRow & { pnl: number })[];
  const sortedByPnl = [...withPnl].sort((a, b) => a.pnl - b.pnl);
  const worst20 = sortedByPnl.slice(0, 20);
  const best20 = sortedByPnl.slice(-20).reverse();

  // Entry price band: assign band to each relaxed trade; count excluded
  type RelaxedWithBand = { t: (typeof relaxedTrades)[0]; band: string };
  const relaxedWithBand: RelaxedWithBand[] = [];
  let excludedFromEntryPriceBandCount = 0;
  for (const t of relaxedTrades) {
    const price = parseEntryPrice(t.entryPrice);
    const band = classifyEntryPriceBand(price);
    if (band !== null) {
      relaxedWithBand.push({ t, band });
    } else {
      excludedFromEntryPriceBandCount++;
    }
  }

  type BandStats = {
    opened: number;
    closed: number;
    winRate: number | null;
    lossRate: number | null;
    flatOrUnknownRate: number | null;
    avgPnl: number | null;
    medianPnl: number | null;
    cumulativePnl: number | null;
    avgScore: number | null;
    medianScore: number | null;
  };
  const entryPriceBandStats: Record<string, BandStats> = {};
  for (const b of ENTRY_PRICE_BAND_DEFINITIONS) {
    const subset = relaxedWithBand.filter((x) => x.band === b.label).map((x) => x.t);
    const closedSub = subset.filter((t) => t.status === "closed");
    const pnls = closedSub.map((t) => parseFloat(t.pnlPct ?? "")).filter((n) => Number.isFinite(n));
    const wins = pnls.filter((p) => p > 0).length;
    const losses = pnls.filter((p) => p < 0).length;
    const flatOrUnknown = closedSub.length - wins - losses;
    const scores = subset.map((t) => t.score);
    entryPriceBandStats[b.label] = {
      opened: subset.length,
      closed: closedSub.length,
      winRate: pnls.length ? wins / pnls.length : null,
      lossRate: pnls.length ? losses / pnls.length : null,
      flatOrUnknownRate: closedSub.length ? flatOrUnknown / closedSub.length : null,
      avgPnl: pnls.length ? pnls.reduce((a, b) => a + b, 0) / pnls.length : null,
      medianPnl: pnls.length ? percentile([...pnls].sort((a, b) => a - b), 50) : null,
      cumulativePnl: pnls.length ? pnls.reduce((a, b) => a + b, 0) : null,
      avgScore: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
      medianScore: scores.length ? percentile([...scores].sort((a, b) => a - b), 50) : null,
    };
  }

  const entryPriceBandByRelaxationReason: Record<string, Record<string, { opened: number; closed: number; winRate: number | null; avgPnl: number | null; medianPnl: number | null; cumulativePnl: number | null; avgScore: number | null }>> = {};
  const allReasons = [...new Set(relaxedTrades.map((t) => t.paperRelaxationReason ?? "unknown"))].sort();
  for (const b of ENTRY_PRICE_BAND_DEFINITIONS) {
    entryPriceBandByRelaxationReason[b.label] = {};
    for (const reason of allReasons) {
      const subset = relaxedWithBand.filter((x) => x.band === b.label && (x.t.paperRelaxationReason ?? "unknown") === reason).map((x) => x.t);
      const closedSub = subset.filter((t) => t.status === "closed");
      const pnls = closedSub.map((t) => parseFloat(t.pnlPct ?? "")).filter((n) => Number.isFinite(n));
      const wins = pnls.filter((p) => p > 0).length;
      const scores = subset.map((t) => t.score);
      entryPriceBandByRelaxationReason[b.label][reason] = {
        opened: subset.length,
        closed: closedSub.length,
        winRate: pnls.length ? wins / pnls.length : null,
        avgPnl: pnls.length ? pnls.reduce((a, b) => a + b, 0) / pnls.length : null,
        medianPnl: pnls.length ? percentile([...pnls].sort((a, b) => a - b), 50) : null,
        cumulativePnl: pnls.length ? pnls.reduce((a, b) => a + b, 0) : null,
        avgScore: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
      };
    }
  }

  const analysis = {
    timestamp,
    activeFunder: funder ?? null,
    activeModelRunId: active?.run.id ?? null,
    activeTargetLabel: active?.run.targetLabel ?? null,
    threshold: config.threshold,
    totalPaperTrades: allTrades.length,
    totalNormalTrades: normalTrades.length,
    totalRelaxedTrades: relaxedTrades.length,
    relaxedOpenCount: relaxedOpen.length,
    relaxedClosedCount: relaxedClosed.length,
    relaxedOverall: {
      scoreDistribution: scoreDist,
      pnlDistributionClosed: relaxedClosedPnls.length ? distStats(relaxedClosedPnls, [10, 25, 50, 75, 90]) : { count: 0, min: 0, p10: 0, p25: 0, p50: 0, p75: 0, p90: 0, max: 0, avg: 0 },
      winRate: relaxedClosedPnls.length ? wins / relaxedClosedPnls.length : null,
      lossRate: relaxedClosedPnls.length ? losses / relaxedClosedPnls.length : null,
      flatOrUnknownRate: relaxedClosed.length ? (flatOrUnknown / relaxedClosed.length) : null,
      averagePnl: avgPnl,
      medianPnl: medianPnl,
    },
    byRelaxationReason: byReason,
    byScoreBand: byScoreBand,
    entryPriceBandDefinitions: ENTRY_PRICE_BAND_DEFINITIONS.map((b) => ({
      label: b.label,
      range: b.maxInclusive ? `[${b.min}, ${b.max}]` : `[${b.min}, ${b.max})`,
    })),
    excludedFromEntryPriceBandCount: excludedFromEntryPriceBandCount,
    entryPriceBandStats,
    entryPriceBandByRelaxationReason,
    worst20RelaxedClosed: worst20,
    best20RelaxedClosed: best20,
  };

  const jsonPath = path.join(DUMP_DIR, "paper-relaxed-cohort-analysis.json");
  await fs.writeFile(jsonPath, JSON.stringify(analysis, null, 2), "utf8");
  console.log("Wrote", jsonPath);

  const md = toMarkdown(analysis);
  const mdPath = path.join(DUMP_DIR, "paper-relaxed-cohort-analysis.md");
  await fs.writeFile(mdPath, md, "utf8");
  console.log("Wrote", mdPath);
}

function toMarkdown(a: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push("# Paper relaxed cohort analysis");
  lines.push("");
  lines.push("**Generated:** " + a.timestamp);
  lines.push("");
  lines.push("## Context");
  lines.push("- Active funder: " + (a.activeFunder ?? "—"));
  lines.push("- Model run ID: " + (a.activeModelRunId ?? "—"));
  lines.push("- Target: " + (a.activeTargetLabel ?? "—"));
  lines.push("- Threshold: " + a.threshold);
  lines.push("- Total paper trades: " + a.totalPaperTrades);
  lines.push("- Total normal: " + a.totalNormalTrades);
  lines.push("- Total relaxed: " + a.totalRelaxedTrades);
  lines.push("- Relaxed open: " + a.relaxedOpenCount);
  lines.push("- Relaxed closed: " + a.relaxedClosedCount);
  lines.push("");
  const overall = a.relaxedOverall as Record<string, unknown>;
  if (overall) {
    lines.push("## Relaxed overall");
    lines.push("- Score dist: " + JSON.stringify(overall.scoreDistribution));
    lines.push("- PnL dist (closed): " + JSON.stringify(overall.pnlDistributionClosed));
    lines.push("- Win rate: " + overall.winRate);
    lines.push("- Loss rate: " + overall.lossRate);
    lines.push("- Flat/unknown rate: " + overall.flatOrUnknownRate);
    lines.push("- Avg PnL: " + overall.averagePnl);
    lines.push("- Median PnL: " + overall.medianPnl);
    lines.push("");
  }
  lines.push("## By relaxation reason");
  lines.push("| Reason | opened | closed | winRate | avgPnl | medianPnl | cumulativePnl |");
  lines.push("|--------|--------|--------|---------|--------|-----------|---------------|");
  for (const [k, v] of Object.entries((a.byRelaxationReason as Record<string, Record<string, unknown>>) ?? {})) {
    const r = v;
    lines.push(`| ${k} | ${r.opened} | ${r.closed} | ${r.winRate ?? "—"} | ${r.avgPnl ?? "—"} | ${r.medianPnl ?? "—"} | ${r.cumulativePnl ?? "—"} |`);
  }
  lines.push("");
  lines.push("## By score band");
  lines.push("| Band | opened | closed | winRate | avgPnl | medianPnl | cumulativePnl |");
  lines.push("|------|--------|--------|---------|--------|-----------|---------------|");
  for (const [k, v] of Object.entries((a.byScoreBand as Record<string, Record<string, unknown>>) ?? {})) {
    const r = v;
    lines.push(`| ${k} | ${r.opened} | ${r.closed} | ${r.winRate ?? "—"} | ${r.avgPnl ?? "—"} | ${r.medianPnl ?? "—"} | ${r.cumulativePnl ?? "—"} |`);
  }
  lines.push("");
  lines.push("## Entry price band definitions");
  lines.push("Boundaries: [min, max) except last band [0.9, 1.0] inclusive. Excluded (null/invalid/outside 0..1): " + (a.excludedFromEntryPriceBandCount ?? 0));
  const defs = (a.entryPriceBandDefinitions as Array<{ label: string; range: string }>) ?? [];
  for (const d of defs) {
    lines.push("- " + d.label + " " + d.range);
  }
  lines.push("");
  lines.push("## Entry price band performance (relaxed overall)");
  const bandStats = (a.entryPriceBandStats as Record<string, Record<string, unknown>>) ?? {};
  lines.push("| Band | opened | closed | winRate | lossRate | flatOrUnknownRate | avgPnl | medianPnl | cumulativePnl | avgScore | medianScore |");
  lines.push("|------|--------|--------|---------|----------|-------------------|--------|-----------|---------------|----------|-------------|");
  for (const [k, v] of Object.entries(bandStats)) {
    const r = v;
    lines.push(`| ${k} | ${r.opened} | ${r.closed} | ${r.winRate ?? "—"} | ${r.lossRate ?? "—"} | ${r.flatOrUnknownRate ?? "—"} | ${r.avgPnl ?? "—"} | ${r.medianPnl ?? "—"} | ${r.cumulativePnl ?? "—"} | ${r.avgScore ?? "—"} | ${r.medianScore ?? "—"} |`);
  }
  lines.push("");
  lines.push("## Entry price band × relaxation reason");
  const bandByReason = (a.entryPriceBandByRelaxationReason as Record<string, Record<string, Record<string, unknown>>>) ?? {};
  for (const [bandLabel, byReason] of Object.entries(bandByReason)) {
    lines.push("### Band " + bandLabel);
    lines.push("| Reason | opened | closed | winRate | avgPnl | medianPnl | cumulativePnl | avgScore |");
    lines.push("|--------|--------|--------|---------|--------|-----------|---------------|----------|");
    for (const [reason, r] of Object.entries(byReason)) {
      lines.push(`| ${reason} | ${r.opened} | ${r.closed} | ${r.winRate ?? "—"} | ${r.avgPnl ?? "—"} | ${r.medianPnl ?? "—"} | ${r.cumulativePnl ?? "—"} | ${r.avgScore ?? "—"} |`);
    }
    lines.push("");
  }
  lines.push("## Worst 20 relaxed closed");
  const worst = (a.worst20RelaxedClosed as ClosedRow[]) ?? [];
  if (worst.length) {
    lines.push("| openedAt | closedAt | marketTitle | marketSlug | side | entryPrice | exitPrice | modelScore | paperRelaxationReason | pnl | evaluationOutcome | derivationSource |");
    lines.push("|----------|----------|-------------|------------|------|------------|-----------|------------|----------------------|-----|-------------------|-----------------|");
    for (const r of worst) {
      lines.push(`| ${r.openedAt} | ${r.closedAt} | ${(r.marketTitle ?? "").slice(0, 40)} | ${(r.marketSlug ?? "").slice(0, 30)} | ${r.side} | ${r.entryPrice} | ${r.exitPrice ?? "—"} | ${r.modelScore} | ${r.paperRelaxationReason ?? "—"} | ${r.pnl ?? "—"} | ${r.evaluationOutcome} | ${r.derivationSource ?? "—"} |`);
    }
  } else {
    lines.push("(none)");
  }
  lines.push("");
  lines.push("## Best 20 relaxed closed");
  const best = (a.best20RelaxedClosed as ClosedRow[]) ?? [];
  if (best.length) {
    lines.push("| openedAt | closedAt | marketTitle | marketSlug | side | entryPrice | exitPrice | modelScore | paperRelaxationReason | pnl | evaluationOutcome | derivationSource |");
    lines.push("|----------|----------|-------------|------------|------|------------|-----------|------------|----------------------|-----|-------------------|-----------------|");
    for (const r of best) {
      lines.push(`| ${r.openedAt} | ${r.closedAt} | ${(r.marketTitle ?? "").slice(0, 40)} | ${(r.marketSlug ?? "").slice(0, 30)} | ${r.side} | ${r.entryPrice} | ${r.exitPrice ?? "—"} | ${r.modelScore} | ${r.paperRelaxationReason ?? "—"} | ${r.pnl ?? "—"} | ${r.evaluationOutcome} | ${r.derivationSource ?? "—"} |`);
    }
  } else {
    lines.push("(none)");
  }
  return lines.join("\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
