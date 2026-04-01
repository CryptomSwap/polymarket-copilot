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

type RawRow = {
  id: string;
  recommendationId: string | null;
  marketId: string | null;
  side: string;
  intendedPrice: string;
  decisionSnapshotJson: string | null;
  createdAt: Date;
};

type Layer = "raw" | "deduped" | "final";
type Bucket = "low_extreme" | "mid" | "other";

function parseNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number.parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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

function rawMarket(row: RawRow): string | null {
  return row.marketId?.trim() || marketFromDecision(row.decisionSnapshotJson);
}

function normalizeSide(side: string): "BUY" | "SELL" {
  return side.toUpperCase() === "SELL" ? "SELL" : "BUY";
}

function dedupeKey(row: RawRow): string | null {
  const market = rawMarket(row);
  if (!market) return null;
  return `${market}\0${normalizeSide(row.side)}`;
}

function bucketFromPrice(p: string | null | undefined): Bucket {
  const x = parseNum(p);
  if (x == null) return "other";
  if (x < 0.1) return "low_extreme";
  if ((x >= 0.2 && x < 0.3) || (x >= 0.4 && x < 0.6) || (x >= 0.6 && x < 0.8)) return "mid";
  return "other";
}

function ageBucket(minutes: number): string {
  if (minutes < 5) return "<5m";
  if (minutes < 10) return "5-10m";
  if (minutes < 20) return "10-20m";
  if (minutes < 30) return "20-30m";
  return ">=30m";
}

function pushCount<K extends string>(m: Map<K, number>, k: K): void {
  m.set(k, (m.get(k) ?? 0) + 1);
}

