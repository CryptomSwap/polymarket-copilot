import "dotenv/config";
import * as fs from "fs/promises";
import * as path from "path";
import { runPaperTradingTickV2 } from "../lib/paper-trading/engine_v2_minimal";

function fmtPct(n: number | null): string {
  return n == null ? "-" : `${(n * 100).toFixed(2)}%`;
}

function avg(nums: number[]): number | null {
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function fmtNum(n: number | null, d = 6): string {
  return n == null ? "-" : n.toFixed(d);
}

async function main(): Promise<void> {
  const generatedAt = new Date().toISOString();
  // Read-only run to inspect current overlay-era flow without opening trades.
  const tick = await runPaperTradingTickV2({ dryRun: true });

  const scoredCount = tick.scorePopulationSnapshot?.uniqueCandidatesScored ?? tick.candidatesPassedFilter;
  const trace = tick.trace ?? [];
  const traceByRec = new Map<string, typeof trace>();
  for (const t of trace) {
    const arr = traceByRec.get(t.recommendationId) ?? [];
    arr.push(t);
    traceByRec.set(t.recommendationId, arr);
  }
  const uniqueCandidates = [...traceByRec.keys()].length || tick.candidatesLoaded;
  const scoreFailed = [...traceByRec.values()].filter((arr) => arr.every((x) => x.rejectReason === "score_failed")).length;
  const failThreshold = [...traceByRec.values()].filter((arr) =>
    arr.every((x) => x.rejectReason === "below_threshold" || x.rejectReason === "score_failed")
  ).length;
  const passThreshold = Math.max(0, uniqueCandidates - failThreshold);
  const surviveFilters = [...traceByRec.values()].filter((arr) =>
    arr.some((x) => x.admitted || (x.rejectReason !== "below_threshold" && x.rejectReason !== "score_failed" && x.rejectReason !== "liquidity_spread" && x.rejectReason !== "liquidity_slippage"))
  ).length;
  const admitted = [...traceByRec.values()].filter((arr) => arr.some((x) => x.admitted)).length;

  const scoreVals = trace.map((t) => t.score).filter((x): x is number => x != null);
  const sortedScores = [...scoreVals].sort((a, b) => a - b);
  const median =
    sortedScores.length === 0
      ? null
      : sortedScores.length % 2
        ? sortedScores[Math.floor(sortedScores.length / 2)]!
        : (sortedScores[sortedScores.length / 2 - 1]! + sortedScores[sortedScores.length / 2]!) / 2;

  const rejectedScores = trace
    .filter((t) => !t.admitted && t.score != null)
    .map((t) => t.score as number);
  const passedScores = trace
    .filter((t) => t.admitted && t.score != null)
    .map((t) => t.score as number);

  const rejectByReason = Object.entries(tick.rejectReasonDistribution)
    .filter(([, c]) => c > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const dominantChoke = (() => {
    const stages = [
      { stage: "scoring_failed", removed: scoreFailed },
      { stage: "threshold_failed", removed: failThreshold },
      {
        stage: "post_threshold_filters",
        removed: Math.max(0, passThreshold - surviveFilters),
      },
      {
        stage: "post_filter_admission",
        removed: Math.max(0, surviveFilters - admitted),
      },
    ];
    stages.sort((a, b) => b.removed - a.removed);
    return stages[0];
  })();

  const lines: string[] = [];
  lines.push("# V2 Overlay Flow Breakdown");
  lines.push("");
  lines.push(`- Generated: ${generatedAt}`);
  lines.push(`- Mode: dry-run V2 tick (read-only, no trade creation)`);
  lines.push(`- Scorer source: ${tick.scorePopulationSnapshot?.scorerSource ?? "unknown"}`);
  lines.push("");
  lines.push("## A. Candidate generation");
  lines.push(`- total raw candidates: ${tick.candidatesLoaded}`);
  lines.push("");
  lines.push("## B. After scoring");
  lines.push(`- total scored candidates (unique): ${scoredCount}`);
  lines.push(`- score min / median / max: ${fmtNum(sortedScores[0] ?? null)} / ${fmtNum(median)} / ${fmtNum(sortedScores[sortedScores.length - 1] ?? null)}`);
  lines.push("");
  lines.push("## C. Threshold stage");
  lines.push(`- pass threshold (unique candidates, any bot): ${passThreshold}`);
  lines.push(`- fail threshold (unique candidates): ${failThreshold}`);
  lines.push(`- fail scoring (unique candidates): ${scoreFailed}`);
  lines.push("");
  lines.push("## D. Rejection breakdown");
  if (rejectByReason.length === 0) {
    lines.push("- none");
  } else {
    for (const [reason, count] of rejectByReason) {
      lines.push(`- ${reason}: ${count}`);
    }
  }
  lines.push("");
  lines.push("## E. Admission");
  lines.push(`- total admitted trades: ${admitted}`);
  lines.push("");
  lines.push("## Funnel");
  const pctFromRaw = (n: number) => (uniqueCandidates > 0 ? n / uniqueCandidates : null);
  lines.push(`- candidates (unique): ${uniqueCandidates} (${fmtPct(pctFromRaw(uniqueCandidates))})`);
  lines.push(`- scored (unique): ${scoredCount} (${fmtPct(pctFromRaw(scoredCount))})`);
  lines.push(`- pass threshold (unique): ${passThreshold} (${fmtPct(pctFromRaw(passThreshold))})`);
  lines.push(`- survive filters (unique): ${surviveFilters} (${fmtPct(pctFromRaw(surviveFilters))})`);
  lines.push(`- admitted (unique): ${admitted} (${fmtPct(pctFromRaw(admitted))})`);
  lines.push("- Note: trace rows are per-bot decisions; funnel above is collapsed to unique candidates.");
  lines.push("");
  lines.push("## Score diagnostics");
  lines.push(`- rejected candidates avg score: ${fmtNum(avg(rejectedScores))}`);
  lines.push(`- passed/admitted candidates avg score: ${fmtNum(avg(passedScores))}`);
  lines.push("");
  lines.push("## Dominant choke point");
  lines.push(`- ${dominantChoke.stage} removed ${dominantChoke.removed} candidates`);
  lines.push("");
  lines.push("## Blunt conclusion");
  const conclusion = (() => {
    if (dominantChoke.stage === "scoring_failed") return "scoring too weak (no candidates above threshold)";
    if (dominantChoke.stage === "threshold_failed") return "threshold too strict";
    if (dominantChoke.stage === "post_threshold_filters") {
      const spread = rejectByReason.find(([r]) => r === "liquidity_spread")?.[1] ?? 0;
      const cooldown = rejectByReason.find(([r]) => r === "cooldown_asset")?.[1] ?? 0;
      const directional = rejectByReason.find(([r]) => r === "directional_temporarily_disabled_for_eval")?.[1] ?? 0;
      if (spread >= cooldown && spread >= directional && spread > 0) return "spread filter too strict";
      if (cooldown >= spread && cooldown >= directional && cooldown > 0) return "cooldown blocking everything";
      if (directional >= spread && directional >= cooldown && directional > 0) return "directional gate blocking everything";
      return "multiple constraints interacting";
    }
    return "multiple constraints interacting";
  })();
  lines.push(`- ${conclusion}`);

  const outDir = path.join(process.cwd(), "diagnostics");
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, "v2-overlay-flow-breakdown.md");
  await fs.writeFile(outPath, lines.join("\n"), "utf8");
  console.log(`Wrote ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
