/**
 * Read-only: V2 + structured-scorer live regime evaluation from PaperTrade only.
 * Run: npx tsx tools/create-v2-structured-live-regime-report.ts
 */
import "dotenv/config";
import * as fs from "fs/promises";
import * as path from "path";
import { prisma } from "../lib/db";

function parseNum(v: string | null | undefined): number | null {
  if (v == null || v === "") return null;
  const n = parseFloat(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

function avg(nums: number[]): number | null {
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function fmt(n: number | null, d = 6): string {
  return n == null ? "-" : n.toFixed(d);
}

function hitRateFromMarkoutOrPnl(markouts: Array<number | null>, pnls: Array<number | null>): number | null {
  const combined = markouts.map((m, i) => m ?? pnls[i] ?? null);
  const usable = combined.filter((x): x is number => x != null);
  if (usable.length === 0) return null;
  return usable.filter((x) => x > 0).length / usable.length;
}

function scoreBucket(score: number): string {
  if (score < 0.2) return "0.0-0.2";
  if (score < 0.4) return "0.2-0.4";
  if (score < 0.6) return "0.4-0.6";
  if (score < 0.8) return "0.6-0.8";
  return "0.8-1.0";
}

function priceBand(p: number): string {
  if (p < 0.1) return "<0.1";
  if (p < 0.2) return "0.1-0.2";
  if (p < 0.35) return "0.2-0.35";
  if (p < 0.5) return "0.35-0.5";
  if (p < 0.65) return "0.5-0.65";
  if (p < 0.8) return "0.65-0.8";
  if (p < 0.9) return "0.8-0.9";
  return ">=0.9";
}

type Row = {
  id: string;
  score: number;
  entryPrice: string;
  status: string;
  markout12h: string | null;
  pnlPct: string | null;
  botType: string;
  dedupeKey: string;
  createdAt: Date;
};

function cohortStats(rows: Row[]): {
  nTotal: number;
  nOpen: number;
  nClosed: number;
  nWithMarkout: number;
  avgMarkout: number | null;
  hitRate: number | null;
  avgPnlPct: number | null;
} {
  const nOpen = rows.filter((r) => r.status === "open").length;
  const closed = rows.filter((r) => r.status === "closed");
  const nClosed = closed.length;
  const markouts = closed.map((r) => parseNum(r.markout12h));
  const pnls = closed.map((r) => parseNum(r.pnlPct));
  const withM = markouts.filter((x) => x != null).length;
  const usableMarkout = markouts.filter((x): x is number => x != null);
  return {
    nTotal: rows.length,
    nOpen,
    nClosed,
    nWithMarkout: withM,
    avgMarkout: avg(usableMarkout),
    hitRate: hitRateFromMarkoutOrPnl(markouts, pnls),
    avgPnlPct: avg(pnls.filter((x): x is number => x != null)),
  };
}

async function resolveRegimeStart(): Promise<{ since: Date; source: string }> {
  const envRaw = process.env.PAPER_V2_STRUCTURED_REGIME_SINCE?.trim();
  if (envRaw) {
    const d = new Date(envRaw);
    if (!Number.isFinite(d.getTime())) {
      throw new Error(`Invalid PAPER_V2_STRUCTURED_REGIME_SINCE: ${envRaw}`);
    }
    return { since: d, source: "env:PAPER_V2_STRUCTURED_REGIME_SINCE" };
  }

  const first = await prisma.paperTrade.findFirst({
    where: { dedupeKey: { contains: "|v2|" } },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true },
  });
  if (!first) {
    throw new Error(
      "No PaperTrade with dedupeKey containing '|v2|'. Set PAPER_V2_STRUCTURED_REGIME_SINCE (ISO 8601) to define regime start."
    );
  }
  return {
    since: first.createdAt,
    source:
      "inferred:min_createdAt_where_dedupeKey_contains_|v2| (approximate V2 start; set PAPER_V2_STRUCTURED_REGIME_SINCE when structured scorer + filters shipped)",
  };
}

async function main(): Promise<void> {
  const { since: regimeStart, source: regimeStartSource } = await resolveRegimeStart();

  const regimeRows = await prisma.paperTrade.findMany({
    where: {
      createdAt: { gte: regimeStart },
      dedupeKey: { contains: "|v2|" },
    },
    select: {
      id: true,
      score: true,
      entryPrice: true,
      status: true,
      markout12h: true,
      pnlPct: true,
      botType: true,
      dedupeKey: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  });

  const overall = cohortStats(regimeRows);

  const closedRegime = regimeRows.filter((r) => r.status === "closed");
  const baselineSize = Math.max(1, closedRegime.length);
  const baselineRows = await prisma.paperTrade.findMany({
    where: {
      createdAt: { lt: regimeStart },
      status: "closed",
      NOT: { dedupeKey: { contains: "|v2|" } },
    },
    select: {
      id: true,
      score: true,
      entryPrice: true,
      status: true,
      markout12h: true,
      pnlPct: true,
      botType: true,
      dedupeKey: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
    take: baselineSize,
  });

  const baseline = cohortStats(baselineRows);

  const scoreBuckets = new Map<string, Row[]>();
  for (const r of regimeRows) {
    const b = scoreBucket(r.score);
    scoreBuckets.set(b, [...(scoreBuckets.get(b) ?? []), r]);
  }
  const scoreOrder = ["0.0-0.2", "0.2-0.4", "0.4-0.6", "0.6-0.8", "0.8-1.0"];

  const priceBands = new Map<string, Row[]>();
  for (const r of regimeRows) {
    const ep = parseNum(r.entryPrice);
    const b = ep == null ? "unknown" : priceBand(ep);
    priceBands.set(b, [...(priceBands.get(b) ?? []), r]);
  }
  const priceOrder = ["0.1-0.2", "0.2-0.35", "0.35-0.5", "0.5-0.65", "0.65-0.8", "0.8-0.9"];

  const byBot = new Map<string, Row[]>();
  for (const r of regimeRows) {
    byBot.set(r.botType, [...(byBot.get(r.botType) ?? []), r]);
  }

  const outDir = path.join(process.cwd(), "dump", "repo-exploration-pack");
  const outPath = path.join(outDir, "13-v2-structured-live-regime-report.md");
  await fs.mkdir(outDir, { recursive: true });

  const lines: string[] = [];
  lines.push("# V2 Structured Live Regime Report");
  lines.push("");
  lines.push("## Regime definition");
  lines.push(`- **PaperTrade only**; V2 cohort: \`dedupeKey\` contains \`|v2|\`.`);
  lines.push(`- **Regime start:** ${regimeStart.toISOString()}`);
  lines.push(`- **Start source:** ${regimeStartSource}`);
  lines.push("");
  lines.push("## 1. Overall cohort stats (V2 regime)");
  lines.push(`- n rows (opens recorded): ${overall.nTotal}`);
  lines.push(`- n status=open: ${overall.nOpen}`);
  lines.push(`- n status=closed: ${overall.nClosed}`);
  lines.push(`- n closed with non-null markout12h: ${overall.nWithMarkout}`);
  lines.push(`- avg markout (closed, markout12h): ${fmt(overall.avgMarkout)}`);
  lines.push(`- hit rate (closed, markout>0 or pnlPct>0 when markout null): ${fmt(overall.hitRate, 4)}`);
  lines.push(`- avg pnlPct (closed): ${fmt(overall.avgPnlPct)}`);
  lines.push("");
  lines.push("## 2. Score bucket table (V2 regime, all rows)");
  lines.push("| score bucket | n | avg markout | hit rate | avg pnlPct |");
  lines.push("| --- | ---: | ---: | ---: | ---: |");
  for (const b of scoreOrder) {
    const rs = scoreBuckets.get(b) ?? [];
    const closed = rs.filter((r) => r.status === "closed");
    const ms = closed.map((r) => parseNum(r.markout12h));
    const ps = closed.map((r) => parseNum(r.pnlPct));
    lines.push(
      `| ${b} | ${rs.length} | ${fmt(avg(ms.filter((x): x is number => x != null)))} | ${fmt(
        hitRateFromMarkoutOrPnl(ms, ps),
        4
      )} | ${fmt(avg(ps.filter((x): x is number => x != null)))} |`
    );
  }
  lines.push("");
  lines.push("## 3. By price band (entryPrice, V2 regime)");
  lines.push("| price band | n | n closed | avg markout | hit rate |");
  lines.push("| --- | ---: | ---: | ---: | ---: |");
  for (const b of priceOrder) {
    const rs = priceBands.get(b) ?? [];
    const closed = rs.filter((r) => r.status === "closed");
    const ms = closed.map((r) => parseNum(r.markout12h));
    const ps = closed.map((r) => parseNum(r.pnlPct));
    lines.push(
      `| ${b} | ${rs.length} | ${closed.length} | ${fmt(
        avg(ms.filter((x): x is number => x != null))
      )} | ${fmt(hitRateFromMarkoutOrPnl(ms, ps), 4)} |`
    );
  }
  const otherPrice = [...priceBands.entries()].filter(([k]) => !priceOrder.includes(k));
  if (otherPrice.length > 0) {
    lines.push("### Other price bands (outside listed ranges)");
    for (const [b, rs] of otherPrice.sort((a, b) => a[0].localeCompare(b[0]))) {
      const closed = rs.filter((r) => r.status === "closed");
      const ms = closed.map((r) => parseNum(r.markout12h));
      const ps = closed.map((r) => parseNum(r.pnlPct));
      lines.push(
        `- **${b}**: n=${rs.length}, closed=${closed.length}, avg markout=${fmt(
          avg(ms.filter((x): x is number => x != null))
        )}, hit rate=${fmt(hitRateFromMarkoutOrPnl(ms, ps), 4)}`
      );
    }
  }
  lines.push("");
  lines.push("## 4. By botType (V2 regime)");
  lines.push("| botType | n | n closed | avg markout | hit rate | avg pnlPct |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: |");
  for (const [bot, rs] of [...byBot.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const s = cohortStats(rs);
    lines.push(
      `| ${bot} | ${s.nTotal} | ${s.nClosed} | ${fmt(s.avgMarkout)} | ${fmt(s.hitRate, 4)} | ${fmt(s.avgPnlPct)} |`
    );
  }
  lines.push("");
  lines.push("## 5. Baseline comparison (pre-change)");
  lines.push(
    `- Baseline: most recent **${baselineRows.length}** **closed** PaperTrades with \`createdAt < regime start\` and **no** \`|v2|\` in \`dedupeKey\` (target size ≈ regime closed count = ${baselineSize}).`
  );
  lines.push(`- Baseline n (returned): ${baseline.nTotal}`);
  lines.push(`- Baseline avg markout: ${fmt(baseline.avgMarkout)}`);
  lines.push(`- Baseline hit rate: ${fmt(baseline.hitRate, 4)}`);
  lines.push(`- Baseline avg pnlPct: ${fmt(baseline.avgPnlPct)}`);
  lines.push("");
  lines.push("| metric | V2 regime (closed) | Baseline (pre-V2-dedupe, closed) |");
  lines.push("| --- | ---: | ---: |");
  lines.push(`| n | ${overall.nClosed} | ${baseline.nClosed} |`);
  lines.push(`| avg markout | ${fmt(overall.avgMarkout)} | ${fmt(baseline.avgMarkout)} |`);
  lines.push(`| hit rate | ${fmt(overall.hitRate, 4)} | ${fmt(baseline.hitRate, 4)} |`);
  lines.push(`| avg pnlPct | ${fmt(overall.avgPnlPct)} | ${fmt(baseline.avgPnlPct)} |`);
  lines.push("");
  lines.push("## 6. Limitations");
  lines.push(
    "- **Open rows** in the regime have no markout yet; overall performance stats need closed rows."
  );
  lines.push(
    "- **Admission-conditioned:** only trades that were admitted to paper are observed; scores and price filters affect who appears."
  );
  lines.push(
    "- **Structured scorer:** \`PaperTrade.score\` is persisted at open; structured vs shadow ML is not re-identified from DB alone—this report treats all \`|v2|\` rows as the post-V2-minimal regime."
  );
  lines.push(
    "- **Regime start:** if not set via `PAPER_V2_STRUCTURED_REGIME_SINCE`, start is the **earliest** row with \`|v2|\` in \`dedupeKey\`, which may predate structured scorer + adaptive filter + dedupe pre-insert if those shipped later—**set env for a precise cutoff**."
  );
  lines.push(
    "- **Metadata coverage:** markout/pnlPct depend on close path and snapshots; missing markout reduces `nWithMarkout` and interpretability."
  );

  await fs.writeFile(outPath, lines.join("\n"), "utf8");
  console.log(`Wrote ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
