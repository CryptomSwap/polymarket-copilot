import "dotenv/config";
import * as fs from "fs/promises";
import * as path from "path";
import { prisma } from "../lib/db";

type Band = "<0.1" | "0.1-0.2" | "0.2-0.3" | "0.3-0.4" | "0.4-0.6" | "0.6-0.8" | "0.8-0.9" | ">=0.9";
const BANDS: Band[] = ["<0.1", "0.1-0.2", "0.2-0.3", "0.3-0.4", "0.4-0.6", "0.6-0.8", "0.8-0.9", ">=0.9"];

function parseNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number.parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}
function avg(nums: number[]): number | null {
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}
function winRate(nums: number[]): number | null {
  if (!nums.length) return null;
  return nums.filter((x) => x > 0).length / nums.length;
}
function fmt(n: number | null, d = 6): string {
  return n == null ? "-" : n.toFixed(d);
}
function pct(n: number | null): string {
  return n == null ? "-" : `${(n * 100).toFixed(2)}%`;
}
function classifyBand(entryPrice: string | null, fallbackBand: string | null): Band | null {
  const fb = (fallbackBand ?? "").trim();
  if (BANDS.includes(fb as Band)) return fb as Band;
  const p = parseNum(entryPrice);
  if (p == null) return null;
  if (p < 0.1) return "<0.1";
  if (p < 0.2) return "0.1-0.2";
  if (p < 0.3) return "0.2-0.3";
  if (p < 0.4) return "0.3-0.4";
  if (p < 0.6) return "0.4-0.6";
  if (p < 0.8) return "0.6-0.8";
  if (p < 0.9) return "0.8-0.9";
  return ">=0.9";
}

async function main(): Promise<void> {
  const n = Math.max(10, parseInt(process.env.PAPER_V2_BASELINE_V2_ROWS ?? "100", 10));
  const generatedAt = new Date().toISOString();

  const rowsDesc = await prisma.paperTrade.findMany({
    where: { dedupeKey: { contains: "|v2|" } },
    orderBy: { createdAt: "desc" },
    take: n,
    select: {
      id: true,
      createdAt: true,
      status: true,
      score: true,
      entryPrice: true,
      entryPriceBand: true,
      markout12h: true,
    },
  });
  const rows = [...rowsDesc].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const minTs = rows.length ? rows[0]!.createdAt : null;
  const maxTs = rows.length ? rows[rows.length - 1]!.createdAt : null;

  const opens = rows.length;
  const closed = rows.filter((r) => r.status === "closed").length;
  const closeRate = opens ? closed / opens : null;

  const closedRows = rows.filter((r) => r.status === "closed");
  const proxyByBand = new Map<Band, number[]>();
  for (const r of closedRows) {
    const b = classifyBand(r.entryPrice, r.entryPriceBand);
    const m = parseNum(r.markout12h);
    if (!b || m == null) continue;
    const arr = proxyByBand.get(b) ?? [];
    arr.push(m);
    proxyByBand.set(b, arr);
  }

  const perfRows = BANDS.map((b) => {
    const inBand = rows.filter((r) => classifyBand(r.entryPrice, r.entryPriceBand) === b);
    const outcomes = inBand
      .map((r) => (r.status === "closed" ? parseNum(r.markout12h) : null))
      .filter((x): x is number => x != null);
    const scores = inBand.map((r) => r.score).filter((x): x is number => x != null);
    return {
      band: b,
      count: inBand.length,
      avgOutcome: avg(outcomes),
      winRate: winRate(outcomes),
      avgScore: avg(scores),
      pnlSum: outcomes.reduce((a, c) => a + c, 0),
    };
  });
  const totalPnl = perfRows.reduce((a, r) => a + r.pnlSum, 0);

  const overallOutcomes = closedRows
    .map((r) => parseNum(r.markout12h))
    .filter((x): x is number => x != null);
  const overallAvg = avg(overallOutcomes);

  let conclusion = "insufficient";
  if (overallOutcomes.length >= 20) {
    if ((overallAvg ?? 0) > 0.002) conclusion = "signal present";
    else if ((overallAvg ?? 0) > 0) conclusion = "weak signal";
    else conclusion = "no signal";
  }

  const lines: string[] = [];
  lines.push("# V2 Post-Fix Performance Baseline V2");
  lines.push("");
  lines.push(`- Generated: ${generatedAt}`);
  lines.push("");
  lines.push("## A. Cohort definition");
  lines.push(`- Cohort rule: last ${n} rows where dedupeKey contains '|v2|'`);
  lines.push(`- Actual rows in cohort: ${rows.length}`);
  lines.push(`- Time span: ${minTs ? minTs.toISOString() : "-"} -> ${maxTs ? maxTs.toISOString() : "-"}`);
  lines.push("");
  lines.push("## B. Flow");
  lines.push(`- opens: ${opens}`);
  lines.push(`- closed: ${closed}`);
  lines.push(`- close rate: ${pct(closeRate)}`);
  lines.push("");
  lines.push("## C. Performance by band");
  lines.push("| band | count | avg markout/proxy | win rate |");
  lines.push("| --- | ---: | ---: | ---: |");
  for (const r of perfRows) {
    lines.push(`| ${r.band} | ${r.count} | ${fmt(r.avgOutcome)} | ${pct(r.winRate)} |`);
  }
  lines.push("");
  lines.push("## D. Contribution");
  lines.push("| band | PnL contribution share |");
  lines.push("| --- | ---: |");
  for (const r of perfRows) {
    const share = totalPnl !== 0 ? r.pnlSum / totalPnl : null;
    lines.push(`| ${r.band} | ${pct(share)} |`);
  }
  lines.push("");
  lines.push("## E. Score info");
  lines.push("| band | avg score used |");
  lines.push("| --- | ---: |");
  for (const r of perfRows) {
    lines.push(`| ${r.band} | ${fmt(r.avgScore)} |`);
  }
  lines.push("");
  lines.push("## F. Blunt conclusion");
  lines.push(`- ${conclusion}`);

  const outDir = path.join(process.cwd(), "diagnostics");
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, "v2-post-fix-performance-baseline-v2.md");
  await fs.writeFile(outPath, lines.join("\n"), "utf8");
  console.log(`Wrote ${outPath}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

