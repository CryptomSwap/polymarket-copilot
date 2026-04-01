import "dotenv/config";
import * as fs from "fs/promises";
import * as path from "path";
import { prisma } from "../lib/db";
import {
  runPaperTradingTickV2,
  type PaperTickV2RejectReason,
  type PaperTickV2TraceEntry,
} from "../lib/paper-trading/engine_v2_minimal";

const BANDS = ["<0.1", "0.1-0.2", "0.2-0.3", "0.3-0.4", "0.4-0.6", "0.6-0.8", "0.8-0.9", ">=0.9"] as const;
const GOOD_BANDS = ["0.4-0.6", "0.2-0.3"] as const;

type BandKey = (typeof BANDS)[number] | "unknown";

type TraceRow = PaperTickV2TraceEntry & {
  tick: number;
  band: BandKey;
  scoreResolved: number | null;
  eligible: boolean;
  alreadyOpen: boolean;
};

function parseNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number.parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

function avg(nums: number[]): number | null {
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function quantile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * q)));
  return sorted[idx]!;
}

function summarizeScores(values: number[]): { n: number; min: number; max: number; mean: number; std: number; p25: number | null; p50: number | null; p75: number | null } {
  const xs = values.filter((x) => Number.isFinite(x));
  if (xs.length === 0) return { n: 0, min: 0, max: 0, mean: 0, std: 0, p25: null, p50: null, p75: null };
  const min = Math.min(...xs);
  const max = Math.max(...xs);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / xs.length;
  const sorted = [...xs].sort((a, b) => a - b);
  return {
    n: xs.length,
    min,
    max,
    mean,
    std: Math.sqrt(Math.max(0, variance)),
    p25: quantile(sorted, 0.25),
    p50: quantile(sorted, 0.5),
    p75: quantile(sorted, 0.75),
  };
}

function classifyBand(priceRaw: string | null, fallbackBand: string | null): BandKey {
  const fb = (fallbackBand ?? "").trim();
  if (BANDS.includes(fb as (typeof BANDS)[number])) return fb as BandKey;
  const p = parseNum(priceRaw);
  if (p == null) return "unknown";
  if (p < 0.1) return "<0.1";
  if (p < 0.2) return "0.1-0.2";
  if (p < 0.3) return "0.2-0.3";
  if (p < 0.4) return "0.3-0.4";
  if (p < 0.6) return "0.4-0.6";
  if (p < 0.8) return "0.6-0.8";
  if (p < 0.9) return "0.8-0.9";
  return ">=0.9";
}

function isPriceBandPreThresholdReject(r: PaperTickV2RejectReason | null): boolean {
  return r === "below_threshold" || r === "score_failed" || r === "liquidity_spread" || r === "liquidity_slippage";
}

function emptyBandCounts(): Record<string, number> {
  return Object.fromEntries([...BANDS, "unknown"].map((b) => [b, 0])) as Record<string, number>;
}

