import "dotenv/config";
import * as fs from "fs/promises";
import * as path from "path";
import { prisma } from "../lib/db";
import { runPaperTradingTickV2 } from "../lib/paper-trading/engine_v2_minimal";

type Row = {
  id: string;
  score: number;
  entryPrice: string;
  status: string;
  markout12h: string | null;
  pnlPct: string | null;
  dedupeKey: string;
  createdAt: Date;
};

const BANDS = ["<0.1", "0.1-0.2", "0.2-0.3", "0.3-0.4", "0.4-0.6", "0.6-0.8", "0.8-0.9", ">=0.9"] as const;

function parseNum(v: string | null | undefined): number | null {
  if (v == null || v === "") return null;
  const n = parseFloat(String(v).trim());
  return Number.isFinite(n) ? n : null;
}
function avg(nums: number[]): number | null {
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}
function median(nums: number[]): number | null {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
function pct(n: number | null): string {
  return n == null ? "-" : `${(n * 100).toFixed(2)}%`;
}
function fmt(n: number | null, d = 6): string {
  return n == null ? "-" : n.toFixed(d);
}
function outcome(r: Pick<Row, "markout12h" | "pnlPct">): number | null {
  return parseNum(r.markout12h) ?? parseNum(r.pnlPct);
}
function bandOf(price: number | null): string {
  if (price == null) return "unknown";
  if (price < 0.1) return "<0.1";
  if (price < 0.2) return "0.1-0.2";
  if (price < 0.3) return "0.2-0.3";
  if (price < 0.4) return "0.3-0.4";
  if (price < 0.6) return "0.4-0.6";
  if (price < 0.8) return "0.6-0.8";
  if (price < 0.9) return "0.8-0.9";
  return ">=0.9";
}
function scoreBucket(score: number): string {
  if (score < 0.2) return "[0.0,0.2)";
  if (score < 0.4) return "[0.2,0.4)";
  if (score < 0.6) return "[0.4,0.6)";
  if (score < 0.8) return "[0.6,0.8)";
  return "[0.8,1.0]";
}

async function resolveRegimeStart(): Promise<Date> {
  const envRaw = process.env.PAPER_V2_STRUCTURED_REGIME_SINCE?.trim();
  if (envRaw) {
    const d = new Date(envRaw);
    if (Number.isFinite(d.getTime())) return d;
  }
  const first = await prisma.paperTrade.findFirst({
    where: { dedupeKey: { contains: "|v2|" } },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true },
  });
  if (!first) throw new Error("No V2 rows found (dedupeKey contains |v2|).");
  return first.createdAt;
}