async function main(): Promise<void> {
  const generatedAt = new Date().toISOString();
  const ticks = Math.max(1, Number(process.env.LOW_EXTREME_SURVIVOR_AUDIT_TICKS ?? "24") || 24);
  const cadenceMs = Math.max(0, Number(process.env.LOW_EXTREME_SURVIVOR_AUDIT_CADENCE_MS ?? "500") || 500);
  const preferred = normalizePreferredFunderForShadowLoad(await getFunderForPaperTradingTick());

  const byLayerBucket: Record<Layer, Record<Bucket, number>> = {
    raw: { low_extreme: 0, mid: 0, other: 0 },
    deduped: { low_extreme: 0, mid: 0, other: 0 },
    final: { low_extreme: 0, mid: 0, other: 0 },
  };
  const byLayerAge: Record<Layer, Map<string, number>> = {
    raw: new Map(),
    deduped: new Map(),
    final: new Map(),
  };
  const byLayerRecFreq: Record<Layer, Map<string, number>> = {
    raw: new Map(),
    deduped: new Map(),
    final: new Map(),
  };
  const byLayerMarketFreq: Record<Layer, Map<string, number>> = {
    raw: new Map(),
    deduped: new Map(),
    final: new Map(),
  };

  let rawCount = 0;
  let dedupCount = 0;
  let finalCount = 0;
  let midLostRawToDedup = 0;
  let midLostDedupToFinal = 0;

  for (let tick = 0; tick < ticks; tick++) {
    const loaded = await loadShadowCandidatesForPaperTick({ preferredFunder: preferred });
    const funder = loaded.shadowDiagnostics.funderUsedForLoad?.trim().toLowerCase() ?? "";
    const lookbackMinutes = loaded.shadowDiagnostics.lookbackMinutes;
    const since = new Date(Date.now() - lookbackMinutes * 60 * 1000);
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

    rawCount += rawRows.length;
    const nowMs = Date.now();
    for (const r of rawRows) {
      const b = bucketFromPrice(r.intendedPrice);
      byLayerBucket.raw[b]++;
      pushCount(byLayerAge.raw, ageBucket((nowMs - r.createdAt.getTime()) / 60000));
      pushCount(byLayerRecFreq.raw, r.recommendationId ?? `shadow:${r.id}`);
      const mk = rawMarket(r) ?? "unknown_market";
      pushCount(byLayerMarketFreq.raw, mk);
    }

    const seen = new Set<string>();
    const deduped: RawRow[] = [];
    for (const r of rawRows) {
      const k = dedupeKey(r);
      if (!k) continue;
      if (seen.has(k)) continue;
      seen.add(k);
      deduped.push(r);
    }
    dedupCount += deduped.length;
    for (const r of deduped) {
      const b = bucketFromPrice(r.intendedPrice);
      byLayerBucket.deduped[b]++;
      pushCount(byLayerAge.deduped, ageBucket((nowMs - r.createdAt.getTime()) / 60000));
      pushCount(byLayerRecFreq.deduped, r.recommendationId ?? `shadow:${r.id}`);
      const mk = rawMarket(r) ?? "unknown_market";
      pushCount(byLayerMarketFreq.deduped, mk);
    }

    finalCount += loaded.candidates.length;
    for (const c of loaded.candidates) {
      const b = bucketFromPrice(c.entryPrice);
      byLayerBucket.final[b]++;
      // final rows inherit freshness from selected raw snapshots only indirectly; use "in lookback" age proxy
      pushCount(byLayerAge.final, "<=lookback");
      pushCount(byLayerRecFreq.final, c.recommendationId);
      pushCount(byLayerMarketFreq.final, c.marketId);
    }

    const rawMid = rawRows.filter((r) => bucketFromPrice(r.intendedPrice) === "mid").length;
    const dedupMid = deduped.filter((r) => bucketFromPrice(r.intendedPrice) === "mid").length;
    const finalMid = loaded.candidates.filter((c) => bucketFromPrice(c.entryPrice) === "mid").length;
    midLostRawToDedup += Math.max(0, rawMid - dedupMid);
    midLostDedupToFinal += Math.max(0, dedupMid - finalMid);

    if (tick < ticks - 1 && cadenceMs > 0) await sleep(cadenceMs);
  }

  const totals: Record<Layer, number> = {
    raw: rawCount,
    deduped: dedupCount,
    final: finalCount,
  };
  const share = (layer: Layer, bucket: Bucket): number => (totals[layer] > 0 ? byLayerBucket[layer][bucket] / totals[layer] : 0);

  const topN = (m: Map<string, number>, n: number): [string, number][] =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
  const duplicationRate = (m: Map<string, number>): number => {
    const vals = [...m.values()];
    if (vals.length === 0) return 0;
    return vals.filter((v) => v > 1).length / vals.length;
  };
  const hhi = (m: Map<string, number>): number => {
    const vals = [...m.values()];
    const total = vals.reduce((a, b) => a + b, 0);
    if (total <= 0) return 0;
    return vals.reduce((acc, c) => acc + (c / total) * (c / total), 0);
  };

  const lowShareLiftRawToDedup = share("deduped", "low_extreme") - share("raw", "low_extreme");
  const lowShareLiftDedupToFinal = share("final", "low_extreme") - share("deduped", "low_extreme");
  const overrepLayer =
    lowShareLiftDedupToFinal > lowShareLiftRawToDedup
      ? "deduped->final"
      : lowShareLiftRawToDedup > lowShareLiftDedupToFinal
      ? "raw->deduped"
      : "tie";

  const midLossStage =
    midLostRawToDedup > midLostDedupToFinal
      ? "raw->deduped"
      : midLostDedupToFinal > midLostRawToDedup
      ? "deduped->final"
      : "tie";

  let blunt: "low extreme dominates after dedupe" | "low extreme dominates in final selection" | "mid bands are too sparse upstream" | "evidence insufficient";
  if (totals.raw < 100 || totals.deduped < 50 || totals.final < 20) blunt = "evidence insufficient";
  else if (share("raw", "mid") < 0.08) blunt = "mid bands are too sparse upstream";
  else if (share("deduped", "low_extreme") >= 0.55 && lowShareLiftRawToDedup > lowShareLiftDedupToFinal) blunt = "low extreme dominates after dedupe";
  else if (share("final", "low_extreme") >= 0.55 && lowShareLiftDedupToFinal >= lowShareLiftRawToDedup) blunt = "low extreme dominates in final selection";
  else blunt = "evidence insufficient";

  const lines: string[] = [];
  lines.push("# V2 low-extreme vs mid survivor audit");
  lines.push("");
  lines.push(`- Generated: ${generatedAt}`);
  lines.push(`- Window: ${ticks} dry-run ticks, cadence ${cadenceMs}ms`);
  lines.push(`- Preferred funder hint: ${preferred ?? "(auto)"}`);
  lines.push("");
  lines.push("## Layer counts");
  lines.push(`- Raw rows total: **${rawCount}**`);
  lines.push(`- Deduped winners total: **${dedupCount}**`);
  lines.push(`- Final selected total: **${finalCount}**`);
  lines.push("");
  lines.push("## Share by bucket at each layer");
  lines.push("| layer | low extreme (<0.1) | mid (0.2-0.3, 0.4-0.6, 0.6-0.8) | other |");
  lines.push("| --- | ---: | ---: | ---: |");
  for (const layer of ["raw", "deduped", "final"] as const) {
    lines.push(
      `| ${layer} | ${(share(layer, "low_extreme") * 100).toFixed(2)}% (${byLayerBucket[layer].low_extreme}/${totals[layer]}) | ${(share(layer, "mid") * 100).toFixed(2)}% (${byLayerBucket[layer].mid}/${totals[layer]}) | ${(share(layer, "other") * 100).toFixed(2)}% (${byLayerBucket[layer].other}/${totals[layer]}) |`
    );
  }
  lines.push("");
  lines.push("## Per-market concentration (HHI; higher = more concentrated)");
  lines.push(`- Raw HHI: **${hhi(byLayerMarketFreq.raw).toFixed(4)}**`);
  lines.push(`- Deduped HHI: **${hhi(byLayerMarketFreq.deduped).toFixed(4)}**`);
  lines.push(`- Final HHI: **${hhi(byLayerMarketFreq.final).toFixed(4)}**`);
  lines.push("");
  lines.push("## Freshness (age buckets)");
  lines.push("```json");
  lines.push(
    JSON.stringify(
      {
        raw: Object.fromEntries(byLayerAge.raw.entries()),
        deduped: Object.fromEntries(byLayerAge.deduped.entries()),
        final: Object.fromEntries(byLayerAge.final.entries()),
      },
      null,
      2
    )
  );
  lines.push("```");
  lines.push("");
  lines.push("## recommendationId duplication rate (fraction of ids seen >1)");
  lines.push(`- Raw: **${(duplicationRate(byLayerRecFreq.raw) * 100).toFixed(2)}%**`);
  lines.push(`- Deduped: **${(duplicationRate(byLayerRecFreq.deduped) * 100).toFixed(2)}%**`);
  lines.push(`- Final: **${(duplicationRate(byLayerRecFreq.final) * 100).toFixed(2)}%**`);
  lines.push("");
  lines.push("## Where low-extreme overrepresentation grows most");
  lines.push(`- Low-extreme share lift raw->deduped: **${(lowShareLiftRawToDedup * 100).toFixed(2)} pp**`);
  lines.push(`- Low-extreme share lift deduped->final: **${(lowShareLiftDedupToFinal * 100).toFixed(2)} pp**`);
  lines.push(`- Dominant overrepresentation layer: **${overrepLayer}**`);
  lines.push("");
  lines.push("## Mid-band loss stage");
  lines.push(`- Mid lost raw->deduped: **${midLostRawToDedup}**`);
  lines.push(`- Mid lost deduped->final: **${midLostDedupToFinal}**`);
  lines.push(`- Dominant mid loss layer: **${midLossStage}**`);
  lines.push("");
  lines.push("## Top markets by layer");
  lines.push("```json");
  lines.push(
    JSON.stringify(
      {
        raw: topN(byLayerMarketFreq.raw, 12),
        deduped: topN(byLayerMarketFreq.deduped, 12),
        final: topN(byLayerMarketFreq.final, 12),
      },
      null,
      2
    )
  );
  lines.push("```");
  lines.push("");
  lines.push("## Blunt conclusion");
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
        bucketCounts: byLayerBucket,
        bucketShares: {
          raw: {
            low_extreme: share("raw", "low_extreme"),
            mid: share("raw", "mid"),
            other: share("raw", "other"),
          },
          deduped: {
            low_extreme: share("deduped", "low_extreme"),
            mid: share("deduped", "mid"),
            other: share("deduped", "other"),
          },
          final: {
            low_extreme: share("final", "low_extreme"),
            mid: share("final", "mid"),
            other: share("final", "other"),
          },
        },
        marketHHI: {
          raw: hhi(byLayerMarketFreq.raw),
          deduped: hhi(byLayerMarketFreq.deduped),
          final: hhi(byLayerMarketFreq.final),
        },
        recDuplicationRate: {
          raw: duplicationRate(byLayerRecFreq.raw),
          deduped: duplicationRate(byLayerRecFreq.deduped),
          final: duplicationRate(byLayerRecFreq.final),
        },
        lowExtremeShareLift: {
          rawToDeduped: lowShareLiftRawToDedup,
          dedupedToFinal: lowShareLiftDedupToFinal,
          dominantLayer: overrepLayer,
        },
        midLoss: {
          rawToDeduped: midLostRawToDedup,
          dedupedToFinal: midLostDedupToFinal,
          dominantLayer: midLossStage,
        },
        bluntConclusion: blunt,
      },
      null,
      2
    )
  );
  lines.push("```");

  const outPath = path.join(process.cwd(), "diagnostics", "v2-low-extreme-vs-mid-survivor-audit.md");
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

