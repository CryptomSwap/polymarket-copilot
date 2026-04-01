import "dotenv/config";
import * as fs from "fs/promises";
import * as path from "path";
import { prisma } from "../lib/db";
import { getFunderForPaperTradingTick } from "../lib/decision/recompute";
import {
  loadShadowCandidatesForPaperTick,
  normalizePreferredFunderForShadowLoad,
  parseRecoThesisFromDecisionSnapshotJson,
  type PaperTradingCandidate,
} from "../lib/paper-trading/candidates";

type RawRow = {
  id: string;
  recommendationId: string | null;
  funderAddress: string;
  marketId: string | null;
  side: string;
  intendedPrice: string;
  decisionSnapshotJson: string | null;
  createdAt: Date;
};

type TickSnapshot = {
  tick: number;
  funderUsed: string;
  lookbackMinutes: number;
  rawRows: RawRow[];
  dedupWinners: RawRow[];
  finalCandidates: PaperTradingCandidate[];
};

function parseNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number.parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

function bandOfPrice(entryPrice: string | null | undefined): string {
  const p = parseNum(entryPrice);
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

function dedupeSide(side: string): "BUY" | "SELL" {
  return side.toUpperCase() === "SELL" ? "SELL" : "BUY";
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

function dedupeMarket(row: RawRow): string | null {
  const col = row.marketId?.trim();
  if (col) return col;
  return marketFromDecision(row.decisionSnapshotJson);
}

function dedupeKey(row: RawRow): string | null {
  const m = dedupeMarket(row);
  if (!m) return null;
  return `${m}\0${dedupeSide(row.side)}`;
}

function ageSummaryMins(rows: RawRow[]): { p50: number | null; p90: number | null; max: number | null } {
  if (rows.length === 0) return { p50: null, p90: null, max: null };
  const now = Date.now();
  const ages = rows
    .map((r) => (now - r.createdAt.getTime()) / 60000)
    .filter((x) => Number.isFinite(x))
    .sort((a, b) => a - b);
  const q = (p: number): number => {
    const idx = Math.min(ages.length - 1, Math.max(0, Math.floor((ages.length - 1) * p)));
    return ages[idx]!;
  };
  return { p50: q(0.5), p90: q(0.9), max: ages[ages.length - 1] ?? null };
}

function buildDedupWinners(rowsNewestFirst: RawRow[]): {
  winners: RawRow[];
  groups: Map<string, RawRow[]>;
  skippedNoMarket: number;
} {
  const seen = new Set<string>();
  const winners: RawRow[] = [];
  const groups = new Map<string, RawRow[]>();
  let skippedNoMarket = 0;
  for (const r of rowsNewestFirst) {
    const k = dedupeKey(r);
    if (!k) {
      skippedNoMarket++;
      continue;
    }
    const g = groups.get(k) ?? [];
    g.push(r);
    groups.set(k, g);
    if (seen.has(k)) continue;
    seen.add(k);
    winners.push(r);
  }
  return { winners, groups, skippedNoMarket };
}

function classifyCollapsedGroup(rows: RawRow[]): "near-duplicate/noise" | "same market but different recommendation instance" | "same market with materially different metadata" | "unable to tell" {
  if (rows.length < 2) return "unable to tell";
  const recs = new Set(rows.map((r) => r.recommendationId ?? ""));
  const prices = rows.map((r) => parseNum(r.intendedPrice)).filter((x): x is number => x != null);
  const pMin = prices.length ? Math.min(...prices) : null;
  const pMax = prices.length ? Math.max(...prices) : null;
  const pRange = pMin != null && pMax != null ? pMax - pMin : null;
  const minTs = Math.min(...rows.map((r) => r.createdAt.getTime()));
  const maxTs = Math.max(...rows.map((r) => r.createdAt.getTime()));
  const ageSpreadMin = (maxTs - minTs) / 60000;
  const metaSig = new Set(
    rows.map((r) => {
      const t = parseRecoThesisFromDecisionSnapshotJson(r.decisionSnapshotJson);
      return `${t.strategyFamily ?? ""}|${t.strategyVariant ?? ""}|${t.hypothesisType ?? ""}`;
    })
  );

  const hasDifferentReco = recs.size > 1;
  const hasMaterialMetadata = metaSig.size > 1 || (pRange != null && pRange > 0.02) || ageSpreadMin > 20;
  const nearDuplicate = recs.size <= 1 && (pRange == null || pRange <= 0.005) && ageSpreadMin <= 3 && metaSig.size <= 1;

  if (nearDuplicate) return "near-duplicate/noise";
  if (hasDifferentReco && !hasMaterialMetadata) return "same market but different recommendation instance";
  if (hasMaterialMetadata) return "same market with materially different metadata";
  return "unable to tell";
}

function pct(n: number, d: number): number {
  return d > 0 ? (n / d) * 100 : 0;
}

async function main(): Promise<void> {
  const generatedAt = new Date().toISOString();
  const ticks = Math.max(1, Number(process.env.DEDUPE_SELECTION_AUDIT_TICKS ?? "24") || 24);
  const cadenceMs = Math.max(0, Number(process.env.DEDUPE_SELECTION_AUDIT_CADENCE_MS ?? "500") || 500);

  const preferred = normalizePreferredFunderForShadowLoad(await getFunderForPaperTradingTick());
  const snapshots: TickSnapshot[] = [];

  for (let tick = 0; tick < ticks; tick++) {
    const loaded = await loadShadowCandidatesForPaperTick({ preferredFunder: preferred });
    const funderUsed = loaded.shadowDiagnostics.funderUsedForLoad?.trim().toLowerCase() ?? "";
    const lookbackMinutes = loaded.shadowDiagnostics.lookbackMinutes;
    const since = new Date(Date.now() - lookbackMinutes * 60 * 1000);
    const rawRows = funderUsed
      ? await prisma.shadowCandidate.findMany({
          where: {
            funderAddress: funderUsed,
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
            funderAddress: true,
            marketId: true,
            side: true,
            intendedPrice: true,
            decisionSnapshotJson: true,
            createdAt: true,
          },
        })
      : [];
    const dedup = buildDedupWinners(rawRows);
    snapshots.push({
      tick,
      funderUsed,
      lookbackMinutes,
      rawRows,
      dedupWinners: dedup.winners,
      finalCandidates: loaded.candidates,
    });
    if (tick < ticks - 1 && cadenceMs > 0) await sleep(cadenceMs);
  }

  const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const first = snapshots[0];
  const allRaw = snapshots.flatMap((s) => s.rawRows);
  const allDedup = snapshots.flatMap((s) => s.dedupWinners);
  const allFinal = snapshots.flatMap((s) => s.finalCandidates);

  const rawUniqueRec = new Set(allRaw.map((r) => r.recommendationId ?? `shadow:${r.id}`)).size;
  const dedupUniqueRec = new Set(allDedup.map((r) => r.recommendationId ?? `shadow:${r.id}`)).size;
  const finalUniqueRec = new Set(allFinal.map((c) => c.recommendationId)).size;

  const rawUniqueMkt = new Set(allRaw.map((r) => dedupeMarket(r)).filter(Boolean)).size;
  const dedupUniqueMkt = new Set(allDedup.map((r) => dedupeMarket(r)).filter(Boolean)).size;
  const finalUniqueMkt = new Set(allFinal.map((c) => c.marketId)).size;

  const rawUniqueKey = new Set(allRaw.map((r) => dedupeKey(r)).filter(Boolean)).size;
  const dedupUniqueKey = new Set(allDedup.map((r) => dedupeKey(r)).filter(Boolean)).size;
  const finalUniqueKey = new Set(allFinal.map((c) => `${c.marketId}\0${dedupeSide(c.side)}`)).size;

  const recLossRawToDedup = Math.max(0, rawUniqueRec - dedupUniqueRec);
  const recLossDedupToFinal = Math.max(0, dedupUniqueRec - finalUniqueRec);
  const recLossTotal = Math.max(1, rawUniqueRec - finalUniqueRec);
  const mktLossRawToDedup = Math.max(0, rawUniqueMkt - dedupUniqueMkt);
  const mktLossDedupToFinal = Math.max(0, dedupUniqueMkt - finalUniqueMkt);
  const mktLossTotal = Math.max(1, rawUniqueMkt - finalUniqueMkt);
  const keyLossRawToDedup = Math.max(0, rawUniqueKey - dedupUniqueKey);
  const keyLossDedupToFinal = Math.max(0, dedupUniqueKey - finalUniqueKey);
  const keyLossTotal = Math.max(1, rawUniqueKey - finalUniqueKey);

  const rawAvg = mean(snapshots.map((s) => s.rawRows.length));
  const dedupAvg = mean(snapshots.map((s) => s.dedupWinners.length));
  const finalAvg = mean(snapshots.map((s) => s.finalCandidates.length));
  const rawToDedupRatio = rawAvg > 0 ? dedupAvg / rawAvg : 0;
  const dedupToFinalRatio = dedupAvg > 0 ? finalAvg / dedupAvg : 0;

  const collapseByKey = new Map<string, { raw: number; ticks: number; recs: Set<string>; priceMin: number | null; priceMax: number | null }>();
  const collapseClass = new Map<string, number>();
  let groupsMultiReco = 0;
  let groupsMultiMeta = 0;
  let groupsTotalMulti = 0;

  for (const s of snapshots) {
    const { groups } = buildDedupWinners(s.rawRows);
    for (const [k, g] of groups.entries()) {
      if (g.length <= 1) continue;
      groupsTotalMulti++;
      const recSet = new Set(g.map((r) => r.recommendationId ?? `shadow:${r.id}`));
      if (recSet.size > 1) groupsMultiReco++;
      const prices = g.map((r) => parseNum(r.intendedPrice)).filter((x): x is number => x != null);
      const pMin = prices.length ? Math.min(...prices) : null;
      const pMax = prices.length ? Math.max(...prices) : null;
      const thesisSet = new Set(
        g.map((r) => {
          const t = parseRecoThesisFromDecisionSnapshotJson(r.decisionSnapshotJson);
          return `${t.strategyFamily ?? ""}|${t.strategyVariant ?? ""}|${t.hypothesisType ?? ""}`;
        })
      );
      if (thesisSet.size > 1 || (pMin != null && pMax != null && pMax - pMin > 0.02)) groupsMultiMeta++;

      const c = classifyCollapsedGroup(g);
      collapseClass.set(c, (collapseClass.get(c) ?? 0) + 1);

      const item = collapseByKey.get(k) ?? { raw: 0, ticks: 0, recs: new Set<string>(), priceMin: null, priceMax: null };
      item.raw += g.length;
      item.ticks += 1;
      for (const rec of recSet) item.recs.add(rec);
      if (pMin != null) item.priceMin = item.priceMin == null ? pMin : Math.min(item.priceMin, pMin);
      if (pMax != null) item.priceMax = item.priceMax == null ? pMax : Math.max(item.priceMax, pMax);
      collapseByKey.set(k, item);
    }
  }

  const heavyCollapsed = [...collapseByKey.entries()]
    .map(([k, v]) => ({
      key: k,
      totalRawRowsCollapsed: v.raw,
      ticksSeen: v.ticks,
      uniqueRecommendationIds: v.recs.size,
      priceRange: v.priceMin != null && v.priceMax != null ? v.priceMax - v.priceMin : null,
      avgCollapsedPerTickSeen: v.raw / Math.max(1, v.ticks),
    }))
    .sort((a, b) => b.totalRawRowsCollapsed - a.totalRawRowsCollapsed)
    .slice(0, 20);

  const selectedFreq = new Map<string, number>();
  const dedupFreq = new Map<string, number>();
  const finalSignatures = new Set<string>();
  for (const s of snapshots) {
    for (const r of s.dedupWinners) dedupFreq.set(r.id, (dedupFreq.get(r.id) ?? 0) + 1);
    const ids = s.finalCandidates.map((c) => c.shadowCandidateId ?? c.recommendationId);
    ids.sort();
    finalSignatures.add(ids.join(","));
    for (const id of ids) selectedFreq.set(id, (selectedFreq.get(id) ?? 0) + 1);
  }
  const selectedEveryTick = [...selectedFreq.entries()].filter(([, n]) => n === ticks).map(([id]) => id).slice(0, 40);
  const dedupNeverSelected = [...dedupFreq.keys()].filter((id) => !selectedFreq.has(id));
  const dedupAlwaysDropped = [...dedupFreq.entries()]
    .filter(([id, n]) => n === ticks && !selectedFreq.has(id))
    .map(([id]) => id)
    .slice(0, 40);
  const avgConsecutiveJaccard =
    snapshots.length <= 1
      ? 1
      : snapshots
          .slice(1)
          .map((s, i) => {
            const prev = new Set((snapshots[i]!.finalCandidates).map((c) => c.shadowCandidateId ?? c.recommendationId));
            const cur = new Set(s.finalCandidates.map((c) => c.shadowCandidateId ?? c.recommendationId));
            const inter = [...cur].filter((x) => prev.has(x)).length;
            const uni = new Set([...prev, ...cur]).size || 1;
            return inter / uni;
          })
          .reduce((a, b) => a + b, 0) /
          (snapshots.length - 1);

  function countBand(rows: { intendedPrice?: string; entryPrice?: string }[], band: string): number {
    return rows.filter((r) => bandOfPrice((r as { entryPrice?: string }).entryPrice ?? (r as { intendedPrice?: string }).intendedPrice ?? null) === band).length;
  }
  const goodBands = ["0.2-0.3", "0.4-0.6"] as const;
  const goodBandStats = goodBands.map((b) => {
    const rawC = countBand(allRaw as { intendedPrice?: string }[], b);
    const dedupC = countBand(allDedup as { intendedPrice?: string }[], b);
    const finalC = countBand(allFinal as { entryPrice?: string }[], b);
    return {
      band: b,
      raw: rawC,
      deduped: dedupC,
      final: finalC,
      lossRawToDedup: rawC - dedupC,
      lossDedupToFinal: dedupC - finalC,
    };
  });

  const recStageShareRawDedup = pct(recLossRawToDedup, recLossTotal);
  const recStageShareDedupFinal = pct(recLossDedupToFinal, recLossTotal);
  const keyStageShareRawDedup = pct(keyLossRawToDedup, keyLossTotal);
  const keyStageShareDedupFinal = pct(keyLossDedupToFinal, keyLossTotal);
  const mktStageShareRawDedup = pct(mktLossRawToDedup, mktLossTotal);
  const mktStageShareDedupFinal = pct(mktLossDedupToFinal, mktLossTotal);

  let blunt: "diversity is mostly lost in dedupe" | "diversity is mostly lost in final selection" | "both layers materially destroy diversity" | "evidence insufficient";
  const recGap = Math.abs(recStageShareRawDedup - recStageShareDedupFinal);
  if (rawUniqueRec < 20 || dedupUniqueRec < 10 || finalUniqueRec < 5) blunt = "evidence insufficient";
  else if (recGap <= 15 && keyStageShareRawDedup >= 35 && keyStageShareDedupFinal >= 35) blunt = "both layers materially destroy diversity";
  else if (recStageShareRawDedup > recStageShareDedupFinal + 15) blunt = "diversity is mostly lost in dedupe";
  else if (recStageShareDedupFinal > recStageShareRawDedup + 15) blunt = "diversity is mostly lost in final selection";
  else blunt = "both layers materially destroy diversity";

  const lines: string[] = [];
  lines.push("# V2 dedupe vs selection diversity audit");
  lines.push("");
  lines.push(`- Generated: ${generatedAt}`);
  lines.push(`- Window: ${ticks} dry-run ticks, cadence ${cadenceMs}ms`);
  lines.push(`- Preferred funder hint: ${preferred ?? "(auto)"}`);
  lines.push(`- First tick funder used: ${first?.funderUsed ?? "(none)"}; lookbackMinutes: ${first?.lookbackMinutes ?? 0}`);
  lines.push("");
  lines.push("## Layer 1 — raw candidate rows");
  lines.push(`- Mean raw rows per tick: **${rawAvg.toFixed(2)}**`);
  lines.push(`- Unique recommendationIds (window): **${rawUniqueRec}**`);
  lines.push(`- Unique marketId+side dedupe keys (window): **${rawUniqueKey}**`);
  lines.push(`- Unique markets (window): **${rawUniqueMkt}**`);
  const age = ageSummaryMins(allRaw);
  lines.push(`- Age distribution (minutes): p50 **${age.p50?.toFixed(2) ?? "-"}**, p90 **${age.p90?.toFixed(2) ?? "-"}**, max **${age.max?.toFixed(2) ?? "-"}**`);
  lines.push("");
  lines.push("## Layer 2 — deduped winners (same semantics as loader)");
  lines.push(`- Mean deduped winners per tick: **${dedupAvg.toFixed(2)}**`);
  lines.push(`- Raw -> deduped compression ratio (mean): **${rawToDedupRatio.toFixed(3)}**`);
  lines.push(`- Multi-row dedupe groups: **${groupsTotalMulti}**`);
  lines.push(`- Groups with >1 recommendationId collapsed: **${groupsMultiReco}** (${pct(groupsMultiReco, groupsTotalMulti).toFixed(1)}%)`);
  lines.push(`- Groups with materially different metadata collapsed: **${groupsMultiMeta}** (${pct(groupsMultiMeta, groupsTotalMulti).toFixed(1)}%)`);
  lines.push("");
  lines.push("### Collapse classification");
  lines.push("```json");
  lines.push(JSON.stringify(Object.fromEntries(collapseClass.entries()), null, 2));
  lines.push("```");
  lines.push("### Top 20 heaviest-collapsed dedupe keys");
  lines.push("```json");
  lines.push(JSON.stringify(heavyCollapsed, null, 2));
  lines.push("```");
  lines.push("");
  lines.push("## Layer 3 — final selected pool (post-dedupe loader selection)");
  lines.push(`- Mean final selected per tick: **${finalAvg.toFixed(2)}**`);
  lines.push(`- Deduped -> final compression ratio (mean): **${dedupToFinalRatio.toFixed(3)}**`);
  lines.push(`- Final-set signature count across ticks: **${finalSignatures.size}** (1 means static/deterministic set)`);
  lines.push(`- Mean consecutive-tick Jaccard (final winners): **${avgConsecutiveJaccard.toFixed(3)}**`);
  lines.push(`- Winners selected every tick: **${selectedEveryTick.length}**`);
  lines.push(`- Dedup winners never selected (window union): **${dedupNeverSelected.length}**`);
  lines.push(`- Dedup winners present every tick but never selected: **${dedupAlwaysDropped.length}**`);
  lines.push("");
  lines.push("### Always-selected winner ids (sample)");
  lines.push("```json");
  lines.push(JSON.stringify(selectedEveryTick.slice(0, 40), null, 2));
  lines.push("```");
  lines.push("### Always-dropped dedup winner ids (sample)");
  lines.push("```json");
  lines.push(JSON.stringify(dedupAlwaysDropped.slice(0, 40), null, 2));
  lines.push("```");
  lines.push("");
  lines.push("## A. Diversity loss attribution");
  lines.push("| metric | raw unique | dedup unique | final unique | loss raw->dedup | loss dedup->final | share of total loss at raw->dedup | share at dedup->final |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  lines.push(`| recommendationIds | ${rawUniqueRec} | ${dedupUniqueRec} | ${finalUniqueRec} | ${recLossRawToDedup} | ${recLossDedupToFinal} | ${recStageShareRawDedup.toFixed(1)}% | ${recStageShareDedupFinal.toFixed(1)}% |`);
  lines.push(`| markets | ${rawUniqueMkt} | ${dedupUniqueMkt} | ${finalUniqueMkt} | ${mktLossRawToDedup} | ${mktLossDedupToFinal} | ${mktStageShareRawDedup.toFixed(1)}% | ${mktStageShareDedupFinal.toFixed(1)}% |`);
  lines.push(`| marketId+side keys | ${rawUniqueKey} | ${dedupUniqueKey} | ${finalUniqueKey} | ${keyLossRawToDedup} | ${keyLossDedupToFinal} | ${keyStageShareRawDedup.toFixed(1)}% | ${keyStageShareDedupFinal.toFixed(1)}% |`);
  lines.push("");
  lines.push("## B. Are dropped rows meaningfully different?");
  lines.push("- Collapse classification uses recommendationId cardinality + price dispersion + snapshot thesis fields (strategyFamily/strategyVariant/hypothesisType) + timestamp spread.");
  lines.push("- See `Collapse classification` and `Top 20 heaviest-collapsed dedupe keys` sections.");
  lines.push("");
  lines.push("## C. Final-selection determinism");
  lines.push(`- Distinct final winner sets observed across ${ticks} ticks: **${finalSignatures.size}**`);
  lines.push(`- Mean consecutive set-overlap (Jaccard): **${avgConsecutiveJaccard.toFixed(3)}**`);
  lines.push(`- Always-selected winner ids: **${selectedEveryTick.length}**`);
  lines.push(`- Always-dropped dedup winners (present each tick but never selected): **${dedupAlwaysDropped.length}**`);
  lines.push("");
  lines.push("## D. Good-band loss (0.2–0.3 and 0.4–0.6)");
  lines.push("| band | raw count | deduped count | final selected count | loss raw->dedup | loss dedup->final | dominant loss stage |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | --- |");
  for (const g of goodBandStats) {
    const dom = g.lossRawToDedup > g.lossDedupToFinal ? "raw->dedup" : g.lossDedupToFinal > g.lossRawToDedup ? "dedup->final" : "tie";
    lines.push(`| ${g.band} | ${g.raw} | ${g.deduped} | ${g.final} | ${g.lossRawToDedup} | ${g.lossDedupToFinal} | ${dom} |`);
  }
  lines.push("");
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
        firstTick: first ? { funderUsed: first.funderUsed, lookbackMinutes: first.lookbackMinutes } : null,
        layerAverages: { rawAvg, dedupAvg, finalAvg, rawToDedupRatio, dedupToFinalRatio },
        diversityUnique: {
          recommendationIds: { raw: rawUniqueRec, dedup: dedupUniqueRec, final: finalUniqueRec },
          markets: { raw: rawUniqueMkt, dedup: dedupUniqueMkt, final: finalUniqueMkt },
          marketSideKeys: { raw: rawUniqueKey, dedup: dedupUniqueKey, final: finalUniqueKey },
        },
        attributionPct: {
          recommendationIds: { rawToDedup: recStageShareRawDedup, dedupToFinal: recStageShareDedupFinal },
          markets: { rawToDedup: mktStageShareRawDedup, dedupToFinal: mktStageShareDedupFinal },
          marketSideKeys: { rawToDedup: keyStageShareRawDedup, dedupToFinal: keyStageShareDedupFinal },
        },
        collapse: {
          groupsTotalMulti,
          groupsMultiReco,
          groupsMultiMeta,
          classification: Object.fromEntries(collapseClass.entries()),
          top20HeaviestKeys: heavyCollapsed,
        },
        determinism: {
          finalSignatureCount: finalSignatures.size,
          avgConsecutiveJaccard,
          selectedEveryTickCount: selectedEveryTick.length,
          dedupNeverSelectedCount: dedupNeverSelected.length,
          dedupAlwaysDroppedCount: dedupAlwaysDropped.length,
          selectedEveryTickSample: selectedEveryTick.slice(0, 20),
          dedupAlwaysDroppedSample: dedupAlwaysDropped.slice(0, 20),
        },
        goodBands: goodBandStats,
        bluntConclusion: blunt,
      },
      null,
      2
    )
  );
  lines.push("```");

  const outPath = path.join(process.cwd(), "diagnostics", "v2-dedupe-vs-selection-diversity-audit.md");
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
