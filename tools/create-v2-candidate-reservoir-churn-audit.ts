import "dotenv/config";
import * as fs from "fs/promises";
import * as path from "path";
import { prisma } from "../lib/db";
import { getSubmittedShadowCandidatesForTickWithDiagnostics } from "../lib/paper-trading/candidates";
import { runPaperTradingTickV2 } from "../lib/paper-trading/engine_v2_minimal";

const GOOD_BANDS = ["0.4-0.6", "0.2-0.3"] as const;

function parseNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number.parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

function median(nums: number[]): number | null {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function avg(nums: number[]): number | null {
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

/** Aligns with engine V2 shadow band from entry price. */
function shadowBandFromEntryPrice(entryPrice: string | null | undefined): string {
  const p = parseNum(entryPrice);
  if (p == null) return "0.4-0.6";
  if (p < 0.1) return "<0.1";
  if (p < 0.2) return "0.1-0.2";
  if (p < 0.3) return "0.2-0.3";
  if (p < 0.4) return "0.3-0.4";
  if (p < 0.6) return "0.4-0.6";
  if (p < 0.8) return "0.6-0.8";
  if (p < 0.9) return "0.8-0.9";
  return ">=0.9";
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const u = a.size + b.size - inter;
  return u > 0 ? inter / u : 0;
}

type TickSlice = {
  tick: number;
  finalRecIds: Set<string>;
  upstreamRecIds: Set<string>;
  upstreamMarkets: Set<string>;
  finalMarkets: Set<string>;
  beforeExpansionCount: number | null;
  afterExpansionCount: number | null;
  droppedByExpansionCount: number;
  goodUpstreamMarkets046: Set<string>;
  goodUpstreamMarkets023: Set<string>;
  goodFinalMarkets046: Set<string>;
  goodFinalMarkets023: Set<string>;
};

async function main(): Promise<void> {
  const generatedAt = new Date().toISOString();
  const ticks = Math.max(1, parseInt(process.env.PAPER_RESERVOIR_CHURN_TICKS ?? "24", 10));
  const cadenceMs = Math.max(0, parseInt(process.env.PAPER_RESERVOIR_CHURN_CADENCE_MS ?? "500", 10));

  const slices: TickSlice[] = [];
  const warnings: string[] = [];

  for (let tick = 0; tick < ticks; tick++) {
    const r = await runPaperTradingTickV2({ dryRun: true });
    const funder = r.funderUsedForCandidateLoad?.trim();
    const lookback = r.shadowDiagnostics?.lookbackMinutes ?? 30;

    const finalRecIds = new Set<string>();
    const finalMarkets = new Set<string>();
    const bandByRec = new Map((r.scoreProvenanceSample ?? []).map((p) => [p.recommendationId, p.shadowBand ?? "unknown"]));
    const goodFinalMarkets046 = new Set<string>();
    const goodFinalMarkets023 = new Set<string>();

    for (const row of r.trace ?? []) {
      finalRecIds.add(row.recommendationId);
      finalMarkets.add(row.marketId);
      const b = bandByRec.get(row.recommendationId);
      if (b === "0.4-0.6") goodFinalMarkets046.add(row.marketId);
      if (b === "0.2-0.3") goodFinalMarkets023.add(row.marketId);
    }

    let upstreamRecIds = new Set<string>();
    let upstreamMarkets = new Set<string>();
    let goodUpstreamMarkets046 = new Set<string>();
    let goodUpstreamMarkets023 = new Set<string>();
    let beforeExpansionCount: number | null = r.shadowDiagnostics?.expansionBreadth?.beforePriceBiasCount ?? null;
    let afterExpansionCount: number | null = r.shadowDiagnostics?.expansionBreadth?.afterPriceBiasCount ?? null;

    if (funder) {
      try {
        const up = await getSubmittedShadowCandidatesForTickWithDiagnostics({
          funderAddress: funder,
          lookbackMinutes: lookback,
        });
        for (const c of up.candidates) {
          upstreamRecIds.add(c.recommendationId);
          upstreamMarkets.add(c.marketId);
          const sb = shadowBandFromEntryPrice(c.entryPrice);
          if (sb === "0.4-0.6") goodUpstreamMarkets046.add(c.marketId);
          if (sb === "0.2-0.3") goodUpstreamMarkets023.add(c.marketId);
        }
        if (beforeExpansionCount == null) beforeExpansionCount = up.candidates.length;
      } catch (e) {
        warnings.push(`tick ${tick}: upstream refetch failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else {
      warnings.push(`tick ${tick}: no funder for upstream refetch`);
    }

    let droppedByExpansionCount = 0;
    for (const id of upstreamRecIds) if (!finalRecIds.has(id)) droppedByExpansionCount++;

    slices.push({
      tick,
      finalRecIds,
      upstreamRecIds,
      upstreamMarkets,
      finalMarkets,
      beforeExpansionCount,
      afterExpansionCount,
      droppedByExpansionCount,
      goodUpstreamMarkets046,
      goodUpstreamMarkets023,
      goodFinalMarkets046,
      goodFinalMarkets023,
    });

    if (tick < ticks - 1 && cadenceMs > 0) await new Promise((res) => setTimeout(res, cadenceMs));
  }

  const universeFinal = new Set<string>();
  const universeUpstream = new Set<string>();
  const firstSeenFinal = new Map<string, number>();
  const lastSeenFinal = new Map<string, number>();
  const appearanceCountFinal = new Map<string, number>();

  for (const s of slices) {
    for (const id of s.finalRecIds) {
      universeFinal.add(id);
      if (!firstSeenFinal.has(id)) firstSeenFinal.set(id, s.tick);
      lastSeenFinal.set(id, s.tick);
      appearanceCountFinal.set(id, (appearanceCountFinal.get(id) ?? 0) + 1);
    }
    for (const id of s.upstreamRecIds) universeUpstream.add(id);
  }

  const totalRecIdsWindow = universeFinal.size;
  const persistBuckets = { exactly1: 0, ticks2to5: 0, ticks6to12: 0, ticksGt12: 0 };
  const persistValues: number[] = [];
  for (const id of universeFinal) {
    const c = appearanceCountFinal.get(id) ?? 0;
    persistValues.push(c);
    if (c === 1) persistBuckets.exactly1++;
    else if (c >= 2 && c <= 5) persistBuckets.ticks2to5++;
    else if (c >= 6 && c <= 12) persistBuckets.ticks6to12++;
    else if (c > 12) persistBuckets.ticksGt12++;
  }

  const firstSeenHist: Record<string, number> = {};
  const lastSeenHist: Record<string, number> = {};
  for (const id of universeFinal) {
    const fs = String(firstSeenFinal.get(id) ?? 0);
    const ls = String(lastSeenFinal.get(id) ?? 0);
    firstSeenHist[fs] = (firstSeenHist[fs] ?? 0) + 1;
    lastSeenHist[ls] = (lastSeenHist[ls] ?? 0) + 1;
  }

  const jaccardPairs: number[] = [];
  const overlaps: number[] = [];
  const newPerTick: number[] = [];
  for (let i = 0; i < slices.length; i++) {
    if (i === 0) {
      newPerTick.push(slices[i]!.finalRecIds.size);
      continue;
    }
    const prev = slices[i - 1]!.finalRecIds;
    const curr = slices[i]!.finalRecIds;
    let inter = 0;
    for (const x of curr) if (prev.has(x)) inter++;
    overlaps.push(inter);
    jaccardPairs.push(jaccard(prev, curr));
    const nu = [...curr].filter((x) => !prev.has(x)).length;
    newPerTick.push(nu);
  }

  const droppedRates: number[] = [];
  const upstreamSizes: number[] = [];
  const finalSizes: number[] = [];
  for (const s of slices) {
    upstreamSizes.push(s.upstreamRecIds.size);
    finalSizes.push(s.finalRecIds.size);
    if (s.upstreamRecIds.size > 0) droppedRates.push(s.droppedByExpansionCount / s.upstreamRecIds.size);
  }

  const good046MarketsWindow = new Set<string>();
  const good023MarketsWindow = new Set<string>();
  const good046FirstTick = new Map<string, number>();
  const good023FirstTick = new Map<string, number>();
  const good046AppearTickSet = new Map<string, Set<number>>();
  const good023AppearTickSet = new Map<string, Set<number>>();

  for (const s of slices) {
    for (const m of s.goodFinalMarkets046) {
      good046MarketsWindow.add(m);
      if (!good046FirstTick.has(m)) good046FirstTick.set(m, s.tick);
      let st = good046AppearTickSet.get(m);
      if (!st) {
        st = new Set();
        good046AppearTickSet.set(m, st);
      }
      st.add(s.tick);
    }
    for (const m of s.goodFinalMarkets023) {
      good023MarketsWindow.add(m);
      if (!good023FirstTick.has(m)) good023FirstTick.set(m, s.tick);
      let st = good023AppearTickSet.get(m);
      if (!st) {
        st = new Set();
        good023AppearTickSet.set(m, st);
      }
      st.add(s.tick);
    }
  }

  const upstreamGood046Window = new Set<string>();
  const upstreamGood023Window = new Set<string>();
  for (const s of slices) {
    s.goodUpstreamMarkets046.forEach((m) => upstreamGood046Window.add(m));
    s.goodUpstreamMarkets023.forEach((m) => upstreamGood023Window.add(m));
  }

  const good046OverlapPairs: number[] = [];
  const good023OverlapPairs: number[] = [];
  for (let i = 1; i < slices.length; i++) {
    const a = slices[i - 1]!.goodFinalMarkets046;
    const b = slices[i]!.goodFinalMarkets046;
    let inter = 0;
    for (const x of b) if (a.has(x)) inter++;
    good046OverlapPairs.push(inter);
    const a2 = slices[i - 1]!.goodFinalMarkets023;
    const b2 = slices[i]!.goodFinalMarkets023;
    let inter2 = 0;
    for (const x of b2) if (a2.has(x)) inter2++;
    good023OverlapPairs.push(inter2);
  }

  let conclusion =
    "evidence insufficient" as
      | "upstream recommendation pool is static"
      | "loader selection is still reusing too much of the pool"
      | "good-band opportunities are genuinely sparse"
      | "evidence insufficient";

  const medPersist = median(persistValues);
  const meanJ = avg(jaccardPairs);
  const meanNew = avg(newPerTick.slice(1));
  const meanDrop = avg(droppedRates);
  const meanUpstream = avg(upstreamSizes);
  const meanFinal = avg(finalSizes);

  if (ticks >= 3 && universeFinal.size > 0) {
    if (
      (medPersist != null && medPersist >= ticks - 1) &&
      (meanJ != null && meanJ >= 0.85) &&
      (meanNew != null && meanNew <= Math.max(1, meanFinal! * 0.08))
    ) {
      conclusion = "upstream recommendation pool is static";
    } else if (meanDrop != null && meanDrop >= 0.35 && meanUpstream != null && meanUpstream > meanFinal! + 5) {
      conclusion = "loader selection is still reusing too much of the pool";
    } else if (good046MarketsWindow.size + good023MarketsWindow.size <= 4 && ticks >= 8) {
      conclusion = "good-band opportunities are genuinely sparse";
    }
  }

  const lines: string[] = [];
  lines.push("# V2 candidate reservoir churn audit");
  lines.push("");
  lines.push(`- Generated: ${generatedAt}`);
  lines.push(`- Window: ${ticks} dry-run ticks, cadence ${cadenceMs}ms`);
  lines.push(
    "- Note: upstream “before expansion” set is re-fetched after each tick via `getSubmittedShadowCandidatesForTickWithDiagnostics` with the same funder/lookback the tick used; tiny drift possible if new ShadowCandidate rows land between calls."
  );
  if (warnings.length) {
    lines.push("- Warnings:");
    for (const w of warnings) lines.push(`  - ${w}`);
  }
  lines.push("");

  lines.push("## A. Reservoir freshness (final selected pool per tick — unique `recommendationId` in trace)");
  lines.push(`- total unique recommendationIds across window: ${totalRecIdsWindow}`);
  lines.push(`- union of upstream (deduped) recommendationIds across refetches: ${universeUpstream.size}`);
  lines.push("- appearance count buckets (how many ticks each id is present in final pool):");
  lines.push(
    `  - exactly 1 tick: ${persistBuckets.exactly1} (${totalRecIdsWindow ? ((persistBuckets.exactly1 / totalRecIdsWindow) * 100).toFixed(1) : "0"}%)`
  );
  lines.push(
    `  - 2–5 ticks: ${persistBuckets.ticks2to5} (${totalRecIdsWindow ? ((persistBuckets.ticks2to5 / totalRecIdsWindow) * 100).toFixed(1) : "0"}%)`
  );
  lines.push(
    `  - 6–12 ticks: ${persistBuckets.ticks6to12} (${totalRecIdsWindow ? ((persistBuckets.ticks6to12 / totalRecIdsWindow) * 100).toFixed(1) : "0"}%)`
  );
  lines.push(
    `  - >12 ticks: ${persistBuckets.ticksGt12} (${totalRecIdsWindow ? ((persistBuckets.ticksGt12 / totalRecIdsWindow) * 100).toFixed(1) : "0"}%)`
  );
  lines.push(`- median tick appearances per id: ${medPersist?.toFixed(1) ?? "n/a"}`);
  lines.push("");
  lines.push("### First-seen tick index (count of ids whose first final appearance is that tick)");
  lines.push("```json");
  lines.push(JSON.stringify(firstSeenHist, null, 2));
  lines.push("```");
  lines.push("");
  lines.push("### Last-seen tick index");
  lines.push("```json");
  lines.push(JSON.stringify(lastSeenHist, null, 2));
  lines.push("```");
  lines.push("");

  lines.push("## B. Loader churn (final pool, consecutive ticks)");
  lines.push(`- mean Jaccard similarity (t-1 vs t): ${meanJ?.toFixed(4) ?? "n/a"}`);
  lines.push(`- mean |intersection| prev∩curr: ${avg(overlaps)?.toFixed(2) ?? "n/a"}`);
  lines.push(`- mean new recommendationIds vs previous tick: ${meanNew?.toFixed(2) ?? "n/a"}`);
  lines.push(`- per-tick new ids (tick 0 = full set size): ${JSON.stringify(newPerTick)}`);
  lines.push(`- per-tick Jaccard (from tick 1): ${JSON.stringify(jaccardPairs.map((x) => Number(x.toFixed(4))))}`);
  lines.push("");

  lines.push("## C. Upstream source churn (before vs after mid-range expansion)");
  lines.push(
    `- mean upstream deduped pool size (refetch): ${meanUpstream?.toFixed(2) ?? "n/a"}; mean final selected size (trace unique): ${meanFinal?.toFixed(2) ?? "n/a"}`
  );
  lines.push(
    `- mean fraction of upstream recommendationIds **not** in final pool (expansion/filter drop): ${meanDrop != null ? (meanDrop * 100).toFixed(2) + "%" : "n/a"}`
  );
  lines.push("- per-tick: upstream unique | final unique | dropped count | expansionBreadth.before→after when present");
  lines.push("| tick | upstream | final | dropped | before|after exp |");
  lines.push("| --- | ---: | ---: | ---: | --- |");
  for (const s of slices) {
    const exp =
      s.beforeExpansionCount != null && s.afterExpansionCount != null
        ? `${s.beforeExpansionCount}→${s.afterExpansionCount}`
        : "n/a";
    lines.push(`| ${s.tick} | ${s.upstreamRecIds.size} | ${s.finalRecIds.size} | ${s.droppedByExpansionCount} | ${exp} |`);
  }
  lines.push("");

  lines.push("## D. Good-band churn (0.4–0.6 and 0.2–0.3)");
  lines.push(
    "- **Final-pool good bands** use `recommendationId` → `shadowBand` only when present on `scoreProvenanceSample` (same partial coverage as breadth audit when the provenance sample is smaller than the full scored set). Upstream good bands use intended entry price on every deduped row."
  );
  for (const label of GOOD_BANDS) {
    const wm = label === "0.4-0.6" ? good046MarketsWindow : good023MarketsWindow;
    const ap = label === "0.4-0.6" ? good046AppearTickSet : good023AppearTickSet;
    const ov = label === "0.4-0.6" ? good046OverlapPairs : good023OverlapPairs;
    const repeatCounts = [...wm].map((m) => ap.get(m)?.size ?? 0);
    lines.push(`### ${label}`);
    lines.push(`- unique markets in final trace across window: ${wm.size}`);
    lines.push(`- mean markets per tick (final): ${label === "0.4-0.6" ? avg(slices.map((s) => s.goodFinalMarkets046.size)) : avg(slices.map((s) => s.goodFinalMarkets023.size))}`);
    lines.push(
      `- mean tick-to-tick overlap (count of markets in both t-1 and t): ${avg(ov)?.toFixed(2) ?? "n/a"}`
    );
    lines.push(
      `- upstream (refetch) unique markets across window: ${label === "0.4-0.6" ? upstreamGood046Window.size : upstreamGood023Window.size}`
    );
    const hist: Record<string, number> = {};
    for (const x of repeatCounts) {
      const k = String(x);
      hist[k] = (hist[k] ?? 0) + 1;
    }
    lines.push(
      `- per-market appearance ticks (median): ${median(repeatCounts)?.toFixed(1) ?? "n/a"}; counts by appearances: ${JSON.stringify(hist)}`
    );
    const ftMap = label === "0.4-0.6" ? good046FirstTick : good023FirstTick;
    const topFirst = [...ftMap.entries()].sort((a, b) => a[1] - b[1]).slice(0, 5);
    lines.push(`- sample (marketId → firstSeenTick): ${JSON.stringify(Object.fromEntries(topFirst))}`);
    lines.push("");
  }

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
        reservoirFreshness: {
          uniqueFinalRecIdsWindow: totalRecIdsWindow,
          unionUpstreamRecIds: universeUpstream.size,
          persistBuckets,
          medianAppearances: medPersist,
          firstSeenHist,
          lastSeenHist,
        },
        loaderChurn: {
          meanJaccardConsecutive: meanJ,
          meanIntersection: avg(overlaps),
          meanNewVsPrev: meanNew,
          newPerTick,
          jaccardPerStep: jaccardPairs,
        },
        upstreamVsFinal: {
          meanUpstreamSize: meanUpstream,
          meanFinalSize: meanFinal,
          meanFractionUpstreamDropped: meanDrop,
          perTick: slices.map((s) => ({
            tick: s.tick,
            upstream: s.upstreamRecIds.size,
            final: s.finalRecIds.size,
            dropped: s.droppedByExpansionCount,
            beforeExpansion: s.beforeExpansionCount,
            afterExpansion: s.afterExpansionCount,
          })),
        },
        goodBands: {
          "0.4-0.6": {
            uniqueMarketsWindow: good046MarketsWindow.size,
            meanOverlapTickToTick: avg(good046OverlapPairs),
          },
          "0.2-0.3": {
            uniqueMarketsWindow: good023MarketsWindow.size,
            meanOverlapTickToTick: avg(good023OverlapPairs),
          },
        },
        conclusion,
        warnings,
      },
      null,
      2
    )
  );
  lines.push("```");

  const outPath = path.join(process.cwd(), "diagnostics", "v2-candidate-reservoir-churn-audit.md");
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
