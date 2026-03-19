/**
 * Paper relaxed trades review: counts, PnL, score distribution, top 25 relaxed with provenance.
 * Outputs: dump/paper-relaxed-trades-review.json, dump/paper-relaxed-trades-review.md
 * Run: npx tsx tools/create-paper-relaxed-trades-review.ts
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import { classifyEntryPriceBand, parseEntryPrice } from "../lib/paper-trading/price-bands";

const DUMP_DIR = path.join(process.cwd(), "dump");

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (i - lo) * (sorted[hi] - sorted[lo]);
}

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });

  const timestamp = new Date().toISOString();

  const allTrades = await prisma.paperTrade.findMany({
    orderBy: { createdAt: "desc" },
  });

  const byMode: Record<string, number> = {};
  const byRelaxationReason: Record<string, number> = {};
  const openByMode: Record<string, number> = {};
  const closedByMode: Record<string, number> = {};
  const pnlByMode: Record<string, { sum: number; count: number; wins: number; losses: number }> = {};
  const scoreByMode: Record<string, number[]> = {};
  const relaxedTrades: typeof allTrades = [];

  for (const t of allTrades) {
    const mode = t.paperPolicyMode ?? "normal";
    byMode[mode] = (byMode[mode] ?? 0) + 1;
    if (t.status === "open") openByMode[mode] = (openByMode[mode] ?? 0) + 1;
    else closedByMode[mode] = (closedByMode[mode] ?? 0) + 1;

    if (!scoreByMode[mode]) scoreByMode[mode] = [];
    scoreByMode[mode].push(t.score);

    if (t.status === "closed" && t.pnlPct != null) {
      const pct = parseFloat(t.pnlPct);
      if (Number.isFinite(pct)) {
        if (!pnlByMode[mode]) pnlByMode[mode] = { sum: 0, count: 0, wins: 0, losses: 0 };
        pnlByMode[mode].sum += pct;
        pnlByMode[mode].count++;
        if (pct > 0) pnlByMode[mode].wins++;
        if (pct < 0) pnlByMode[mode].losses++;
      }
    }

    if (mode === "relaxed_block_candidate") {
      relaxedTrades.push(t);
      const reason = t.paperRelaxationReason ?? "unknown";
      byRelaxationReason[reason] = (byRelaxationReason[reason] ?? 0) + 1;
    }
  }

  const scoreDistributionByMode: Record<
    string,
    { count: number; min: number; p25: number; p50: number; p75: number; max: number; avg: number }
  > = {};
  for (const [mode, scores] of Object.entries(scoreByMode)) {
    const sorted = [...scores].sort((a, b) => a - b);
    scoreDistributionByMode[mode] = {
      count: sorted.length,
      min: sorted.length ? sorted[0] : 0,
      p25: percentile(sorted, 25),
      p50: percentile(sorted, 50),
      p75: percentile(sorted, 75),
      max: sorted.length ? sorted[sorted.length - 1] : 0,
      avg: sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0,
    };
  }

  const derivationSourceByRelaxed: Record<string, number> = {};
  for (const t of relaxedTrades) {
    try {
      const m = t.metadataJson ? (JSON.parse(t.metadataJson) as Record<string, unknown>) : {};
      const src = (m.derivationSource as string) ?? "unknown";
      derivationSourceByRelaxed[src] = (derivationSourceByRelaxed[src] ?? 0) + 1;
    } catch {
      derivationSourceByRelaxed["unknown"] = (derivationSourceByRelaxed["unknown"] ?? 0) + 1;
    }
  }

  const cohortByReason: Record<string, { opened: number; closed: number; wins: number; losses: number; winRate: number | null; avgPnlPct: number | null }> = {};
  for (const t of relaxedTrades) {
    const reason = t.paperRelaxationReason ?? "unknown";
    if (!cohortByReason[reason]) cohortByReason[reason] = { opened: 0, closed: 0, wins: 0, losses: 0, winRate: null, avgPnlPct: null };
    cohortByReason[reason].opened++;
    if (t.status === "closed") {
      cohortByReason[reason].closed++;
      const pct = parseFloat(t.pnlPct ?? "");
      if (Number.isFinite(pct)) {
        if (pct > 0) cohortByReason[reason].wins++;
        if (pct < 0) cohortByReason[reason].losses++;
      }
    }
  }
  for (const reason of Object.keys(cohortByReason)) {
    const r = cohortByReason[reason];
    const closedWithPnl = r.wins + r.losses;
    r.winRate = closedWithPnl ? r.wins / closedWithPnl : null;
    const relaxedClosed = relaxedTrades.filter((t) => (t.paperRelaxationReason ?? "unknown") === reason && t.status === "closed");
    const pnls = relaxedClosed.map((t) => parseFloat(t.pnlPct ?? "")).filter((n) => Number.isFinite(n));
    r.avgPnlPct = pnls.length ? pnls.reduce((a, b) => a + b, 0) / pnls.length : null;
  }

  const top25Relaxed = relaxedTrades.slice(0, 25).map((t) => {
    let recommendationId: string | null = null;
    let derivationSource: string | null = null;
    try {
      const m = t.metadataJson ? (JSON.parse(t.metadataJson) as Record<string, unknown>) : {};
      recommendationId = (m.recommendationId as string) ?? null;
      derivationSource = (m.derivationSource as string) ?? null;
    } catch {
      // leave null
    }
    return {
      id: t.id,
      recommendationId,
      derivationSource,
      entryPriceBand: classifyEntryPriceBand(parseEntryPrice(t.entryPrice)),
      marketId: t.marketId,
      assetId: t.assetId,
      side: t.side,
      score: t.score,
      threshold: t.threshold,
      entryPrice: t.entryPrice,
      entryTime: t.entryTime?.toISOString(),
      intendedSize: t.intendedSize,
      status: t.status,
      exitPrice: t.exitPrice,
      exitTime: t.exitTime?.toISOString(),
      markout12h: t.markout12h,
      pnlPct: t.pnlPct,
      sourceDecisionState: t.sourceDecisionState,
      paperPolicyMode: t.paperPolicyMode,
      paperRelaxationReason: t.paperRelaxationReason,
      originalBlockingReasons: t.originalBlockingReasons,
      paperEligibilityVersion: t.paperEligibilityVersion,
      createdAt: t.createdAt?.toISOString(),
    };
  });

  let zeroRelaxedReason: string | null = null;
  if (relaxedTrades.length === 0) {
    const totalTrades = allTrades.length;
    const blockSnapshots = await prisma.decisionPolicySnapshot.count({ where: { policyState: "BLOCK" } });
    if (totalTrades === 0) {
      zeroRelaxedReason = "No paper trades exist yet (no tick has opened any trade).";
    } else if (blockSnapshots === 0) {
      zeroRelaxedReason = "No BLOCK snapshots exist; relaxation only applies to BLOCKed decisions.";
    } else {
      zeroRelaxedReason =
        "Paper trades exist and BLOCK snapshots exist, but no trade was created from a relaxed BLOCK candidate (e.g. none passed relaxation eligibility, or none scored above threshold, or cooldown/risk limits prevented opening).";
    }
  }

  const review = {
    timestamp,
    totalPaperTradeRows: allTrades.length,
    totalByPaperPolicyMode: byMode,
    totalByPaperRelaxationReason: byRelaxationReason,
    derivationSourceBreakdown: derivationSourceByRelaxed,
    cohortByReason,
    openCountByMode: openByMode,
    closedCountByMode: closedByMode,
    pnlByMode: Object.fromEntries(
      Object.entries(pnlByMode).map(([k, v]) => [
        k,
        { sumPnlPct: v.sum, closedCount: v.count, wins: v.wins, losses: v.losses, avgPnlPct: v.count ? v.sum / v.count : null },
      ])
    ),
    scoreDistributionByMode: scoreDistributionByMode,
    top25RelaxedTradesWithProvenance: top25Relaxed,
    zeroRelaxedTrades: relaxedTrades.length === 0,
    zeroRelaxedReason,
  };

  const jsonPath = path.join(DUMP_DIR, "paper-relaxed-trades-review.json");
  await fs.writeFile(jsonPath, JSON.stringify(review, null, 2), "utf8");
  console.log("Wrote", jsonPath);

  const md = [
    "# Paper relaxed trades review",
    "",
    "**Generated:** " + timestamp,
    "",
    "## Totals",
    "",
    "| paperPolicyMode | Count |",
    "|-----------------|-------|",
    ...Object.entries(byMode).map(([k, v]) => `| ${k} | ${v} |`),
    "",
    "## By paperRelaxationReason (relaxed only)",
    "",
    Object.keys(byRelaxationReason).length === 0 ? "(no relaxed trades)" : "| Reason | Count |\n|--------|-------|\n" + Object.entries(byRelaxationReason).map(([k, v]) => `| ${k} | ${v} |`).join("\n"),
    "",
    "## DerivationSource breakdown (relaxed only)",
    "",
    Object.keys(derivationSourceByRelaxed).length === 0 ? "(no relaxed trades)" : "| derivationSource | Count |\n|-----------------|-------|\n" + Object.entries(derivationSourceByRelaxed).map(([k, v]) => `| ${k} | ${v} |`).join("\n"),
    "",
    "## Cohort by reason (relaxed: opened, closed, win rate, avg PnL)",
    "",
    Object.keys(cohortByReason).length === 0 ? "(no relaxed trades)" : "| Reason | opened | closed | wins | losses | winRate | avgPnlPct |\n|--------|--------|--------|------|--------|---------|----------|\n" + Object.entries(cohortByReason).map(([k, r]) => `| ${k} | ${r.opened} | ${r.closed} | ${r.wins} | ${r.losses} | ${r.winRate != null ? r.winRate.toFixed(2) : "—"} | ${r.avgPnlPct != null ? r.avgPnlPct.toFixed(2) : "—"} |`).join("\n"),
    "",
    "## Open vs closed by mode",
    "",
    "| Mode | Open | Closed |",
    "|------|------|--------|",
    ...Object.keys(byMode).map((m) => `| ${m} | ${openByMode[m] ?? 0} | ${closedByMode[m] ?? 0} |`),
    "",
    "## PnL by mode (closed trades)",
    "",
    ...Object.entries(pnlByMode).map(
      ([mode, v]) =>
        `**${mode}:** count=${v.count}, sumPnlPct=${v.sum.toFixed(2)}, wins=${v.wins}, losses=${v.losses}, avgPnlPct=${v.count ? (v.sum / v.count).toFixed(2) : "—"}`
    ),
    "",
    "## Score distribution by mode",
    "",
    "| Mode | count | min | p25 | p50 | p75 | max | avg |",
    "|------|-------|-----|-----|-----|-----|-----|-----|",
    ...Object.entries(scoreDistributionByMode).map(
      ([m, s]) => `| ${m} | ${s.count} | ${s.min.toFixed(3)} | ${s.p25.toFixed(3)} | ${s.p50.toFixed(3)} | ${s.p75.toFixed(3)} | ${s.max.toFixed(3)} | ${s.avg.toFixed(3)} |`
    ),
    "",
    "## Top 25 relaxed trades (full provenance)",
    "",
    relaxedTrades.length === 0 ? (zeroRelaxedReason ?? "(none)") : top25Relaxed.map((t) => "- " + JSON.stringify(t)).join("\n"),
    "",
    "## Zero relaxed trades",
    "",
    review.zeroRelaxedTrades ? (zeroRelaxedReason ?? "Unknown.") : "No (at least one relaxed trade exists).",
  ].join("\n");

  const mdPath = path.join(DUMP_DIR, "paper-relaxed-trades-review.md");
  await fs.writeFile(mdPath, md, "utf8");
  console.log("Wrote", mdPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