async function main(): Promise<void> {
  const generatedAt = new Date().toISOString();
  const regimeStart = await resolveRegimeStart();
  const rows = (await prisma.paperTrade.findMany({
    where: {
      dedupeKey: { contains: "|v2|" },
      createdAt: { gte: regimeStart },
      status: "closed",
      OR: [{ markout12h: { not: null } }, { pnlPct: { not: null } }],
    },
    select: {
      id: true,
      score: true,
      entryPrice: true,
      status: true,
      markout12h: true,
      pnlPct: true,
      dedupeKey: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  })) as Row[];

  const winners = rows.filter((r) => (outcome(r) ?? 0) > 0);
  const losers = rows.filter((r) => (outcome(r) ?? 0) <= 0);
  const buckets = new Map<string, Row[]>();
  for (const r of rows) {
    const b = scoreBucket(r.score);
    buckets.set(b, [...(buckets.get(b) ?? []), r]);
  }
  const bucketRows = [...buckets.entries()]
    .map(([bucket, rs]) => {
      const os = rs.map(outcome).filter((x): x is number => x != null);
      return {
        bucket,
        count: rs.length,
        avgMarkout: avg(os),
        medianMarkout: median(os),
        winRate: os.length ? os.filter((x) => x > 0).length / os.length : null,
      };
    })
    .sort((a, b) => a.bucket.localeCompare(b.bucket));
  const sortedByScore = [...rows].sort((a, b) => a.score - b.score);
  const k = Math.max(1, Math.floor(sortedByScore.length * 0.2));
  const low = sortedByScore.slice(0, k);
  const high = sortedByScore.slice(sortedByScore.length - k);
  const toStats = (x: Row[]) => {
    const os = x.map(outcome).filter((v): v is number => v != null);
    return { n: x.length, avgMarkout: avg(os), winRate: os.length ? os.filter((v) => v > 0).length / os.length : null };
  };
  const highStats = toStats(high);
  const lowStats = toStats(low);
  const monotonicityCheck = (() => {
    if (bucketRows.length < 3) return "insufficient_buckets";
    const ordered = [...bucketRows].sort((a, b) => a.bucket.localeCompare(b.bucket));
    let nonDecreasing = true;
    for (let i = 1; i < ordered.length; i++) {
      const prev = ordered[i - 1]!.avgMarkout ?? -Infinity;
      const cur = ordered[i]!.avgMarkout ?? -Infinity;
      if (cur < prev) nonDecreasing = false;
    }
    return nonDecreasing ? "monotone_non_decreasing" : "not_monotone";
  })();

  const inBand = BANDS.map((band) => {
    const bandRows = rows.filter((r) => bandOf(parseNum(r.entryPrice)) === band);
    if (bandRows.length < 6) return { band, count: bandRows.length, note: "insufficient_sample" as const };
    const s = [...bandRows].sort((a, b) => a.score - b.score);
    const hk = Math.max(1, Math.floor(s.length / 2));
    const lo = s.slice(0, hk);
    const hi = s.slice(s.length - hk);
    const osHi = hi.map(outcome).filter((x): x is number => x != null);
    const osLo = lo.map(outcome).filter((x): x is number => x != null);
    return {
      band,
      count: bandRows.length,
      highHalfAvgMarkout: avg(osHi),
      lowHalfAvgMarkout: avg(osLo),
      highHalfWinRate: osHi.length ? osHi.filter((x) => x > 0).length / osHi.length : null,
      lowHalfWinRate: osLo.length ? osLo.filter((x) => x > 0).length / osLo.length : null,
    };
  });

  // Dry-run live tick for composition (no writes).
  const tick = await runPaperTradingTickV2({ dryRun: true });

  const lines: string[] = [];
  lines.push("# V2 Shadow ML Ranking Audit");
  lines.push("");
  lines.push(`- Generated: ${generatedAt}`);
  lines.push(`- Cohort: closed V2 PaperTrade rows since ${regimeStart.toISOString()} (dedupeKey contains |v2|)`);
  lines.push(`- Live scorer gate now: PAPER_TRADING_USE_STRUCTURED_SCORER=${process.env.PAPER_TRADING_USE_STRUCTURED_SCORER ?? "(unset->false)"}`);
  lines.push("");
  lines.push("## A. Global ranking quality");
  lines.push(`- count: ${rows.length}`);
  lines.push(`- winners: ${winners.length}`);
  lines.push(`- losers: ${losers.length}`);
  lines.push(`- winner mean/median score: ${fmt(avg(winners.map((r) => r.score)))} / ${fmt(median(winners.map((r) => r.score)))}`);
  lines.push(`- loser mean/median score: ${fmt(avg(losers.map((r) => r.score)))} / ${fmt(median(losers.map((r) => r.score)))}`);
  lines.push("");
  lines.push("| score bucket | count | avg markout | median markout | win rate |");
  lines.push("| --- | ---: | ---: | ---: | ---: |");
  for (const r of bucketRows) {
    lines.push(`| ${r.bucket} | ${r.count} | ${fmt(r.avgMarkout)} | ${fmt(r.medianMarkout)} | ${pct(r.winRate)} |`);
  }
  lines.push("");
  lines.push(`- top-vs-bottom (20% tails, n=${k} each): avg markout ${fmt(highStats.avgMarkout)} vs ${fmt(lowStats.avgMarkout)}, win rate ${pct(highStats.winRate)} vs ${pct(lowStats.winRate)}`);
  lines.push(`- monotonicity check: ${monotonicityCheck}`);
  lines.push("");
  lines.push("## B. In-band ranking quality");
  lines.push("| band | count | high-half avg markout | low-half avg markout | high-half win rate | low-half win rate | note |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | --- |");
  for (const r of inBand) {
    lines.push(
      `| ${r.band} | ${r.count} | ${"highHalfAvgMarkout" in r ? fmt(r.highHalfAvgMarkout ?? null) : "-"} | ${"lowHalfAvgMarkout" in r ? fmt(r.lowHalfAvgMarkout ?? null) : "-"} | ${"highHalfWinRate" in r ? pct(r.highHalfWinRate ?? null) : "-"} | ${"lowHalfWinRate" in r ? pct(r.lowHalfWinRate ?? null) : "-"} | ${"note" in r ? r.note : ""} |`
    );
  }
  lines.push("");
  lines.push("## C. Orientation sanity check");
  lines.push("- Intended orientation: higher `shadowMlScore` should be better (probability-like score from logistic model).");
  lines.push("- Live sort direction in V2 code: descending by `score` (`passedFilter.sort((a,b)=>b.score-a.score)`).");
  lines.push("- Threshold check direction: reject when `score < threshold`.");
  lines.push(`- Evidence flag (global): ${highStats.avgMarkout != null && lowStats.avgMarkout != null && highStats.avgMarkout < lowStats.avgMarkout ? "higher score performs worse in global tails (inversion)" : "no global inversion signal in tails"}`);
  lines.push("");
  lines.push("## D. Composition effects (live dry-run snapshot)");
  lines.push(`- live scorer source: ${tick.scorePopulationSnapshot?.scorerSource ?? "-"}`);
  lines.push(`- unique candidates scored: ${tick.scorePopulationSnapshot?.uniqueCandidatesScored ?? 0}`);
  lines.push(`- score buckets all candidates (pre-admission): \`${JSON.stringify(tick.scorePopulationSnapshot?.scoreBucketCountsAllCandidates ?? {})}\``);
  lines.push(`- score buckets admitted traces: \`${JSON.stringify(tick.scorePopulationSnapshot?.scoreBucketCountsFromTraceAdmitted ?? {})}\``);
  lines.push(`- score buckets rejected traces: \`${JSON.stringify(tick.scorePopulationSnapshot?.scoreBucketCountsFromTraceRejected ?? {})}\``);
  lines.push("- Interpretation constraint: filters/rejections change composition of admitted set, but do not overwrite score values.");
  lines.push("");
  lines.push("## E. Blunt conclusion");
  const worksInBand = inBand.some((r) => "highHalfAvgMarkout" in r && (r.highHalfAvgMarkout ?? -Infinity) > (r.lowHalfAvgMarkout ?? Infinity));
  const globalInverted =
    highStats.avgMarkout != null && lowStats.avgMarkout != null && highStats.avgMarkout < lowStats.avgMarkout;
  let conclusion = "evidence insufficient";
  if (worksInBand && globalInverted) conclusion = "shadow_ml works in-band but fails cross-band";
  else if (globalInverted) conclusion = "shadow_ml is inverted globally";
  else if (!worksInBand && Math.abs((avg(winners.map((r) => r.score)) ?? 0) - (avg(losers.map((r) => r.score)) ?? 0)) < 1e-6) conclusion = "shadow_ml has no usable separation";
  else conclusion = "shadow_ml is directionally correct but poorly calibrated";
  lines.push(`- ${conclusion}`);

  const outDir = path.join(process.cwd(), "diagnostics");
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, "v2-shadow-ml-ranking-audit.md");
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
