import "dotenv/config";
import * as fs from "fs/promises";
import * as path from "path";
import { prisma } from "../lib/db";
import { getFunderForPaperTradingTick } from "../lib/decision/recompute";
import {
  loadShadowCandidatesForPaperTick,
  normalizePreferredFunderForShadowLoad,
  type PaperTradingCandidate,
} from "../lib/paper-trading/candidates";

type Band = "<0.1" | "0.1-0.2" | "0.2-0.3" | "0.3-0.4" | "0.4-0.6" | "0.6-0.8" | "0.8-0.9" | ">=0.9" | "unknown";
type Layer = "raw" | "deduped" | "final";

type RawRow = {
  id: string;
  recommendationId: string | null;
  marketId: string | null;
  side: string;
  intendedPrice: string;
  decisionSnapshotJson: string | null;
  createdAt: Date;
};

function parseNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number.parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function classifyBand(price: string | null | undefined): Band {
  const p = parseNum(price);
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

function marketFromDecision(decisionSnapshotJson: string | null): string | null {
  if (!decisionSnapshotJson?.trim()) return null;
  try {
    const o = JSON.parse(decisionSnapshotJson) as Record<string, unknown>;
    return typeof o.marketId === "string" && o.marketId.trim() ? o.marketId.trim() : null;
  } catch {
    return null;
  }
}

function rawMarket(row: RawRow): string {
  return row.marketId?.trim() || marketFromDecision(row.decisionSnapshotJson) || "unknown_market";
}

function dedupeKey(row: RawRow): string | null {
  const m = row.marketId?.trim() || marketFromDecision(row.decisionSnapshotJson);
  if (!m) return null;
  const side = row.side.toUpperCase() === "SELL" ? "SELL" : "BUY";
  return `${m}\0${side}`;
}

function ageBucket(minutes: number): string {
  if (minutes < 5) return "<5m";
  if (minutes < 10) return "5-10m";
  if (minutes < 20) return "10-20m";
  if (minutes < 30) return "20-30m";
  return ">=30m";
}

const ALL_BANDS: Band[] = ["<0.1", "0.1-0.2", "0.2-0.3", "0.3-0.4", "0.4-0.6", "0.6-0.8", "0.8-0.9", ">=0.9", "unknown"];

function emptyBandCounts(): Record<Band, number> {
  return {
    "<0.1": 0,
    "0.1-0.2": 0,
    "0.2-0.3": 0,
    "0.3-0.4": 0,
    "0.4-0.6": 0,
    "0.6-0.8": 0,
    "0.8-0.9": 0,
    ">=0.9": 0,
    unknown: 0,
  };
}

async function main(): Promise<void> {
  const generatedAt = new Date().toISOString();
  const ticks = Math.max(1, Number(process.env.GOOD_BAND_SUPPLY_AUDIT_TICKS ?? "24") || 24);
  const cadenceMs = Math.max(0, Number(process.env.GOOD_BAND_SUPPLY_AUDIT_CADENCE_MS ?? "500") || 500);
  const preferred = normalizePreferredFunderForShadowLoad(await getFunderForPaperTradingTick());

  const counts: Record<Layer, Record<Band, number>> = {
    raw: emptyBandCounts(),
    deduped: emptyBandCounts(),
    final: emptyBandCounts(),
  };
  const uniqueMarkets: Record<Layer, Record<Band, Set<string>>> = {
    raw: Object.fromEntries(ALL_BANDS.map((b) => [b, new Set<string>()])) as Record<Band, Set<string>>,
    deduped: Object.fromEntries(ALL_BANDS.map((b) => [b, new Set<string>()])) as Record<Band, Set<string>>,
    final: Object.fromEntries(ALL_BANDS.map((b) => [b, new Set<string>()])) as Record<Band, Set<string>>,
  };
  const uniqueRecsRaw: Record<Band, Set<string>> = Object.fromEntries(
    ALL_BANDS.map((b) => [b, new Set<string>()])
  ) as Record<Band, Set<string>>;
  const ageByBandRaw: Record<Band, Map<string, number>> = Object.fromEntries(
    ALL_BANDS.map((b) => [b, new Map<string, number>()])
  ) as Record<Band, Map<string, number>>;
  const ageByBandDeduped: Record<Band, Map<string, number>> = Object.fromEntries(
    ALL_BANDS.map((b) => [b, new Map<string, number>()])
  ) as Record<Band, Map<string, number>>;

  const topMarketsForBand: Record<Layer, Record<Band, Map<string, number>>> = {
    raw: Object.fromEntries(ALL_BANDS.map((b) => [b, new Map<string, number>()])) as Record<Band, Map<string, number>>,
    deduped: Object.fromEntries(ALL_BANDS.map((b) => [b, new Map<string, number>()])) as Record<Band, Map<string, number>>,
    final: Object.fromEntries(ALL_BANDS.map((b) => [b, new Map<string, number>()])) as Record<Band, Map<string, number>>,
  };

  for (let tick = 0; tick < ticks; tick++) {
    const loaded = await loadShadowCandidatesForPaperTick({ preferredFunder: preferred });
    const funder = loaded.shadowDiagnostics.funderUsedForLoad?.trim().toLowerCase() ?? "";
    const lookbackMinutes = loaded.shadowDiagnostics.lookbackMinutes;
    const since = new Date(Date.now() - lookbackMinutes * 60 * 1000);
    const nowMs = Date.now();

    const rawRows: RawRow[] = funder
      ? await prisma.shadowCandidate.findMany({
          where: {
            funderAddress: funder,
            wasSubmitted: true,
            wasBlocked: false,
            candidateSource: "runtime_automated",
            createdAt: { gte: since },
          },
          orderBy: { createdAt: "desc" },
          take: 500,
          select: {
            id: true,
            recommendationId: true,
            marketId: true,
            side: true,
            intendedPrice: true,
            decisionSnapshotJson: true,
            createdAt: true,
          },
        })
      : [];

    const seen = new Set<string>();
    const deduped: RawRow[] = [];
    for (const r of rawRows) {
      const k = dedupeKey(r);
      if (!k) continue;
      if (seen.has(k)) continue;
      seen.add(k);
      deduped.push(r);
    }

    for (const r of rawRows) {
      const b = classifyBand(r.intendedPrice);
      counts.raw[b]++;
      const mk = rawMarket(r);
      uniqueMarkets.raw[b].add(mk);
      uniqueRecsRaw[b].add(r.recommendationId ?? `shadow:${r.id}`);
      const age = ageBucket((nowMs - r.createdAt.getTime()) / 60000);
      ageByBandRaw[b].set(age, (ageByBandRaw[b].get(age) ?? 0) + 1);
      topMarketsForBand.raw[b].set(mk, (topMarketsForBand.raw[b].get(mk) ?? 0) + 1);
    }
    for (const r of deduped) {
      const b = classifyBand(r.intendedPrice);
      counts.deduped[b]++;
      const mk = rawMarket(r);
      uniqueMarkets.deduped[b].add(mk);
      const age = ageBucket((nowMs - r.createdAt.getTime()) / 60000);
      ageByBandDeduped[b].set(age, (ageByBandDeduped[b].get(age) ?? 0) + 1);
      topMarketsForBand.deduped[b].set(mk, (topMarketsForBand.deduped[b].get(mk) ?? 0) + 1);
    }
    for (const c of loaded.candidates) {
      const b = classifyBand(c.entryPrice);
      counts.final[b]++;
      uniqueMarkets.final[b].add(c.marketId);
      topMarketsForBand.final[b].set(c.marketId, (topMarketsForBand.final[b].get(c.marketId) ?? 0) + 1);
    }

    if (tick < ticks - 1 && cadenceMs > 0) await sleep(cadenceMs);
  }

  const total = (layer: Layer): number => ALL_BANDS.reduce((acc, b) => acc + counts[layer][b], 0);
  const totals = { raw: total("raw"), deduped: total("deduped"), final: total("final") };
  const dropRawToDedupByBand: Record<Band, number> = Object.fromEntries(
    ALL_BANDS.map((b) => [b, Math.max(0, counts.raw[b] - counts.deduped[b])])
  ) as Record<Band, number>;
  const dropDedupToFinalByBand: Record<Band, number> = Object.fromEntries(
    ALL_BANDS.map((b) => [b, Math.max(0, counts.deduped[b] - counts.final[b])])
  ) as Record<Band, number>;

  const goodBands: Band[] = ["0.2-0.3", "0.4-0.6"];
  const topN = (m: Map<string, number>, n: number): [string, number][] =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
  const dominantStage = (b: Band): "raw->deduped" | "deduped->final" | "tie" => {
    const a = dropRawToDedupByBand[b];
    const c = dropDedupToFinalByBand[b];
    if (a > c) return "raw->deduped";
    if (c > a) return "deduped->final";
    return "tie";
  };

  let blunt: "good bands are sparse at raw generation" | "good bands are lost mostly in dedupe" | "good bands are lost mostly in final selection" | "evidence insufficient";
  const rawGood = goodBands.reduce((acc, b) => acc + counts.raw[b], 0);
  const dedupGood = goodBands.reduce((acc, b) => acc + counts.deduped[b], 0);
  const finalGood = goodBands.reduce((acc, b) => acc + counts.final[b], 0);
  const lossA = rawGood - dedupGood;
  const lossB = dedupGood - finalGood;
  if (totals.raw < 200 || rawGood < 20) blunt = "good bands are sparse at raw generation";
  else if (lossA > lossB) blunt = "good bands are lost mostly in dedupe";
  else if (lossB > lossA) blunt = "good bands are lost mostly in final selection";
  else blunt = "evidence insufficient";

  const lines: string[] = [];
  lines.push("# V2 good-band supply audit");
  lines.push("");
  lines.push(`- Generated: ${generatedAt}`);
  lines.push(`- Window: ${ticks} dry-run ticks, cadence ${cadenceMs}ms`);
  lines.push(`- Preferred funder hint: ${preferred ?? "(auto)"}`);
  lines.push("");
  lines.push("## A. Raw live ShadowCandidate supply");
  lines.push("| band | raw count | raw share | unique markets | unique recommendationIds |");
  lines.push("| --- | ---: | ---: | ---: | ---: |");
  for (const b of ALL_BANDS) {
    const share = totals.raw > 0 ? (counts.raw[b] / totals.raw) * 100 : 0;
    lines.push(`| ${b} | ${counts.raw[b]} | ${share.toFixed(2)}% | ${uniqueMarkets.raw[b].size} | ${uniqueRecsRaw[b].size} |`);
  }
  lines.push("");
  lines.push("### Raw age distribution by band");
  lines.push("```json");
  lines.push(
    JSON.stringify(
      Object.fromEntries(
        ALL_BANDS.map((b) => [b, Object.fromEntries([...ageByBandRaw[b].entries()].sort((a, c) => a[0].localeCompare(c[0])))])
      ),
      null,
      2
    )
  );
  lines.push("```");
  lines.push("");
  lines.push("## B. Deduped winners by band");
  lines.push("| band | deduped count | deduped share | unique markets | raw->dedup drop |");
  lines.push("| --- | ---: | ---: | ---: | ---: |");
  for (const b of ALL_BANDS) {
    const share = totals.deduped > 0 ? (counts.deduped[b] / totals.deduped) * 100 : 0;
    lines.push(`| ${b} | ${counts.deduped[b]} | ${share.toFixed(2)}% | ${uniqueMarkets.deduped[b].size} | ${dropRawToDedupByBand[b]} |`);
  }
  lines.push("");
  lines.push("### Deduped age distribution by band");
  lines.push("```json");
  lines.push(
    JSON.stringify(
      Object.fromEntries(
        ALL_BANDS.map((b) => [b, Object.fromEntries([...ageByBandDeduped[b].entries()].sort((a, c) => a[0].localeCompare(c[0])))])
      ),
      null,
      2
    )
  );
  lines.push("```");
  lines.push("");
  lines.push("## C. Final selected by band");
  lines.push("| band | final count | final share | unique markets | deduped->final drop |");
  lines.push("| --- | ---: | ---: | ---: | ---: |");
  for (const b of ALL_BANDS) {
    const share = totals.final > 0 ? (counts.final[b] / totals.final) * 100 : 0;
    lines.push(`| ${b} | ${counts.final[b]} | ${share.toFixed(2)}% | ${uniqueMarkets.final[b].size} | ${dropDedupToFinalByBand[b]} |`);
  }
  lines.push("");
  lines.push("## D. Good-band attribution");
  for (const b of goodBands) {
    lines.push(`### Band ${b}`);
    lines.push(`- raw count: **${counts.raw[b]}**`);
    lines.push(`- deduped count: **${counts.deduped[b]}**`);
    lines.push(`- final count: **${counts.final[b]}**`);
    lines.push(`- dominant loss stage: **${dominantStage(b)}**`);
    lines.push(`- top raw markets: \`${JSON.stringify(topN(topMarketsForBand.raw[b], 6))}\``);
    lines.push(`- top deduped markets: \`${JSON.stringify(topN(topMarketsForBand.deduped[b], 6))}\``);
    lines.push(`- top final markets: \`${JSON.stringify(topN(topMarketsForBand.final[b], 6))}\``);
    lines.push(`- freshness raw: \`${JSON.stringify(Object.fromEntries(ageByBandRaw[b].entries()))}\``);
    lines.push(`- freshness deduped: \`${JSON.stringify(Object.fromEntries(ageByBandDeduped[b].entries()))}\``);
    lines.push("");
  }
  lines.push("## E. Blunt conclusion");
  lines.push(`**${blunt}**`);
  lines.push("");
  lines.push("## JSON summary");
  lines.push("```json");
  lines.push(
    JSON.stringify(
      {
        generatedAt,
        ticks,
        cadenceMs,
        preferredFunder: preferred,
        totals,
        counts,
        uniqueMarkets: {
          raw: Object.fromEntries(ALL_BANDS.map((b) => [b, uniqueMarkets.raw[b].size])),
          deduped: Object.fromEntries(ALL_BANDS.map((b) => [b, uniqueMarkets.deduped[b].size])),
          final: Object.fromEntries(ALL_BANDS.map((b) => [b, uniqueMarkets.final[b].size])),
        },
        uniqueRecommendationIdsRaw: Object.fromEntries(ALL_BANDS.map((b) => [b, uniqueRecsRaw[b].size])),
        ageByBandRaw: Object.fromEntries(ALL_BANDS.map((b) => [b, Object.fromEntries(ageByBandRaw[b].entries())])),
        ageByBandDeduped: Object.fromEntries(ALL_BANDS.map((b) => [b, Object.fromEntries(ageByBandDeduped[b].entries())])),
        dropRawToDedupByBand,
        dropDedupToFinalByBand,
        goodBands: Object.fromEntries(
          goodBands.map((b) => [
            b,
            {
              raw: counts.raw[b],
              deduped: counts.deduped[b],
              final: counts.final[b],
              dominantLossStage: dominantStage(b),
              topRawMarkets: topN(topMarketsForBand.raw[b], 8),
              topDedupedMarkets: topN(topMarketsForBand.deduped[b], 8),
              topFinalMarkets: topN(topMarketsForBand.final[b], 8),
            },
          ])
        ),
        bluntConclusion: blunt,
      },
      null,
      2
    )
  );
  lines.push("```");

  const outPath = path.join(process.cwd(), "diagnostics", "v2-good-band-supply-audit.md");
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, lines.join("\n"), "utf8");
  console.log(`Wrote ${outPath}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

