import "dotenv/config";
import * as fs from "fs/promises";
import * as path from "path";
import { prisma } from "../lib/db";

type BucketKey = "0.0-0.2" | "0.2-0.4" | "0.4-0.6" | "0.6-0.8" | "0.8-1.0";

type Row = {
  score: number;
  markout: number | null;
  pnlPct: number | null;
};

function parseNum(v: string | null | undefined): number | null {
  if (!v || !String(v).trim()) return null;
  const n = parseFloat(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

function resolveDays(): number {
  const raw = process.env.SCORE_PREDICTIVENESS_DAYS?.trim();
  if (!raw) return 21;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return 21;
  return Math.max(14, Math.min(30, n));
}

function bucketForScore(score: number): BucketKey {
  if (score < 0.2) return "0.0-0.2";
  if (score < 0.4) return "0.2-0.4";
  if (score < 0.6) return "0.4-0.6";
  if (score < 0.8) return "0.6-0.8";
  return "0.8-1.0";
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
  const hits = usable.filter((x) => x > 0).length;
  return hits / usable.length;
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

async function main(): Promise<void> {
  const days = resolveDays();
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const [closedPaperTrades, openPaperTrades, shadowSummary] = await Promise.all([
    prisma.paperTrade.findMany({
      where: {
        status: "closed",
        createdAt: { gte: since },
        OR: [{ markout12h: { not: null } }, { pnlPct: { not: null } }],
      },
      select: {
        id: true,
        score: true,
        markout12h: true,
        pnlPct: true,
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.paperTrade.count({
      where: {
        status: "open",
        createdAt: { gte: since },
      },
    }),
    prisma.shadowCandidate.groupBy({
      by: ["candidateSource"],
      where: { createdAt: { gte: since } },
      _count: { id: true },
    }),
  ]);

  const rows: Row[] = closedPaperTrades.map((t) => ({
    score: t.score,
    markout: parseNum(t.markout12h),
    pnlPct: parseNum(t.pnlPct),
  }));

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

  const forCorr = rows.filter((r) => r.markout != null);
  const corr = pearson(
    forCorr.map((r) => r.score),
    forCorr.map((r) => r.markout as number)
  );

  const ranked = [...rows].sort((a, b) => a.score - b.score);
  const decileN = Math.max(1, Math.floor(ranked.length * 0.1));
  const bottom = ranked.slice(0, decileN);
  const top = ranked.slice(ranked.length - decileN);
  const topVsBottom = {
    decileN,
    topAvgMarkout: avg(top.map((x) => x.markout).filter((x): x is number => x != null)),
    bottomAvgMarkout: avg(bottom.map((x) => x.markout).filter((x): x is number => x != null)),
    topHitRate: hitRate(top.map((x) => x.markout ?? x.pnlPct)),
    bottomHitRate: hitRate(bottom.map((x) => x.markout ?? x.pnlPct)),
    topAvgPnlPct: avg(top.map((x) => x.pnlPct).filter((x): x is number => x != null)),
    bottomAvgPnlPct: avg(bottom.map((x) => x.pnlPct).filter((x): x is number => x != null)),
  };

  const outDir = path.join(process.cwd(), "dump", "repo-exploration-pack");
  const outPath = path.join(outDir, "07-score-predictiveness.md");
  await fs.mkdir(outDir, { recursive: true });

  const lines: string[] = [];
  lines.push("# Score Predictiveness Report");
  lines.push("");
  lines.push(`Window: last ${days} days (since ${since.toISOString()})`);
  lines.push("");
  lines.push("## Data coverage");
  lines.push(`- Closed PaperTrade rows with markout12h or pnlPct: ${rows.length}`);
  lines.push(`- Open PaperTrade rows in window (not yet evaluable): ${openPaperTrades}`);
  lines.push(
    `- ShadowCandidate rows in window by source: ${shadowSummary
      .map((x) => `${x.candidateSource}=${x._count.id}`)
      .join(", ")}`
  );
  if (rows.length === 0) {
    lines.push("- Limitation: no closed paper trades with outcome fields in this window; only opened trades may exist.");
  }
  lines.push("- Note: predictiveness metrics are based on closed paper trades with outcomes; this is still conditional on admission.");
  lines.push("");
  lines.push("## Bucket table");
  lines.push("| Score bucket | n | avg markout | hit rate | avg pnlPct |");
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
    `- top 10% vs bottom 10% (n per side=${topVsBottom.decileN}): avg markout ${fmt(
      topVsBottom.topAvgMarkout
    )} vs ${fmt(topVsBottom.bottomAvgMarkout)}, hit rate ${fmt(topVsBottom.topHitRate, 4)} vs ${fmt(
      topVsBottom.bottomHitRate,
      4
    )}, avg pnlPct ${fmt(topVsBottom.topAvgPnlPct)} vs ${fmt(topVsBottom.bottomAvgPnlPct)}`
  );
  lines.push("");
  lines.push("## Summary");
  if (rows.length < 20) {
    lines.push("- Sample is small; treat inferred predictiveness as directional only.");
  } else if (corr == null) {
    lines.push("- Correlation is not computable from current markout data (insufficient variance or missing values).");
  } else if (corr > 0.05) {
    lines.push("- Score shows positive directional relationship with forward outcome in this window.");
  } else if (corr < -0.05) {
    lines.push("- Score shows negative relationship with forward outcome in this window.");
  } else {
    lines.push("- Score-to-outcome relationship appears weak/flat in this window.");
  }

  await fs.writeFile(outPath, lines.join("\n"), "utf8");
  console.log(`Wrote ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
