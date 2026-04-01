import "dotenv/config";
import * as fs from "fs/promises";
import * as path from "path";
import { runPaperTradingTickV2 } from "../lib/paper-trading/engine_v2_minimal";
import { getActiveBotProfiles } from "../lib/paper-trading/bot-profiles";
import { getPaperTradingConfig } from "../lib/paper-trading/config";
import { prisma } from "../lib/db";

const BANDS = ["<0.1", "0.1-0.2", "0.2-0.3", "0.3-0.4", "0.4-0.6", "0.6-0.8", "0.8-0.9", ">=0.9"] as const;

type Obs = { score: number; band: string };

function pct(n: number | null): string {
  return n == null ? "-" : `${(n * 100).toFixed(2)}%`;
}
function fmt(n: number | null, d = 4): string {
  return n == null ? "-" : n.toFixed(d);
}
function q(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[idx] ?? null;
}
function avg(nums: number[]): number | null {
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}
function parseNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number.parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

async function main(): Promise<void> {
  const generatedAt = new Date().toISOString();
  const ticks = Math.max(1, parseInt(process.env.PAPER_THRESHOLD_POST_ALLOC_TICKS ?? "24", 10));
  const cadenceMs = Math.max(0, parseInt(process.env.PAPER_THRESHOLD_POST_ALLOC_CADENCE_MS ?? "500", 10));

  const cfg = getPaperTradingConfig();
  const profiles = await getActiveBotProfiles();
  const effProfiles =
    profiles.length > 0
      ? profiles
      : [{ botType: "default", threshold: cfg.threshold, minScoreBuffer: cfg.minScoreBuffer }];
  const thresholdByBot = new Map(effProfiles.map((p) => [p.botType, p.threshold + p.minScoreBuffer] as const));
  const currentThreshold = [...thresholdByBot.values()].sort((a, b) => a - b)[0] ?? (cfg.threshold + cfg.minScoreBuffer);

  const levels = [currentThreshold - 0.1, currentThreshold - 0.05, currentThreshold, currentThreshold + 0.05]
    .map((x) => Math.max(0, Math.min(1, Number(x.toFixed(4)))));

  const allObs: Obs[] = [];
  const rejectTotals: Record<string, number> = {};
  let rawCandidates = 0;
  let scoredUnique = 0;
  let passThreshold = 0;
  let surviveFilters = 0;
  let admitted = 0;

  for (let i = 0; i < ticks; i++) {
    const r = await runPaperTradingTickV2({ dryRun: true });
    rawCandidates += r.candidatesLoaded;

    const byRec = new Map<string, typeof r.trace>();
    for (const t of r.trace ?? []) {
      const arr = byRec.get(t.recommendationId) ?? [];
      arr.push(t);
      byRec.set(t.recommendationId, arr);
    }
    const unique = byRec.size || r.candidatesLoaded;
    scoredUnique += unique;
    const failThr = [...byRec.values()].filter((arr) =>
      arr.every((x) => x.rejectReason === "below_threshold" || x.rejectReason === "score_failed")
    ).length;
    const passThr = Math.max(0, unique - failThr);
    passThreshold += passThr;
    const survive = [...byRec.values()].filter((arr) =>
      arr.some(
        (x) =>
          x.admitted ||
          (x.rejectReason !== "below_threshold" &&
            x.rejectReason !== "score_failed" &&
            x.rejectReason !== "liquidity_spread" &&
            x.rejectReason !== "liquidity_slippage")
      )
    ).length;
    surviveFilters += survive;
    admitted += [...byRec.values()].filter((arr) => arr.some((x) => x.admitted)).length;

    for (const [k, v] of Object.entries(r.rejectReasonDistribution ?? {})) {
      rejectTotals[k] = (rejectTotals[k] ?? 0) + v;
    }
    for (const p of r.scoreProvenanceSample ?? []) {
      if (p.finalBandAwareScore == null) continue;
      allObs.push({ score: p.finalBandAwareScore, band: p.shadowBand ?? "unknown" });
    }
    if (i < ticks - 1 && cadenceMs > 0) await new Promise((res) => setTimeout(res, cadenceMs));
  }

  const scores = allObs.map((o) => o.score).sort((a, b) => a - b);
  const bins = [
    { label: "[0.0,0.2)", lo: 0, hi: 0.2 },
    { label: "[0.2,0.4)", lo: 0.2, hi: 0.4 },
    { label: "[0.4,0.6)", lo: 0.4, hi: 0.6 },
    { label: "[0.6,0.8)", lo: 0.6, hi: 0.8 },
    { label: "[0.8,1.0]", lo: 0.8, hi: 1.000001 },
  ].map((b) => ({ ...b, count: allObs.filter((o) => o.score >= b.lo && o.score < b.hi).length }));

  const sensitivity = levels.map((thr) => {
    const pass = allObs.filter((o) => o.score >= thr).length;
    return { threshold: thr, passCount: pass, passRate: allObs.length ? pass / allObs.length : null };
  });

  const byBand = BANDS.map((band) => {
    const rows = allObs.filter((o) => o.band === band);
    return {
      band,
      count: rows.length,
      avgScore: avg(rows.map((r) => r.score)),
      passCurrent: rows.length ? rows.filter((r) => r.score >= currentThreshold).length / rows.length : null,
      passLowered: rows.length ? rows.filter((r) => r.score >= Math.max(0, currentThreshold - 0.05)).length / rows.length : null,
    };
  });

  // Near-threshold proxy quality via band average closed markout.
  const closedTrades = await prisma.paperTrade.findMany({
    where: { status: "closed", dedupeKey: { contains: "|v2|" }, markout12h: { not: null } },
    select: { entryPriceBand: true, markout12h: true },
    take: 5000,
    orderBy: { createdAt: "desc" },
  });
  const bandProxy = new Map<string, number>();
  for (const band of BANDS) {
    const vals = closedTrades
      .filter((t) => t.entryPriceBand === band)
      .map((t) => parseNum(t.markout12h))
      .filter((x): x is number => x != null);
    if (vals.length) bandProxy.set(band, avg(vals)!);
  }
  const near = allObs.filter((o) => o.score < currentThreshold && o.score >= Math.max(0, currentThreshold - 0.05));
  const nearBands: Record<string, number> = {};
  for (const n of near) nearBands[n.band] = (nearBands[n.band] ?? 0) + 1;
  const nearProxyVals = near
    .map((n) => bandProxy.get(n.band))
    .filter((x): x is number => x != null);

  const conclusion = (() => {
    if (allObs.length < 40) return "evidence insufficient";
    const passRate = allObs.filter((o) => o.score >= currentThreshold).length / allObs.length;
    if (passRate < 0.3) return "threshold too strict";
    if (passRate > 0.8) return "threshold too loose";
    return "threshold appropriate";
  })();

  const lines: string[] = [];
  lines.push("# V2 Threshold Post-Allocation Sensitivity");
  lines.push("");
  lines.push(`- Generated: ${generatedAt}`);
  lines.push(`- Window: ${ticks} dry-run ticks, cadence ${cadenceMs}ms`);
  lines.push("");
  lines.push("## A. Current threshold context");
  lines.push(`- score field used: finalBandAwareScore (actualScoreUsedForThreshold)`);
  lines.push(`- active thresholds by bot: ${JSON.stringify(Object.fromEntries(thresholdByBot.entries()))}`);
  lines.push(`- baseline current threshold (lowest active): ${currentThreshold.toFixed(4)}`);
  lines.push("");
  lines.push("## B. Candidate score distribution (current regime)");
  lines.push(`- min/p25/median/p75/max: ${fmt(scores[0] ?? null)} / ${fmt(q(scores, 0.25))} / ${fmt(q(scores, 0.5))} / ${fmt(q(scores, 0.75))} / ${fmt(scores[scores.length - 1] ?? null)}`);
  lines.push("| bin | count |");
  lines.push("| --- | ---: |");
  for (const b of bins) lines.push(`| ${b.label} | ${b.count} |`);
  lines.push("");
  lines.push("## C. Sensitivity table");
  lines.push("| threshold | pass count | pass rate |");
  lines.push("| ---: | ---: | ---: |");
  for (const s of sensitivity) lines.push(`| ${s.threshold.toFixed(4)} | ${s.passCount} | ${pct(s.passRate)} |`);
  lines.push("");
  lines.push("## D. By-band sensitivity");
  lines.push("| band | avg score | pass@current | pass@(current-0.05) |");
  lines.push("| --- | ---: | ---: | ---: |");
  for (const b of byBand) lines.push(`| ${b.band} | ${fmt(b.avgScore)} | ${pct(b.passCurrent)} | ${pct(b.passLowered)} |`);
  lines.push("");
  lines.push("## E. Near-threshold candidates");
  lines.push(`- candidates just below threshold (within 0.05): ${near.length}`);
  lines.push(`- by band: ${JSON.stringify(nearBands)}`);
  lines.push(`- proxy quality (band-based avg markout) for near-threshold set: ${fmt(avg(nearProxyVals))}`);
  lines.push("");
  lines.push("## F. Blunt conclusion");
  lines.push(`- ${conclusion}`);
  lines.push("");
  lines.push("## Appendix: Aggregated flow context");
  lines.push(`- candidates: ${rawCandidates}`);
  lines.push(`- scored unique: ${scoredUnique}`);
  lines.push(`- pass threshold unique: ${passThreshold}`);
  lines.push(`- survive filters unique: ${surviveFilters}`);
  lines.push(`- admitted unique: ${admitted}`);
  lines.push(`- reject totals: ${JSON.stringify(rejectTotals)}`);

  const outDir = path.join(process.cwd(), "diagnostics");
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, "v2-threshold-post-allocation-sensitivity.md");
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

