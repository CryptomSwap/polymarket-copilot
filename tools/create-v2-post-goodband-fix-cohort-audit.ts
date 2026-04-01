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

async function detectPostChangeStart(): Promise<{ start: Date | null; rule: string }> {
  const explicit = process.env.PAPER_POST_GOODBAND_FIX_START?.trim();
  if (explicit) {
    const d = new Date(explicit);
    if (!Number.isNaN(d.getTime())) {
      return { start: d, rule: "explicit env PAPER_POST_GOODBAND_FIX_START" };
    }
  }
  try {
    const candidatesStat = await fs.stat(path.join(process.cwd(), "lib", "paper-trading", "candidates.ts"));
    const composeStat = await fs.stat(path.join(process.cwd(), "docker-compose.yml"));
    const start = new Date(Math.max(candidatesStat.mtime.getTime(), composeStat.mtime.getTime()));
    return { start, rule: "max(mtime(candidates.ts), mtime(docker-compose.yml)) fallback proxy" };
  } catch {
    return { start: null, rule: "no explicit start and fallback mtime detection failed" };
  }
}

async function main(): Promise<void> {
  const generatedAt = new Date().toISOString();
  const startMeta = await detectPostChangeStart();
  if (!startMeta.start) {
    throw new Error("Could not determine post-change cohort start. Set PAPER_POST_GOODBAND_FIX_START.");
  }

  const all = await prisma.paperTrade.findMany({
    where: { dedupeKey: { contains: "|v2|" } },
    select: {
      createdAt: true,
      status: true,
      entryPrice: true,
      entryPriceBand: true,
      markout12h: true,
    },
    orderBy: { createdAt: "asc" },
    take: 20000,
  });

  const post = all.filter((r) => r.createdAt >= startMeta.start!);
  const prePool = all.filter((r) => r.createdAt < startMeta.start!);
  const pre = prePool.slice(Math.max(0, prePool.length - post.length));

  const summarize = (rows: typeof all) => {
    const opens = rows.length;
    const closedRows = rows.filter((r) => r.status === "closed");
    const closed = closedRows.length;
    const closeRate = opens > 0 ? closed / opens : null;

    const byBand = BANDS.map((b) => {
      const inBand = rows.filter((r) => classifyBand(r.entryPrice, r.entryPriceBand) === b);
      const outcomes = inBand
        .map((r) => (r.status === "closed" ? parseNum(r.markout12h) : null))
        .filter((x): x is number => x != null);
      const outcomeSum = outcomes.reduce((a, c) => a + c, 0);
      return {
        band: b,
        count: inBand.length,
        avgOutcome: avg(outcomes),
        outcomeSum,
      };
    });

    const totalOutcome = byBand.reduce((a, b) => a + b.outcomeSum, 0);
    const contribution = Object.fromEntries(
      byBand.map((b) => [b.band, totalOutcome !== 0 ? b.outcomeSum / totalOutcome : null])
    ) as Record<Band, number | null>;
    const countByBand = Object.fromEntries(byBand.map((b) => [b.band, b.count])) as Record<Band, number>;
    const avgOutcomeByBand = Object.fromEntries(byBand.map((b) => [b.band, b.avgOutcome])) as Record<Band, number | null>;
    const openShares = Object.fromEntries(
      byBand.map((b) => [b.band, opens > 0 ? b.count / opens : null])
    ) as Record<Band, number | null>;
    const overallOutcomes = closedRows.map((r) => parseNum(r.markout12h)).filter((x): x is number => x != null);

    return {
      opens,
      closed,
      closeRate,
      countByBand,
      avgOutcomeByBand,
      contribution,
      openShares,
      overallAvg: avg(overallOutcomes),
      timeStart: rows.length ? rows[0]!.createdAt : null,
      timeEnd: rows.length ? rows[rows.length - 1]!.createdAt : null,
    };
  };

  const sPost = summarize(post);
  const sPre = summarize(pre);

  let dominantShift: { band: Band; deltaPp: number } | null = null;
  for (const b of BANDS) {
    const preShare = sPre.openShares[b] ?? 0;
    const postShare = sPost.openShares[b] ?? 0;
    const deltaPp = (postShare - preShare) * 100;
    if (!dominantShift || Math.abs(deltaPp) > Math.abs(dominantShift.deltaPp)) {
      dominantShift = { band: b, deltaPp };
    }
  }

  let conclusion: "post-change cohort improved" | "no meaningful change yet" | "evidence insufficient";
  const postN = sPost.opens;
  const preN = sPre.opens;
  const postAvg = sPost.overallAvg ?? 0;
  const preAvg = sPre.overallAvg ?? 0;
  const delta = postAvg - preAvg;
  if (postN < 30 || preN < 30 || sPost.closed < 15 || sPre.closed < 15) {
    conclusion = "evidence insufficient";
  } else if (delta > 0.0005) {
    conclusion = "post-change cohort improved";
  } else if (Math.abs(delta) <= 0.0005) {
    conclusion = "no meaningful change yet";
  } else {
    conclusion = "no meaningful change yet";
  }

  const lines: string[] = [];
  lines.push("# V2 post-goodband-fix cohort audit");
  lines.push("");
  lines.push(`- Generated: ${generatedAt}`);
  lines.push("");
  lines.push("## A. Post-change cohort definition");
  lines.push(`- post-change start: ${startMeta.start.toISOString()}`);
  lines.push(`- start rule: ${startMeta.rule}`);
  lines.push("- cohort intent: rows after low-extreme final-selection bias + dedupe good-band preference activation (timestamp-proxy anchored)");
  lines.push("");
  lines.push("## B. Flow (post-change only)");
  lines.push(`- opens: ${sPost.opens}`);
  lines.push(`- closed: ${sPost.closed}`);
  lines.push(`- close rate: ${pct(sPost.closeRate)}`);
  lines.push(`- time span: ${sPost.timeStart ? sPost.timeStart.toISOString() : "-"} -> ${sPost.timeEnd ? sPost.timeEnd.toISOString() : "-"}`);
  lines.push("");
  lines.push("## C. Post-change performance by band");
  lines.push("| band | count | avg markout/proxy | contribution share |");
  lines.push("| --- | ---: | ---: | ---: |");
  for (const b of BANDS) {
    lines.push(
      `| ${b} | ${sPost.countByBand[b]} | ${fmt(sPost.avgOutcomeByBand[b])} | ${pct(sPost.contribution[b])} |`
    );
  }
  lines.push("");
  lines.push("## D. Post vs pre (size-matched)");
  lines.push(`- pre cohort opens: ${sPre.opens}`);
  lines.push(`- pre cohort closed: ${sPre.closed}`);
  lines.push(`- pre cohort close rate: ${pct(sPre.closeRate)}`);
  lines.push(`- pre overall avg markout/proxy: ${fmt(sPre.overallAvg)}`);
  lines.push(`- post overall avg markout/proxy: ${fmt(sPost.overallAvg)}`);
  lines.push(`- delta post-minus-pre: ${fmt(delta)}`);
  lines.push("");
  lines.push("| band | pre count | post count | pre share | post share | delta share (pp) |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: |");
  for (const b of BANDS) {
    const preShare = sPre.openShares[b];
    const postShare = sPost.openShares[b];
    const deltaPp = ((postShare ?? 0) - (preShare ?? 0)) * 100;
    lines.push(
      `| ${b} | ${sPre.countByBand[b]} | ${sPost.countByBand[b]} | ${pct(preShare)} | ${pct(postShare)} | ${deltaPp.toFixed(2)} |`
    );
  }
  lines.push("");
  lines.push("## E. Dominant band shift");
  lines.push(
    dominantShift
      ? `- ${dominantShift.band}: ${dominantShift.deltaPp >= 0 ? "+" : ""}${dominantShift.deltaPp.toFixed(2)} pp (post vs pre open-share)`
      : "- insufficient data"
  );
  lines.push("");
  lines.push("## F. Blunt conclusion");
  lines.push(`**${conclusion}**`);
  lines.push("");

  const outPath = path.join(process.cwd(), "diagnostics", "v2-post-goodband-fix-cohort-audit.md");
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, lines.join("\n"), "utf8");
  console.log(`Wrote ${outPath}`);
}

main()
  .catch((err) => {
    console.error("Failed to build v2-post-goodband-fix-cohort-audit:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

