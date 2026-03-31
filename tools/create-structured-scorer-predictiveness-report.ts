import "dotenv/config";
import * as fs from "fs/promises";
import * as path from "path";
import { prisma } from "../lib/db";
import { buildStructuredScoringModel, type StructuredPriceBand, type StructuredSpreadQuartile } from "../lib/paper-trading/structured_scorer";

type BucketKey = "0.0-0.2" | "0.2-0.4" | "0.4-0.6" | "0.6-0.8" | "0.8-1.0";

type EvalRow = {
  persistedScore: number;
  structuredScore: number;
  markout: number | null;
  pnlPct: number | null;
  spreadBps: number | null;
  entryPrice: number;
};

function parseNum(v: string | number | null | undefined): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

function parsePriceBoundEnv(key: string, fallback: number): number {
  const raw = process.env[key]?.trim();
  if (!raw) return fallback;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as unknown;
    return p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function extractSpreadBps(metaRaw: string | null | undefined): number | null {
  const m = parseJsonObject(metaRaw);
  if (!m) return null;
  const direct = parseNum(m.spreadBps as string | number | null | undefined);
  if (direct != null) return direct;
  const roi = m.paperRoiAdmission as Record<string, unknown> | undefined;
  const roiSpread = parseNum(roi?.spreadBpsAtAdmission as string | number | null | undefined);
  if (roiSpread != null) return roiSpread;
  const oa = m.openAttribution as Record<string, unknown> | undefined;
  const ctx = oa?.executionContext as Record<string, unknown> | undefined;
  return parseNum(ctx?.spreadBps as string | number | null | undefined);
}

function avg(nums: number[]): number | null {
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function fmt(n: number | null, digits = 6): string {
  return n == null ? "-" : n.toFixed(digits);
}

function hitRate(vals: Array<number | null>): number | null {
  const usable = vals.filter((x): x is number => x != null);
  if (usable.length === 0) return null;
  return usable.filter((x) => x > 0).length / usable.length;
}

function pearson(xs: number[], ys: number[]): number | null {
  if (xs.length !== ys.length || xs.length < 2) return null;
  const mx = avg(xs);
  const my = avg(ys);
  if (mx == null || my == null) return null;
  let num = 0;
  let dx2 = 0;
  let dy2 = 0;
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  if (dx2 <= 0 || dy2 <= 0) return null;
  return num / Math.sqrt(dx2 * dy2);
}

function sigmoid(x: number): number {
  if (x > 30) return 1;
  if (x < -30) return 0;
  return 1 / (1 + Math.exp(-x));
}

function scoreBucket(score: number): BucketKey {
  if (score < 0.2) return "0.0-0.2";
  if (score < 0.4) return "0.2-0.4";
  if (score < 0.6) return "0.4-0.6";
  if (score < 0.8) return "0.6-0.8";
  return "0.8-1.0";
}

function resolvePriceBand(price: number): StructuredPriceBand {
  if (price < 0.35) return "0.2-0.35";
  if (price < 0.5) return "0.35-0.5";
  if (price < 0.65) return "0.5-0.65";
  return "0.65-0.8";
}

function resolveSpreadQuartile(
  spreadBps: number | null,
  cutoffs: [number, number, number]
): StructuredSpreadQuartile {
  if (spreadBps == null) return "Q4";
  if (spreadBps <= cutoffs[0]) return "Q1";
  if (spreadBps <= cutoffs[1]) return "Q2";
  if (spreadBps <= cutoffs[2]) return "Q3";
  return "Q4";
}

function bucketTable(rows: EvalRow[], mode: "structured" | "persisted") {
  const buckets: Record<BucketKey, EvalRow[]> = {
    "0.0-0.2": [],
    "0.2-0.4": [],
    "0.4-0.6": [],
    "0.6-0.8": [],
    "0.8-1.0": [],
  };
  for (const r of rows) {
    const s = mode === "structured" ? r.structuredScore : r.persistedScore;
    buckets[scoreBucket(s)].push(r);
  }
  return (Object.keys(buckets) as BucketKey[]).map((k) => {
    const b = buckets[k];
    const markouts = b.map((x) => x.markout).filter((x): x is number => x != null);
    const pnls = b.map((x) => x.pnlPct).filter((x): x is number => x != null);
    return {
      bucket: k,
      n: b.length,
      avgMarkout: avg(markouts),
      hitRate: hitRate(b.map((x) => x.markout ?? x.pnlPct)),
      avgPnlPct: avg(pnls),
    };
  });
}

function topBottom(rows: EvalRow[], mode: "structured" | "persisted") {
  const sorted = [...rows].sort((a, b) => {
    const sa = mode === "structured" ? a.structuredScore : a.persistedScore;
    const sb = mode === "structured" ? b.structuredScore : b.persistedScore;
    return sa - sb;
  });
  const k = Math.max(1, Math.floor(sorted.length * 0.2));
  const bottom = sorted.slice(0, k);
  const top = sorted.slice(sorted.length - k);
  return {
    k,
    topAvgMarkout: avg(top.map((x) => x.markout).filter((x): x is number => x != null)),
    bottomAvgMarkout: avg(bottom.map((x) => x.markout).filter((x): x is number => x != null)),
    topHitRate: hitRate(top.map((x) => x.markout ?? x.pnlPct)),
    bottomHitRate: hitRate(bottom.map((x) => x.markout ?? x.pnlPct)),
    topAvgPnlPct: avg(top.map((x) => x.pnlPct).filter((x): x is number => x != null)),
    bottomAvgPnlPct: avg(bottom.map((x) => x.pnlPct).filter((x): x is number => x != null)),
  };
}

async function main(): Promise<void> {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const minCfg = parsePriceBoundEnv("PAPER_TRADING_PRICE_MIN", 0.2);
  const maxCfg = parsePriceBoundEnv("PAPER_TRADING_PRICE_MAX", 0.8);
  const priceMin = Math.min(minCfg, maxCfg);
  const priceMax = Math.max(minCfg, maxCfg);

  const model = await buildStructuredScoringModel(30);

  const trades = await prisma.paperTrade.findMany({
    where: {
      status: "closed",
      createdAt: { gte: since },
      OR: [{ markout12h: { not: null } }, { pnlPct: { not: null } }],
    },
    select: {
      score: true,
      entryPrice: true,
      markout12h: true,
      pnlPct: true,
      metadataJson: true,
    },
    orderBy: { createdAt: "desc" },
  });

  let missingSpread = 0;
  let totalCohort = 0;
  const rows: EvalRow[] = [];

  for (const t of trades) {
    const entryPrice = parseNum(t.entryPrice);
    const markout = parseNum(t.markout12h);
    const pnlPct = parseNum(t.pnlPct);
    if (entryPrice == null || (markout == null && pnlPct == null)) continue;
    if (entryPrice < priceMin || entryPrice > priceMax) continue;
    totalCohort++;

    const spreadBps = extractSpreadBps(t.metadataJson);
    if (spreadBps == null) missingSpread++;

    const pb = resolvePriceBand(entryPrice);
    const sq = resolveSpreadQuartile(spreadBps, model.spreadCutoffs);
    const ik = `${pb}|${sq}`;
    const linear =
      model.globalMeanOutcome +
      model.priceBandWeights[pb] +
      model.spreadQuartileWeights[sq] +
      (model.interactionWeights[ik] ?? 0);
    const z = (linear - model.globalMeanOutcome) / Math.max(model.globalStdOutcome, 1e-6);
    const structuredScore = sigmoid(z);

    rows.push({
      persistedScore: t.score,
      structuredScore,
      markout,
      pnlPct,
      spreadBps,
      entryPrice,
    });
  }

  const corrStructured = pearson(
    rows.filter((r) => r.markout != null).map((r) => r.structuredScore),
    rows.filter((r) => r.markout != null).map((r) => r.markout as number)
  );
  const corrPersisted = pearson(
    rows.filter((r) => r.markout != null).map((r) => r.persistedScore),
    rows.filter((r) => r.markout != null).map((r) => r.markout as number)
  );

  const tbStructured = topBottom(rows, "structured");
  const tbPersisted = topBottom(rows, "persisted");
  const tableStructured = bucketTable(rows, "structured");
  const tablePersisted = bucketTable(rows, "persisted");

  const outDir = path.join(process.cwd(), "dump", "repo-exploration-pack");
  const outPath = path.join(outDir, "11-structured-scorer-predictiveness.md");
  await fs.mkdir(outDir, { recursive: true });

  const lines: string[] = [];
  lines.push("# Structured Scorer Predictiveness Report");
  lines.push("");
  lines.push("## Scope");
  lines.push(`- window: last 30 days (since ${since.toISOString()})`);
  lines.push(`- cohort filter: entryPrice in [${priceMin}, ${priceMax}]`);
  lines.push(`- analyzed cohort size: ${rows.length}`);
  lines.push("");
  lines.push("## Structured score bucket table");
  lines.push("| score bucket | n | avg markout | hit rate | avg pnlPct |");
  lines.push("| --- | ---: | ---: | ---: | ---: |");
  for (const b of tableStructured) {
    lines.push(
      `| ${b.bucket} | ${b.n} | ${fmt(b.avgMarkout)} | ${fmt(b.hitRate, 4)} | ${fmt(b.avgPnlPct)} |`
    );
  }
  lines.push("");
  lines.push("## Aggregate metrics");
  lines.push(`- structured correlation(score, markout): ${fmt(corrStructured, 6)}`);
  lines.push(
    `- structured top 20% vs bottom 20% (n=${tbStructured.k}): avg markout ${fmt(
      tbStructured.topAvgMarkout
    )} vs ${fmt(tbStructured.bottomAvgMarkout)}, hit rate ${fmt(tbStructured.topHitRate, 4)} vs ${fmt(
      tbStructured.bottomHitRate,
      4
    )}, avg pnlPct ${fmt(tbStructured.topAvgPnlPct)} vs ${fmt(tbStructured.bottomAvgPnlPct)}`
  );
  lines.push("");
  lines.push("## Side-by-side comparison (same cohort)");
  lines.push("| metric | structured scorer | persisted PaperTrade.score |");
  lines.push("| --- | ---: | ---: |");
  lines.push(`| correlation(score, markout) | ${fmt(corrStructured, 6)} | ${fmt(corrPersisted, 6)} |`);
  lines.push(
    `| top-bottom avg markout delta (top20 - bottom20) | ${fmt(
      (tbStructured.topAvgMarkout ?? 0) - (tbStructured.bottomAvgMarkout ?? 0)
    )} | ${fmt((tbPersisted.topAvgMarkout ?? 0) - (tbPersisted.bottomAvgMarkout ?? 0))} |`
  );
  lines.push(
    `| top-bottom hit-rate delta | ${fmt(
      (tbStructured.topHitRate ?? 0) - (tbStructured.bottomHitRate ?? 0),
      4
    )} | ${fmt((tbPersisted.topHitRate ?? 0) - (tbPersisted.bottomHitRate ?? 0), 4)} |`
  );
  lines.push("");
  lines.push("### Persisted score bucket table (reference)");
  lines.push("| score bucket | n | avg markout | hit rate | avg pnlPct |");
  lines.push("| --- | ---: | ---: | ---: | ---: |");
  for (const b of tablePersisted) {
    lines.push(
      `| ${b.bucket} | ${b.n} | ${fmt(b.avgMarkout)} | ${fmt(b.hitRate, 4)} | ${fmt(b.avgPnlPct)} |`
    );
  }
  lines.push("");
  lines.push("## Limitations / coverage");
  lines.push("- Reconstructed features used: price band, spread quartile, price×spread interaction.");
  lines.push("- Optional structured terms NOT reconstructed in historical replay: crossMarketConsistency, priceDriftSignal.");
  lines.push(
    `- Spread metadata missing rate in cohort: ${fmt(totalCohort > 0 ? missingSpread / totalCohort : 0, 4)} (${missingSpread}/${totalCohort}). Missing spread defaults to Q4 in reconstruction.`
  );
  lines.push("- Admission-conditioned sample: only already opened + closed PaperTrade rows are evaluated.");
  lines.push(
    `- Structured model training sample size (from model build): ${model.sampleSize}; evaluation cohort size: ${rows.length}.`
  );

  await fs.writeFile(outPath, lines.join("\n"), "utf8");
  console.log(`Wrote ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