async function main(): Promise<void> {
  const generatedAt = new Date().toISOString();
  const ticks = Math.max(1, parseInt(process.env.PAPER_BREADTH_AUDIT_TICKS ?? "24", 10));
  const cadenceMs = Math.max(0, parseInt(process.env.PAPER_BREADTH_AUDIT_CADENCE_MS ?? "500", 10));

  const openRows = await prisma.paperTrade.findMany({
    where: { status: "open", dedupeKey: { contains: "|v2|" } },
    select: { botType: true, assetId: true, side: true, entryPrice: true, entryPriceBand: true },
  });
  const openExposureSet = new Set<string>();
  for (const r of openRows) {
    openExposureSet.add(`${r.botType}|${r.assetId}|${r.side}`);
  }

  const closedRows = await prisma.paperTrade.findMany({
    where: { status: "closed", dedupeKey: { contains: "|v2|" }, markout12h: { not: null } },
    select: { entryPrice: true, entryPriceBand: true, markout12h: true },
    take: 5000,
    orderBy: { createdAt: "desc" },
  });
  const bandProxyMarkout = new Map<string, number>();
  for (const b of BANDS) {
    const vals = closedRows
      .filter((r) => classifyBand(r.entryPrice, r.entryPriceBand) === b)
      .map((r) => parseNum(r.markout12h))
      .filter((x): x is number => x != null);
    if (vals.length) bandProxyMarkout.set(b, avg(vals)!);
  }

  let totalRawCandidatesSum = 0;
  const flatRows: TraceRow[] = [];
  const recommendationIdsPerTick: number[] = [];

  for (let tick = 0; tick < ticks; tick++) {
    const r = await runPaperTradingTickV2({ dryRun: true });
    totalRawCandidatesSum += r.candidatesLoaded;

    const bandByRec = new Map<string, BandKey>(
      (r.scoreProvenanceSample ?? []).map((p) => [p.recommendationId, (p.shadowBand as BandKey) ?? "unknown"])
    );
    const scoreByRec = new Map<string, number | null>(
      (r.scoreProvenanceSample ?? []).map((p) => [p.recommendationId, p.actualScoreUsedForOrdering ?? null])
    );

    const byRec = new Map<string, PaperTickV2TraceEntry[]>();
    for (const t of r.trace ?? []) {
      const arr = byRec.get(t.recommendationId) ?? [];
      arr.push(t);
      byRec.set(t.recommendationId, arr);
    }
    recommendationIdsPerTick.push(byRec.size);

    const eligibleByRec = new Map<string, boolean>();
    for (const [rec, rows] of byRec.entries()) {
      const eligible = rows.some((x) => x.admitted || !isPriceBandPreThresholdReject(x.rejectReason));
      eligibleByRec.set(rec, eligible);
    }

    for (const t of r.trace ?? []) {
      const recBand = bandByRec.get(t.recommendationId) ?? "unknown";
      const scoreResolved = scoreByRec.get(t.recommendationId) ?? t.score ?? null;
      const eligible = eligibleByRec.get(t.recommendationId) ?? false;
      const alreadyOpen = openExposureSet.has(`${t.botType}|${t.assetId}|${t.side}`);
      flatRows.push({
        ...t,
        tick,
        band: recBand,
        scoreResolved,
        eligible,
        alreadyOpen,
      });
    }

    if (tick < ticks - 1 && cadenceMs > 0) await new Promise((res) => setTimeout(res, cadenceMs));
  }

  const totalTraceRows = flatRows.length;
  const uniqueAssetIds = new Set(flatRows.map((x) => x.assetId)).size;
  const uniqueMarkets = new Set(flatRows.map((x) => x.marketId)).size;
  const uniqueRecs = new Set(flatRows.map((x) => x.recommendationId)).size;
  const uniqueAssetSide = new Set(flatRows.map((x) => `${x.assetId}|${x.side}`)).size;
  const uniqueBotAssetSide = new Set(flatRows.map((x) => `${x.botType}|${x.assetId}|${x.side}`)).size;

  const rowsByBand = emptyBandCounts();
  const uniqAssetByBand: Record<string, Set<string>> = {};
  const uniqMarketByBand: Record<string, Set<string>> = {};
  const uniqAssetSideByBand: Record<string, Set<string>> = {};
  for (const b of [...BANDS, "unknown"] as string[]) {
    uniqAssetByBand[b] = new Set();
    uniqMarketByBand[b] = new Set();
    uniqAssetSideByBand[b] = new Set();
  }
  for (const row of flatRows) {
    const b = row.band in rowsByBand ? row.band : "unknown";
    rowsByBand[b] = (rowsByBand[b] ?? 0) + 1;
    uniqAssetByBand[b]!.add(row.assetId);
    uniqMarketByBand[b]!.add(row.marketId);
    uniqAssetSideByBand[b]!.add(`${row.assetId}|${row.side}`);
  }

  let alreadyOpenRows = 0;
  let novelRows = 0;
  let eligibleRows = 0;
  let eligibleAlreadyOpen = 0;
  let eligibleNovel = 0;

  const eligibleByBandBot: Record<string, Record<string, { open: number; novel: number }>> = {};

  for (const row of flatRows) {
    if (row.alreadyOpen) alreadyOpenRows++;
    else novelRows++;

    if (row.eligible) {
      eligibleRows++;
      if (row.alreadyOpen) eligibleAlreadyOpen++;
      else eligibleNovel++;
      if (!eligibleByBandBot[row.band]) eligibleByBandBot[row.band] = {};
      if (!eligibleByBandBot[row.band]![row.botType])
        eligibleByBandBot[row.band]![row.botType] = { open: 0, novel: 0 };
      const c = eligibleByBandBot[row.band]![row.botType]!;
      if (row.alreadyOpen) c.open++;
      else c.novel++;
    }
  }

  const pairCounts = new Map<string, number>();
  const marketCounts = new Map<string, number>();
  for (const row of flatRows) {
    const pk = `${row.assetId}|${row.side}`;
    pairCounts.set(pk, (pairCounts.get(pk) ?? 0) + 1);
    marketCounts.set(row.marketId, (marketCounts.get(row.marketId) ?? 0) + 1);
  }

  const sortedPairs = [...pairCounts.entries()].sort((a, b) => b[1] - a[1]);
  const sortedMarkets = [...marketCounts.entries()].sort((a, b) => b[1] - a[1]);

  const topNShare = (entries: [string, number][], n: number, total: number): number => {
    if (total <= 0) return 0;
    return entries.slice(0, n).reduce((a, [, c]) => a + c, 0) / total;
  };

  const pairTop5Share = topNShare(sortedPairs, 5, totalTraceRows);
  const pairTop10Share = topNShare(sortedPairs, 10, totalTraceRows);
  const marketTop5Share = topNShare(sortedMarkets, 5, totalTraceRows);

  const meanLoadedPerTick = ticks > 0 ? totalRawCandidatesSum / ticks : 0;
  const meanUniqueRecPerTick = recommendationIdsPerTick.length ? avg(recommendationIdsPerTick)! : 0;
  const recTurnoverRatio = meanLoadedPerTick > 0 ? meanUniqueRecPerTick / meanLoadedPerTick : 0;
  /** Unique recommendationIds over the full window divided by cumulative raw loads — low values mean the same small set repeats every tick. */
  const crossTickRecDiversity = totalRawCandidatesSum > 0 ? uniqueRecs / totalRawCandidatesSum : 0;

  const share = (a: number, b: number) => (b > 0 ? a / b : 0);

  function goodBandSection(band: (typeof GOOD_BANDS)[number]): string[] {
    const sub = flatRows.filter((r) => r.band === band);
    const uniqM = new Set(sub.map((r) => r.marketId)).size;
    const openC = sub.filter((r) => r.alreadyOpen).length;
    const novC = sub.filter((r) => !r.alreadyOpen).length;
    const scores = sub.map((r) => r.scoreResolved).filter((x): x is number => x != null);
    const scoreStats = summarizeScores(scores);
    const proxy = bandProxyMarkout.get(band) ?? null;
    return [
      `### Band ${band}`,
      `- trace rows (evaluations): ${sub.length}`,
      `- unique markets: ${uniqM}`,
      `- already-open share: ${(share(openC, sub.length) * 100).toFixed(2)}%`,
      `- novel share: ${(share(novC, sub.length) * 100).toFixed(2)}%`,
      `- score distribution (resolved): n=${scoreStats.n}, min=${scoreStats.min.toFixed(4)}, p25=${scoreStats.p25?.toFixed(4) ?? "-"}, p50=${scoreStats.p50?.toFixed(4) ?? "-"}, p75=${scoreStats.p75?.toFixed(4) ?? "-"}, max=${scoreStats.max.toFixed(4)}, mean=${scoreStats.mean.toFixed(4)}, std=${scoreStats.std.toFixed(4)}`,
      `- proxy quality (band mean markout12h from recent closed V2 trades): ${proxy == null ? "n/a" : proxy.toFixed(6)}`,
    ];
  }

  let conclusion: string = "evidence insufficient";
  const rawNovelShare = share(novelRows, totalTraceRows);
  const eligNovelShare = share(eligibleNovel, eligibleRows);
  const eligOpenShare = share(eligibleAlreadyOpen, eligibleRows);

  if (totalTraceRows === 0 || ticks < 1) {
    conclusion = "evidence insufficient";
  } else if (
    ticks >= 5 &&
    uniqueRecs < 18 &&
    meanLoadedPerTick >= 8 &&
    meanLoadedPerTick <= 12 &&
    (pairTop5Share >= 0.35 || marketTop5Share >= 0.35)
  ) {
    conclusion = "engine lacks breadth and keeps recycling the same exposures";
  } else if (pairTop5Share >= 0.45 || marketTop5Share >= 0.45) {
    conclusion = "breadth is concentrated only in a few markets";
  } else if (openRows.length > 0 && eligNovelShare < 0.12 && eligOpenShare > 0.2 && eligibleRows >= 15) {
    conclusion = "engine lacks breadth and keeps recycling the same exposures";
  } else if (eligibleRows >= 25 && rawNovelShare > 0.32 && eligNovelShare + 0.12 < rawNovelShare && eligOpenShare > 0.18) {
    conclusion = "breadth is adequate but novelty is lost later";
  } else if (uniqueMarkets <= 8 && totalTraceRows >= 100 && pairTop10Share < 0.45) {
    conclusion = "breadth is concentrated only in a few markets";
  } else if (ticks >= 5 && uniqueRecs >= 24 && meanLoadedPerTick >= 24 && pairTop5Share < 0.35) {
    conclusion = "breadth is adequate but novelty is lost later";
  }

  const lines: string[] = [];
  lines.push("# V2 candidate breadth audit");
  lines.push("");
  lines.push(`- Generated: ${generatedAt}`);
  lines.push(`- Window: ${ticks} dry-run ticks, cadence ${cadenceMs}ms`);
  lines.push(`- Open V2 positions used for novelty: ${openRows.length}`);
  lines.push("");
  lines.push("## A. Breadth of candidate generation");
  lines.push(`- total raw candidates (sum of \`candidatesLoaded\` per tick): ${totalRawCandidatesSum}`);
  lines.push(`- mean raw candidates per tick: ${meanLoadedPerTick.toFixed(2)}`);
  lines.push(`- mean unique recommendationIds evaluated per tick (from trace): ${meanUniqueRecPerTick.toFixed(2)}`);
  lines.push(`- recommendation turnover ratio (mean unique recs / mean loaded): ${recTurnoverRatio.toFixed(4)}`);
  lines.push(
    `- cross-tick recommendation diversity (unique recs / sum of raw loads): ${crossTickRecDiversity.toFixed(4)} — if the same K recs appear every tick this ratio stays ≈ 1/ticks even when K is large; also compare uniqueRecs vs meanLoadedPerTick below`
  );
  lines.push(
    `- uniqueRecs / meanLoadedPerTick (window): ${meanLoadedPerTick > 0 ? (uniqueRecs / meanLoadedPerTick).toFixed(4) : "-"} — near 1.0 with low totalRecs implies a static per-tick pool, not tick-to-tick rotation`
  );
  lines.push(`- total trace rows (bot×candidate evaluations): ${totalTraceRows}`);
  lines.push(`- unique recommendationIds (across window): ${uniqueRecs}`);
  lines.push(`- unique assetIds: ${uniqueAssetIds}`);
  lines.push(`- unique markets: ${uniqueMarkets}`);
  lines.push(`- unique assetId|side pairs: ${uniqueAssetSide}`);
  lines.push(`- unique botType|assetId|side keys: ${uniqueBotAssetSide}`);
  lines.push("- rows by shadow price band (from score provenance):");
  lines.push(JSON.stringify(rowsByBand, null, 2));
  lines.push("- unique assetIds by band:");
  lines.push(JSON.stringify(Object.fromEntries(Object.entries(uniqAssetByBand).map(([k, s]) => [k, s.size])), null, 2));
  lines.push("- unique markets by band:");
  lines.push(JSON.stringify(Object.fromEntries(Object.entries(uniqMarketByBand).map(([k, s]) => [k, s.size])), null, 2));
  lines.push("- unique assetId|side pairs by band:");
  lines.push(JSON.stringify(Object.fromEntries(Object.entries(uniqAssetSideByBand).map(([k, s]) => [k, s.size])), null, 2));
  lines.push("");

  lines.push("## B. Novelty relative to open inventory");
  lines.push(
    `- all trace rows — already-open: ${alreadyOpenRows} (${(share(alreadyOpenRows, totalTraceRows) * 100).toFixed(2)}%), novel: ${novelRows} (${(share(novelRows, totalTraceRows) * 100).toFixed(2)}%)`
  );
  lines.push(
    `- eligible trace rows — already-open: ${eligibleAlreadyOpen} (${(share(eligibleAlreadyOpen, eligibleRows) * 100).toFixed(2)}%), novel: ${eligibleNovel} (${(share(eligibleNovel, eligibleRows) * 100).toFixed(2)}%)  [eligible if any bot row for that recommendation admits or fails after threshold/liquidity, same operational definition as open-exposure novelty audit]`
  );
  lines.push("- eligible rows by band × botType (alreadyOpen / novel):");
  for (const b of [...BANDS, "unknown"]) {
    const byBot = eligibleByBandBot[b];
    if (!byBot || !Object.keys(byBot).length) continue;
    lines.push(`  - **${b}**: ${JSON.stringify(byBot)}`);
  }
  lines.push("");

  lines.push("## C. Repetition concentration");
  lines.push(`- top-5 assetId|side pairs share of trace rows: ${(pairTop5Share * 100).toFixed(2)}%`);
  lines.push(`- top-10 assetId|side pairs share of trace rows: ${(pairTop10Share * 100).toFixed(2)}%`);
  lines.push(`- top-5 markets share of trace rows: ${(marketTop5Share * 100).toFixed(2)}%`);
  lines.push("");
  lines.push("### Top assetId|side pairs");
  lines.push("| assetId|side | rows |");
  lines.push("| --- | ---: |");
  for (const [k, c] of sortedPairs.slice(0, 15)) lines.push(`| ${k} | ${c} |`);
  lines.push("");
  lines.push("### Top markets (marketId)");
  lines.push("| marketId | rows |");
  lines.push("| --- | ---: |");
  for (const [k, c] of sortedMarkets.slice(0, 15)) lines.push(`| ${k} | ${c} |`);
  lines.push("");

  lines.push("## D. Good-band breadth (0.4–0.6 and 0.2–0.3)");
  lines.push(...goodBandSection("0.4-0.6"));
  lines.push("");
  lines.push(...goodBandSection("0.2-0.3"));
  lines.push("");
  lines.push("## E. Blunt conclusion");
  lines.push(`- **${conclusion}**`);
  lines.push("");
  lines.push("## JSON summary");
  lines.push("```json");
  lines.push(
    JSON.stringify(
      {
        generatedAt,
        window: { ticks, cadenceMs },
        openV2Positions: openRows.length,
        breadth: {
          totalRawCandidatesSum,
          meanLoadedPerTick,
          meanUniqueRecPerTick,
          recTurnoverRatio,
          crossTickRecDiversity,
          uniqueRecsOverMeanLoadedPerTick: meanLoadedPerTick > 0 ? uniqueRecs / meanLoadedPerTick : null,
          totalTraceRows,
          uniqueRecs,
          uniqueAssetIds,
          uniqueMarkets,
          uniqueAssetSidePairs: uniqueAssetSide,
          uniqueBotAssetSideKeys: uniqueBotAssetSide,
          rowsByBand,
          uniqueAssetsByBand: Object.fromEntries(Object.entries(uniqAssetByBand).map(([k, s]) => [k, s.size])),
          uniqueMarketsByBand: Object.fromEntries(Object.entries(uniqMarketByBand).map(([k, s]) => [k, s.size])),
          uniqueAssetSideByBand: Object.fromEntries(Object.entries(uniqAssetSideByBand).map(([k, s]) => [k, s.size])),
        },
        noveltyVsOpen: {
          allRows: { alreadyOpen: alreadyOpenRows, novel: novelRows, alreadyOpenShare: share(alreadyOpenRows, totalTraceRows), novelShare: share(novelRows, totalTraceRows) },
          eligibleRows: {
            total: eligibleRows,
            alreadyOpen: eligibleAlreadyOpen,
            novel: eligibleNovel,
            alreadyOpenShare: share(eligibleAlreadyOpen, eligibleRows),
            novelShare: share(eligibleNovel, eligibleRows),
          },
          eligibleByBandBot,
        },
        concentration: {
          pairTop5Share,
          pairTop10Share,
          marketTop5Share,
          topPairs: sortedPairs.slice(0, 15),
          topMarkets: sortedMarkets.slice(0, 15),
        },
        goodBands: Object.fromEntries(
          GOOD_BANDS.map((band) => {
            const sub = flatRows.filter((r) => r.band === band);
            const openC = sub.filter((r) => r.alreadyOpen).length;
            const scores = sub.map((r) => r.scoreResolved).filter((x): x is number => x != null);
            return [
              band,
              {
                traceRows: sub.length,
                uniqueMarkets: new Set(sub.map((r) => r.marketId)).size,
                alreadyOpenShare: share(openC, sub.length),
                novelShare: share(sub.length - openC, sub.length),
                scoreSummary: summarizeScores(scores),
                proxyBandMarkoutAvg: bandProxyMarkout.get(band) ?? null,
              },
            ];
          })
        ),
        conclusion,
      },
      null,
      2
    )
  );
  lines.push("```");

  const outPath = path.join(process.cwd(), "diagnostics", "v2-candidate-breadth-audit.md");
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, lines.join("\n"), "utf8");
  console.log(`Wrote ${outPath}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
