import "dotenv/config";
import * as fs from "fs/promises";
import * as path from "path";
import { runPaperTradingTickV2 } from "../lib/paper-trading/engine_v2_minimal";
import { getActiveBotProfiles } from "../lib/paper-trading/bot-profiles";
import { getPaperTradingConfig } from "../lib/paper-trading/config";

type Obs = { score: number; band: string };

const BANDS = ["<0.1", "0.1-0.2", "0.2-0.3", "0.3-0.4", "0.4-0.6", "0.6-0.8", "0.8-0.9", ">=0.9"] as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function pct(n: number | null): string {
  return n == null ? "-" : `${(n * 100).toFixed(2)}%`;
}
function fmt(n: number | null, d = 4): string {
  return n == null ? "-" : n.toFixed(d);
}
function median(nums: number[]): number | null {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

async function main(): Promise<void> {
  const generatedAt = new Date().toISOString();
  const ticks = Math.max(1, parseInt(process.env.PAPER_OVERLAY_STUDY_TICKS ?? "12", 10));
  const cadenceMs = Math.max(0, parseInt(process.env.PAPER_OVERLAY_STUDY_CADENCE_MS ?? "500", 10));

  const cfg = getPaperTradingConfig();
  const profiles = await getActiveBotProfiles();
  const thresholdByBot = new Map(
    (profiles.length > 0 ? profiles : [{ botType: "default", threshold: cfg.threshold, minScoreBuffer: cfg.minScoreBuffer }]).map(
      (p) => [p.botType, p.threshold + p.minScoreBuffer] as const
    )
  );
  const baselineThreshold = [...thresholdByBot.values()].sort((a, b) => a - b)[0] ?? (cfg.threshold + cfg.minScoreBuffer);
  const levels = [baselineThreshold - 0.1, baselineThreshold - 0.05, baselineThreshold, baselineThreshold + 0.05, baselineThreshold + 0.1]
    .map((x) => Math.max(0, Math.min(1, Number(x.toFixed(4)))));

  let rawCandidates = 0;
  let scoredUnique = 0;
  let passThreshold = 0;
  let surviveFilters = 0;
  let admitted = 0;
  let thresholdRemoved = 0;
  const rejectTotals: Record<string, number> = {};
  const allObs: Obs[] = [];

  const tickTimestamps: string[] = [];

  for (let i = 0; i < ticks; i++) {
    const r = await runPaperTradingTickV2({ dryRun: true });
    tickTimestamps.push(r.tickTime);
    rawCandidates += r.candidatesLoaded;

    const trace = r.trace ?? [];
    const byRec = new Map<string, typeof trace>();
    for (const t of trace) {
      const arr = byRec.get(t.recommendationId) ?? [];
      arr.push(t);
      byRec.set(t.recommendationId, arr);
    }
    const unique = byRec.size || r.candidatesLoaded;
    scoredUnique += unique;

    const failThr = [...byRec.values()].filter((arr) =>
      arr.every((x) => x.rejectReason === "below_threshold" || x.rejectReason === "score_failed")
    ).length;
    thresholdRemoved += failThr;
    const passThr = Math.max(0, unique - failThr);
    passThreshold += passThr;

    const survive = [...byRec.values()].filter((arr) =>
      arr.some((x) => x.admitted || (x.rejectReason !== "below_threshold" && x.rejectReason !== "score_failed" && x.rejectReason !== "liquidity_spread" && x.rejectReason !== "liquidity_slippage"))
    ).length;
    surviveFilters += survive;
    const adm = [...byRec.values()].filter((arr) => arr.some((x) => x.admitted)).length;
    admitted += adm;

    for (const [reason, count] of Object.entries(r.rejectReasonDistribution)) {
      rejectTotals[reason] = (rejectTotals[reason] ?? 0) + count;
    }

    const prov = r.scoreProvenanceSample ?? [];
    for (const p of prov) {
      if (p.finalBandAwareScore == null) continue;
      allObs.push({ score: p.finalBandAwareScore, band: p.shadowBand ?? "unknown" });
    }

    if (i < ticks - 1 && cadenceMs > 0) await sleep(cadenceMs);
  }

  const scores = allObs.map((o) => o.score).sort((a, b) => a - b);
  const sensitivity = levels.map((thr) => {
    const pass = allObs.filter((o) => o.score >= thr).length;
    return { threshold: thr, passCount: pass, passRate: allObs.length > 0 ? pass / allObs.length : null };
  });

  const byBand = BANDS.map((band) => {
    const rows = allObs.filter((o) => o.band === band);
    const avg = rows.length ? rows.reduce((a, b) => a + b.score, 0) / rows.length : null;
    return {
      band,
      count: rows.length,
      avgScore: avg,
      medianScore: median(rows.map((r) => r.score)),
      passCurrent: rows.length ? rows.filter((r) => r.score >= baselineThreshold).length / rows.length : null,
      passM05: rows.length ? rows.filter((r) => r.score >= Math.max(0, baselineThreshold - 0.05)).length / rows.length : null,
      passP05: rows.length ? rows.filter((r) => r.score >= Math.min(1, baselineThreshold + 0.05)).length / rows.length : null,
    };
  });

  const choke = (() => {
    const spread = (rejectTotals["liquidity_spread"] ?? 0) + (rejectTotals["liquidity_slippage"] ?? 0);
    const cooldown = rejectTotals["cooldown_asset"] ?? 0;
    const directional = rejectTotals["directional_temporarily_disabled_for_eval"] ?? 0;
    const candidates = [
      { k: "threshold", v: thresholdRemoved },
      { k: "spread/liquidity", v: spread },
      { k: "cooldown", v: cooldown },
      { k: "directional gate", v: directional },
    ].sort((a, b) => b.v - a.v);
    if (candidates[0]!.v === 0) return "mixed";
    if (candidates.length > 1 && candidates[0]!.v - candidates[1]!.v < Math.max(2, Math.floor(candidates[0]!.v * 0.15))) {
      return "mixed";
    }
    return candidates[0]!.k;
  })();

  const conclusion = (() => {
    if (allObs.length < 50 || scoredUnique < 50) return "evidence still insufficient";
    const passRate = allObs.length ? allObs.filter((o) => o.score >= baselineThreshold).length / allObs.length : 0;
    if (passRate < 0.2) return "threshold likely too strict";
    if (passRate > 0.8) return "threshold likely too loose";
    return "threshold roughly appropriate";
  })();

  const lines: string[] = [];
  lines.push("# V2 Overlay Multitick Threshold Study");
  lines.push("");
  lines.push(`- Generated: ${generatedAt}`);
  lines.push("");
  lines.push("## A. Window definition");
  lines.push(`- window: ${ticks} dry-run ticks, cadence ${cadenceMs}ms`);
  lines.push(`- first tick: ${tickTimestamps[0] ?? "-"}`);
  lines.push(`- last tick: ${tickTimestamps[tickTimestamps.length - 1] ?? "-"}`);
  lines.push("- data source: repeated dry-run sampling via `runPaperTradingTickV2({ dryRun: true })`");
  lines.push("- persistence status: not historical per-tick DB persistence; sampled runtime snapshots");
  lines.push("");
  lines.push("## B. Aggregated funnel");
  const base = scoredUnique > 0 ? scoredUnique : 1;
  lines.push(`- raw candidates (sum across ticks): ${rawCandidates}`);
  lines.push(`- scored unique-candidate observations: ${scoredUnique} (${pct(scoredUnique / base)})`);
  lines.push(`- pass threshold: ${passThreshold} (${pct(passThreshold / base)})`);
  lines.push(`- survive filters: ${surviveFilters} (${pct(surviveFilters / base)})`);
  lines.push(`- admitted: ${admitted} (${pct(admitted / base)})`);
  lines.push("");
  lines.push("## C. Threshold sensitivity (window)");
  lines.push(`- baseline threshold: ${baselineThreshold.toFixed(4)}`);
  lines.push(`- score distribution min/p25/median/p75/max: ${fmt(scores[0] ?? null)} / ${fmt(q(scores, 0.25))} / ${fmt(q(scores, 0.5))} / ${fmt(q(scores, 0.75))} / ${fmt(scores[scores.length - 1] ?? null)}`);
  lines.push("| threshold | pass count | pass rate |");
  lines.push("| ---: | ---: | ---: |");
  for (const r of sensitivity) {
    lines.push(`| ${r.threshold.toFixed(4)} | ${r.passCount} | ${pct(r.passRate)} |`);
  }
  lines.push("");
  lines.push("### By-band pass rates (sampled)");
  lines.push("| band | count | avg score | median score | pass@current | pass@(current-0.05) | pass@(current+0.05) |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const r of byBand) {
    lines.push(`| ${r.band} | ${r.count} | ${fmt(r.avgScore)} | ${fmt(r.medianScore)} | ${pct(r.passCurrent)} | ${pct(r.passM05)} | ${pct(r.passP05)} |`);
  }
  lines.push("");
  lines.push("## D. Band-specific pressure");
  for (const r of byBand) {
    if (r.count < 10) continue;
    lines.push(
      `- ${r.band}: n=${r.count}, avg=${fmt(r.avgScore)}, median=${fmt(r.medianScore)}, pass@current=${pct(r.passCurrent)}, pass@-0.05=${pct(r.passM05)}, pass@+0.05=${pct(r.passP05)}`
    );
  }
  lines.push("");
  lines.push("## E. Dominant choke point");
  lines.push(`- ${choke}`);
  lines.push(`- reject counts (per-bot trace aggregate): \`${JSON.stringify(rejectTotals)}\``);
  lines.push(`- threshold-removed unique observations: ${thresholdRemoved}`);
  lines.push("");
  lines.push("## F. Blunt conclusion");
  lines.push(`- ${conclusion}`);

  const outDir = path.join(process.cwd(), "diagnostics");
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, "v2-overlay-multitick-threshold-study.md");
  await fs.writeFile(outPath, lines.join("\n"), "utf8");
  console.log(`Wrote ${outPath}`);
}

function q(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[idx] ?? null;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

