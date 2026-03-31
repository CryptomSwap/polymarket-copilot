import "dotenv/config";
import * as fs from "fs/promises";
import * as path from "path";
import { prisma } from "../lib/db";

type BucketKey = "0.0-0.2" | "0.2-0.4" | "0.4-0.6" | "0.6-0.8" | "0.8-1.0";

type Row = {
  score: number;
  entryPrice: number | null;
  markout: number | null;
  pnlPct: number | null;
  spreadBps: number | null;
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

function avg(nums: number[]): number | null {
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function fmt(n: number | null, digits = 6): string {
  return n == null ? "-" : n.toFixed(digits);
}

function bucketForScore(score: number): BucketKey {
  if (score < 0.2) return "0.0-0.2";
  if (score < 0.4) return "0.2-0.4";
  if (score < 0.6) return "0.4-0.6";
  if (score < 0.8) return "0.6-0.8";
  return "0.8-1.0";
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

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as unknown;
    return p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function readSpreadBpsFromMetadata(metaRaw: string | null | undefined): number | null {
  const m = parseJsonObject(metaRaw);
  if (!m) return null;
  const direct = parseNum(m.spreadBps as string | number | null | undefined);
  if (direct != null) return direct;

  const roi = m.paperRoiAdmission as Record<string, unknown> | undefined;
  const roiSpread = parseNum(roi?.spreadBpsAtAdmission as string | number | null | undefined);
  if (roiSpread != null) return roiSpread;

  const openAttr = m.openAttribution as Record<string, unknown> | undefined;
  const execCtx = openAttr?.executionContext as Record<string, unknown> | undefined;
  const attrSpread = parseNum(execCtx?.spreadBps as string | number | null | undefined);
  return attrSpread;
}

function spreadQuartile(spreadBps: number | null, cutpoints: [number, number, number]): string {
  if (spreadBps == null) return "unknown";
  if (spreadBps <= cutpoints[0]) return "Q1 (tightest)";
  if (spreadBps <= cutpoints[1]) return "Q2";
  if (spreadBps <= cutpoints[2]) return "Q3";
  return "Q4 (widest)";
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * q)));
  return sorted[idx] ?? 0;
}

function midRangePriceBand(entryPrice: number | null): string {
  if (entryPrice == null) return "unknown";
  if (entryPrice < 0.35) return "0.2-0.35";
  if (entryPrice < 0.5) return "0.35-0.5";
  if (entryPrice <= 0.65) return "0.5-0.65";
  return "0.65-0.8";
}

