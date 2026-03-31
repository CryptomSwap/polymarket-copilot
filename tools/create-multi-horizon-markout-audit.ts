/**
 * Read-only multi-horizon markout audit on post-fix joined cohort.
 * Horizons: 12h / 24h / 48h (when snapshot data exists).
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import { normalizeShadowSideForJoin } from "../lib/shadow-telemetry";
import { markout } from "../lib/shadow-evaluation/markout";
import { getSnapshotPriceAtOrBefore } from "../lib/polymarket/market-price-snapshot-lookup";

const DUMP_DIR = path.join(process.cwd(), "dump");
const OUT_JSON = path.join(DUMP_DIR, "multi-horizon-markout-audit.json");
const OUT_MD = path.join(DUMP_DIR, "multi-horizon-markout-audit.md");
const OUT_CHAT = path.join(DUMP_DIR, "multi-horizon-markout-audit-chat-summary.md");

const AFTER_RAW = process.env.POSTFIX_LINKAGE_AFTER?.trim();
const PAPER_N = Math.min(3000, Math.max(20, Number(process.env.POSTFIX_MARKOUT_AUDIT_PAPER_N ?? "200") || 200));
const ML_N = Math.min(20000, Math.max(100, Number(process.env.POSTFIX_MARKOUT_AUDIT_ML_N ?? "1000") || 1000));

function parseRecommendationId(metadataJson: string | null): string | null {
  if (!metadataJson) return null;
  try {
    const o = JSON.parse(metadataJson) as Record<string, unknown>;
    const id = o.recommendationId;
    return typeof id === "string" && id.trim() ? id.trim() : null;
  } catch {
    return null;
  }
}

function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

function histogram(values: number[]) {
  return {
    "<= -10%": values.filter((x) => x <= -0.1).length,
    "-10% to -5%": values.filter((x) => x > -0.1 && x <= -0.05).length,
    "-5% to 0%": values.filter((x) => x > -0.05 && x <= 0).length,
    "0% to 5%": values.filter((x) => x > 0 && x <= 0.05).length,
    "5% to 10%": values.filter((x) => x > 0.05 && x <= 0.1).length,
    "> 10%": values.filter((x) => x > 0.1).length,
  };
}

function summarize(values: number[]) {
  const s = [...values].filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return {
    n: s.length,
    positiveRate: s.length ? s.filter((x) => x > 0).length / s.length : null,
    mean: s.length ? s.reduce((a, c) => a + c, 0) / s.length : null,
    median: quantile(s, 0.5),
    histogram: histogram(s),
  };
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

  const paperRows = await prisma.paperTrade.findMany({
    where: { entryTime: { gte: cutoff } },
    orderBy: { entryTime: "desc" },
    take: PAPER_N,
    select: {
      id: true,
      entryTime: true,
      metadataJson: true,
      assetId: true,
      side: true,
    },
  });
  const mlRows = await prisma.mlShadowTrainingExample.findMany({
    where: { createdAt: { gte: cutoff } },
    orderBy: { updatedAt: "desc" },
    take: ML_N,
    select: {
      id: true,
      recommendationId: true,
      assetId: true,
      side: true,
      marketId: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  const byTriple = new Map<string, typeof mlRows>();
  for (const m of mlRows) {
    const rec = m.recommendationId?.trim();
    if (!rec) continue;
    const key = `${rec}|${m.assetId}|${normalizeShadowSideForJoin(m.side)}`;
    const arr = byTriple.get(key) ?? [];
    arr.push(m);
    byTriple.set(key, arr);
  }
  for (const arr of byTriple.values()) arr.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

  const joined = [];
  for (const p of paperRows) {
    const rec = parseRecommendationId(p.metadataJson);
    if (!rec) continue;
    const key = `${rec}|${p.assetId}|${normalizeShadowSideForJoin(p.side)}`;
    const hits = byTriple.get(key) ?? [];
    if (hits.length === 0) continue;
    const pick = hits[0]!;
    joined.push({
      paperTradeId: p.id,
      recommendationId: rec,
      assetId: p.assetId,
      side: normalizeShadowSideForJoin(p.side),
      marketId: pick.marketId,
      decisionAt: pick.createdAt,
    });
  }

  const m12: number[] = [];
  const m24: number[] = [];
  const m48: number[] = [];

  for (const j of joined) {
    if (!j.marketId) continue;
    const p0 = await getSnapshotPriceAtOrBefore(j.marketId, j.assetId, j.decisionAt);
    if (p0 == null || p0 <= 0) continue;

    const at12 = new Date(j.decisionAt.getTime() + 12 * 60 * 60 * 1000);
    const at24 = new Date(j.decisionAt.getTime() + 24 * 60 * 60 * 1000);
    const at48 = new Date(j.decisionAt.getTime() + 48 * 60 * 60 * 1000);

    const p12 = await getSnapshotPriceAtOrBefore(j.marketId, j.assetId, at12);
    const p24 = await getSnapshotPriceAtOrBefore(j.marketId, j.assetId, at24);
    const p48 = await getSnapshotPriceAtOrBefore(j.marketId, j.assetId, at48);

    const x12 = p12 != null ? markout(j.side, p0, p12) : null;
    const x24 = p24 != null ? markout(j.side, p0, p24) : null;
    const x48 = p48 != null ? markout(j.side, p0, p48) : null;

    if (x12 != null && Number.isFinite(x12)) m12.push(x12);
    if (x24 != null && Number.isFinite(x24)) m24.push(x24);
    if (x48 != null && Number.isFinite(x48)) m48.push(x48);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    cutoffUsed: cutoff.toISOString(),
    joinedPostfixCohortSize: joined.length,
    horizons: {
      h12: summarize(m12),
      h24: summarize(m24),
      h48: summarize(m48),
    },
    interpretation:
      "Compare positiveRate/median across 12h->24h->48h. If rates improve at longer horizons, edge may exist but realize slower than 12h.",
  };

  await fs.writeFile(OUT_JSON, JSON.stringify(report, null, 2), "utf8");

  const md = [
    "# Multi-horizon markout audit (post-fix joined cohort)",
    "",
    `Cutoff: \`${report.cutoffUsed}\``,
    `Joined rows: **${joined.length}**`,
    "",
    "## 12h",
    `- n: ${report.horizons.h12.n}, positiveRate: ${((report.horizons.h12.positiveRate ?? 0) * 100).toFixed(1)}%`,
    `- mean/median: ${report.horizons.h12.mean ?? "—"} / ${report.horizons.h12.median ?? "—"}`,
    "",
    "## 24h",
    `- n: ${report.horizons.h24.n}, positiveRate: ${((report.horizons.h24.positiveRate ?? 0) * 100).toFixed(1)}%`,
    `- mean/median: ${report.horizons.h24.mean ?? "—"} / ${report.horizons.h24.median ?? "—"}`,
    "",
    "## 48h",
    `- n: ${report.horizons.h48.n}, positiveRate: ${((report.horizons.h48.positiveRate ?? 0) * 100).toFixed(1)}%`,
    `- mean/median: ${report.horizons.h48.mean ?? "—"} / ${report.horizons.h48.median ?? "—"}`,
    "",
    `JSON: \`${OUT_JSON}\``,
  ].join("\n");
  await fs.writeFile(OUT_MD, md, "utf8");

  const chat = [
    "## Multi-horizon markout audit",
    `- joined cohort: **${joined.length}**`,
    `- 12h positive rate: **${((report.horizons.h12.positiveRate ?? 0) * 100).toFixed(1)}%**`,
    `- 24h positive rate: **${((report.horizons.h24.positiveRate ?? 0) * 100).toFixed(1)}%**`,
    `- 48h positive rate: **${((report.horizons.h48.positiveRate ?? 0) * 100).toFixed(1)}%**`,
    `- files: \`dump/multi-horizon-markout-audit.{json,md,-chat-summary.md}\``,
  ].join("\n");
  await fs.writeFile(OUT_CHAT, chat, "utf8");

  console.log("[multi-horizon-markout-audit]", {
    joinedCohort: joined.length,
    h12: report.horizons.h12,
    h24: report.horizons.h24,
    h48: report.horizons.h48,
    outputs: [OUT_JSON, OUT_MD, OUT_CHAT],
  });
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});

