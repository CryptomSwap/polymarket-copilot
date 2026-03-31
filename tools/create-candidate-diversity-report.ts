import "dotenv/config";
import * as fs from "fs/promises";
import * as path from "path";
import { getFunderForPaperTradingTick } from "../lib/decision/recompute";
import { loadShadowCandidatesForPaperTick, normalizePreferredFunderForShadowLoad } from "../lib/paper-trading/candidates";

type Row = {
  recommendationId: string;
  marketId: string;
  category: string;
  price: number | null;
  spreadBps: number | null;
  liquidity: number | null;
  momentum1hBps: number | null;
  momentum6hBps: number | null;
};

function parseNum(v: string | number | null | undefined): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

function stats(values: number[]): { mean: number; std: number; min: number; max: number } | null {
  if (values.length === 0) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return {
    mean,
    std: Math.sqrt(Math.max(0, variance)),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

function fmt(n: number | null, d = 6): string {
  return n == null ? "-" : n.toFixed(d);
}

function uniqCount<T>(arr: T[]): number {
  return new Set(arr).size;
}

function concentration<T>(arr: T[]): { topValue: string; topShare: number } {
  if (arr.length === 0) return { topValue: "-", topShare: 0 };
  const counts = new Map<string, number>();
  for (const x of arr) {
    const k = String(x);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const top = sorted[0]!;
  return { topValue: top[0], topShare: top[1] / arr.length };
}

function binnedEntropy01(values: number[], bins = 10): number | null {
  if (values.length === 0) return null;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  if (hi - lo <= 1e-12) return 0;
  const counts = new Array<number>(bins).fill(0);
  for (const v of values) {
    const idx = Math.min(bins - 1, Math.max(0, Math.floor(((v - lo) / (hi - lo)) * bins)));
    counts[idx]! += 1;
  }
  const n = values.length;
  let h = 0;
  for (const c of counts) {
    if (c <= 0) continue;
    const p = c / n;
    h += -p * Math.log2(p);
  }
  const hMax = Math.log2(bins);
  return hMax > 0 ? h / hMax : 0;
}

function priceBand(price: number | null): string {
  if (price == null) return "unknown";
  if (price < 0.1) return "0.0-0.1";
  if (price < 0.3) return "0.1-0.3";
  if (price < 0.7) return "0.3-0.7";
  if (price < 0.9) return "0.7-0.9";
  return "0.9-1.0";
}

function spreadBand(spreadBps: number | null): string {
  if (spreadBps == null) return "unknown";
  if (spreadBps < 50) return "<50";
  if (spreadBps < 150) return "50-150";
  if (spreadBps < 300) return "150-300";
  return ">=300";
}

function momentumBand(m: number | null): string {
  if (m == null) return "unknown";
  if (m < -100) return "<-100";
  if (m < -20) return "-100:-20";
  if (m <= 20) return "-20:20";
  if (m <= 100) return "20:100";
  return ">100";
}

async function main(): Promise<void> {
  const explicitFunder = process.argv[2]?.trim() || undefined;
  const preferredFunder = normalizePreferredFunderForShadowLoad(
    explicitFunder ?? (await getFunderForPaperTradingTick())
  );
  const loaded = await loadShadowCandidatesForPaperTick({ preferredFunder });

  const rows: Row[] = loaded.candidates.map((c) => ({
    recommendationId: c.recommendationId,
    marketId: c.marketId,
    category: c.category ?? "unknown",
    price: parseNum(c.entryPrice) ?? parseNum(c.shadowInput.intendedPrice),
    spreadBps: parseNum(c.shadowInput.spreadBps),
    liquidity: parseNum(c.shadowInput.liquidityTrend),
    momentum1hBps: parseNum(c.shadowInput.momentum1hBps),
    momentum6hBps: parseNum(c.shadowInput.momentum6hBps),
  }));

  const priceVals = rows.map((r) => r.price).filter((x): x is number => x != null);
  const spreadVals = rows.map((r) => r.spreadBps).filter((x): x is number => x != null);
  const liqVals = rows.map((r) => r.liquidity).filter((x): x is number => x != null);
  const m1Vals = rows.map((r) => r.momentum1hBps).filter((x): x is number => x != null);
  const m6Vals = rows.map((r) => r.momentum6hBps).filter((x): x is number => x != null);

  const fieldSummary = [
    { field: "price", vals: priceVals },
    { field: "spreadBps", vals: spreadVals },
    { field: "liquidity", vals: liqVals },
    { field: "momentum1hBps", vals: m1Vals },
    { field: "momentum6hBps", vals: m6Vals },
  ].map((f) => {
    const s = stats(f.vals);
    const c = concentration(f.vals.map((v) => Number(v.toFixed(6))));
    const ent = binnedEntropy01(f.vals, 10);
    const isFlat = c.topShare >= 0.9;
    return {
      field: f.field,
      nAvailable: f.vals.length,
      uniqueValues: uniqCount(f.vals.map((v) => Number(v.toFixed(6)))),
      mean: s?.mean ?? null,
      std: s?.std ?? null,
      min: s?.min ?? null,
      max: s?.max ?? null,
      topValue: c.topValue,
      topShare: c.topShare,
      entropy01: ent,
      flatFlag: isFlat,
    };
  });

  const clusters = new Map<string, number>();
  for (const r of rows) {
    const key = [
      priceBand(r.price),
      spreadBand(r.spreadBps),
      momentumBand(r.momentum1hBps ?? r.momentum6hBps),
      r.category,
    ].join("|");
    clusters.set(key, (clusters.get(key) ?? 0) + 1);
  }
  const topClusters = [...clusters.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15);

  const extremeCount = rows.filter((r) => r.price != null && (r.price > 0.9 || r.price < 0.1)).length;
  const extremePct = rows.length > 0 ? extremeCount / rows.length : 0;

  const vectorKey = (r: Row): string =>
    [
      r.price == null ? "na" : r.price.toFixed(4),
      r.spreadBps == null ? "na" : r.spreadBps.toFixed(2),
      r.liquidity == null ? "na" : r.liquidity.toFixed(4),
      r.momentum1hBps == null ? "na" : r.momentum1hBps.toFixed(2),
      r.momentum6hBps == null ? "na" : r.momentum6hBps.toFixed(2),
      r.category,
      r.marketId,
    ].join("|");
  const vecCounts = new Map<string, number>();
  for (const r of rows) {
    const k = vectorKey(r);
    vecCounts.set(k, (vecCounts.get(k) ?? 0) + 1);
  }
  const identicalVectorCount = [...vecCounts.values()].filter((c) => c > 1).reduce((a, b) => a + b, 0);
  const identicalPct = rows.length > 0 ? identicalVectorCount / rows.length : 0;

  const outDir = path.join(process.cwd(), "dump", "repo-exploration-pack");
  const outPath = path.join(outDir, "09-candidate-diversity.md");
  await fs.mkdir(outDir, { recursive: true });

  const lines: string[] = [];
  lines.push("# Candidate Diversity Report");
  lines.push("");
  lines.push("## Snapshot");
  lines.push(`- funder used: ${loaded.shadowDiagnostics.funderUsedForLoad ?? preferredFunder ?? "-"}`);
  lines.push(`- candidates loaded: ${rows.length}`);
  lines.push(`- lookback minutes: ${loaded.shadowDiagnostics.lookbackMinutes}`);
  lines.push("");
  lines.push("## Distribution stats");
  lines.push("| field | n available | unique | mean | std | min | max |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const f of fieldSummary) {
    lines.push(
      `| ${f.field} | ${f.nAvailable} | ${f.uniqueValues} | ${fmt(f.mean)} | ${fmt(f.std)} | ${fmt(f.min)} | ${fmt(f.max)} |`
    );
  }
  lines.push("");
  lines.push("## Concentration / entropy indicators");
  lines.push("| field | top value | top share | entropy01 | flat flag (>=90% same) |");
  lines.push("| --- | --- | ---: | ---: | --- |");
  for (const f of fieldSummary) {
    lines.push(
      `| ${f.field} | ${f.topValue} | ${fmt(f.topShare, 4)} | ${fmt(f.entropy01)} | ${f.flatFlag ? "YES" : "no"} |`
    );
  }
  lines.push("");
  lines.push("## Similarity clustering (top)");
  lines.push("| cluster (priceBand|spreadBand|momentumBand|category) | n | share |");
  lines.push("| --- | ---: | ---: |");
  for (const [k, n] of topClusters) {
    lines.push(`| ${k} | ${n} | ${fmt(rows.length > 0 ? n / rows.length : 0, 4)} |`);
  }
  lines.push("");
  lines.push("## Diversity summary");
  lines.push(`- % candidates near price extremes (>0.9 or <0.1): ${fmt(extremePct, 4)}`);
  lines.push(`- % candidates with identical feature vectors: ${fmt(identicalPct, 4)}`);
  lines.push(
    `- distinct marketId count: ${uniqCount(rows.map((r) => r.marketId))} / ${rows.length}`
  );
  lines.push(
    `- distinct category count: ${uniqCount(rows.map((r) => r.category))} / ${rows.length}`
  );
  lines.push("");
  lines.push("## Interpretation");
  const flatFields = fieldSummary.filter((f) => f.flatFlag).map((f) => f.field);
  if (rows.length === 0) {
    lines.push("- No candidates in current snapshot; cannot assess diversity.");
  } else if (flatFields.length > 0) {
    lines.push(`- Structural flatness detected in fields: ${flatFields.join(", ")}.`);
  } else {
    lines.push("- Candidate universe shows non-trivial variation across measured fields in this snapshot.");
  }

  await fs.writeFile(outPath, lines.join("\n"), "utf8");
  console.log(`Wrote ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