async function main(): Promise<void> {
  const now = Date.now();
  const since = new Date(now - 30 * 24 * 60 * 60 * 1000);

  const minCfg = parsePriceBoundEnv("PAPER_TRADING_PRICE_MIN", 0.2);
  const maxCfg = parsePriceBoundEnv("PAPER_TRADING_PRICE_MAX", 0.8);
  const priceMin = Math.min(minCfg, maxCfg);
  const priceMax = Math.max(minCfg, maxCfg);

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

  const allRows: Row[] = trades.map((t) => ({
    score: t.score,
    entryPrice: parseNum(t.entryPrice),
    markout: parseNum(t.markout12h),
    pnlPct: parseNum(t.pnlPct),
    spreadBps: readSpreadBpsFromMetadata(t.metadataJson),
  }));

  const rows = allRows.filter(
    (r) => r.entryPrice != null && r.entryPrice >= priceMin && r.entryPrice <= priceMax
  );

  const buckets: Record<BucketKey, Row[]> = {
    "0.0-0.2": [],
    "0.2-0.4": [],
    "0.4-0.6": [],
    "0.6-0.8": [],
    "0.8-1.0": [],
  };
  for (const r of rows) buckets[bucketForScore(r.score)].push(r);

  const bucketStats = (Object.keys(buckets) as BucketKey[]).map((k) => {
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

  const corrRows = rows.filter((r) => r.markout != null);
  const corr = pearson(
    corrRows.map((r) => r.score),
    corrRows.map((r) => r.markout as number)
  );

  const ranked = [...rows].sort((a, b) => a.score - b.score);
  const k = Math.max(1, Math.floor(ranked.length * 0.2));
  const bottom = ranked.slice(0, k);
  const top = ranked.slice(ranked.length - k);

  const topBottom = {
    k,
    topAvgMarkout: avg(top.map((x) => x.markout).filter((x): x is number => x != null)),
    bottomAvgMarkout: avg(bottom.map((x) => x.markout).filter((x): x is number => x != null)),
    topHitRate: hitRate(top.map((x) => x.markout ?? x.pnlPct)),
    bottomHitRate: hitRate(bottom.map((x) => x.markout ?? x.pnlPct)),
    topAvgPnlPct: avg(top.map((x) => x.pnlPct).filter((x): x is number => x != null)),
    bottomAvgPnlPct: avg(bottom.map((x) => x.pnlPct).filter((x): x is number => x != null)),
  };

  const spreads = rows.map((r) => r.spreadBps).filter((x): x is number => x != null).sort((a, b) => a - b);
  const spreadCuts: [number, number, number] = [
    quantile(spreads, 0.25),
    quantile(spreads, 0.5),
    quantile(spreads, 0.75),
  ];
  const spreadGroups = new Map<string, Row[]>();
  for (const r of rows) {
    const kq = spreadQuartile(r.spreadBps, spreadCuts);
    const arr = spreadGroups.get(kq) ?? [];
    arr.push(r);
    spreadGroups.set(kq, arr);
  }

  const spreadDiagnostics = [...spreadGroups.entries()].map(([quartile, rs]) => ({
    quartile,
    n: rs.length,
    avgMarkout: avg(rs.map((x) => x.markout).filter((x): x is number => x != null)),
  }));

  const priceGroups = new Map<string, Row[]>();
  for (const r of rows) {
    const pb = midRangePriceBand(r.entryPrice);
    const arr = priceGroups.get(pb) ?? [];
    arr.push(r);
    priceGroups.set(pb, arr);
  }
  const priceDiagnostics = [...priceGroups.entries()].map(([band, rs]) => ({
    band,
    n: rs.length,
    avgMarkout: avg(rs.map((x) => x.markout).filter((x): x is number => x != null)),
  }));

  const outDir = path.join(process.cwd(), "dump", "repo-exploration-pack");
  const outPath = path.join(outDir, "10-midrange-score-predictiveness.md");
  await fs.mkdir(outDir, { recursive: true });

  const lines: string[] = [];
  lines.push("# Mid-range Score Predictiveness Report");
  lines.push("");
  lines.push("## Scope");
  lines.push(`- window: last 30 days (since ${since.toISOString()})`);
  lines.push(`- entryPrice mid-range filter: [${priceMin}, ${priceMax}]`);
  lines.push(`- closed trades with outcome rows (all prices): ${allRows.length}`);
  lines.push(`- closed trades in mid-range cohort: ${rows.length}`);
  lines.push("");
  lines.push("## Score bucket table");
  lines.push("| score bucket | n | avg markout | hit rate | avg pnlPct |");
  lines.push("| --- | ---: | ---: | ---: | ---: |");
  for (const b of bucketStats) {
    lines.push(
      `| ${b.bucket} | ${b.n} | ${fmt(b.avgMarkout)} | ${fmt(b.hitRate, 4)} | ${fmt(b.avgPnlPct)} |`
    );
  }
  lines.push("");
  lines.push("## Aggregate metrics");
  lines.push(`- correlation(score, markout): ${fmt(corr, 6)}`);
  lines.push(
    `- top 20% vs bottom 20% (n per side=${topBottom.k}): avg markout ${fmt(topBottom.topAvgMarkout)} vs ${fmt(
      topBottom.bottomAvgMarkout
    )}, hit rate ${fmt(topBottom.topHitRate, 4)} vs ${fmt(topBottom.bottomHitRate, 4)}, avg pnlPct ${fmt(
      topBottom.topAvgPnlPct
    )} vs ${fmt(topBottom.bottomAvgPnlPct)}`
  );
  lines.push("");
  lines.push("## Feature diagnostics");
  lines.push("### Avg markout by spread quartile");
  lines.push("| spread quartile | n | avg markout |");
  lines.push("| --- | ---: | ---: |");
  for (const q of spreadDiagnostics.sort((a, b) => a.quartile.localeCompare(b.quartile))) {
    lines.push(`| ${q.quartile} | ${q.n} | ${fmt(q.avgMarkout)} |`);
  }
  lines.push("");
  lines.push("### Avg markout by price band (mid-range universe)");
  lines.push("| price band | n | avg markout |");
  lines.push("| --- | ---: | ---: |");
  for (const p of priceDiagnostics.sort((a, b) => a.band.localeCompare(b.band))) {
    lines.push(`| ${p.band} | ${p.n} | ${fmt(p.avgMarkout)} |`);
  }
  lines.push("");
  lines.push("## Limitations");
  lines.push(`- Sample size in analyzed cohort: n=${rows.length}.`);
  lines.push("- Results are admission-conditioned: only already-opened-and-closed paper trades are observed.");
  lines.push("- This report evaluates persisted `PaperTrade.score`; simple/external feature variants may differ unless explicitly persisted.");
  lines.push("- Spread diagnostics depend on metadata coverage (`spreadBpsAtAdmission`) and may have missing values.");

  await fs.writeFile(outPath, lines.join("\n"), "utf8");
  console.log(`Wrote ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
