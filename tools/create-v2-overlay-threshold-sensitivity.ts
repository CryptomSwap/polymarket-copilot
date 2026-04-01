import "dotenv/config";
import * as fs from "fs/promises";
import * as path from "path";
import { runPaperTradingTickV2 } from "../lib/paper-trading/engine_v2_minimal";
import { getActiveBotProfiles } from "../lib/paper-trading/bot-profiles";
import { getPaperTradingConfig } from "../lib/paper-trading/config";

type CandidateView = {
  recommendationId: string;
  score: number;
  band: string;
};

const BANDS = ["<0.1", "0.1-0.2", "0.2-0.3", "0.3-0.4", "0.4-0.6", "0.6-0.8", "0.8-0.9", ">=0.9"] as const;

function q(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[i] ?? null;
}
function fmt(n: number | null, d = 4): string {
  return n == null ? "-" : n.toFixed(d);
}
function pct(n: number | null): string {
  return n == null ? "-" : `${(n * 100).toFixed(2)}%`;
}
function bandFromPrice(priceRaw: string | null | undefined): string {
  const p = priceRaw == null ? NaN : Number.parseFloat(String(priceRaw));
  if (!Number.isFinite(p)) return "unknown";
  if (p < 0.1) return "<0.1";
  if (p < 0.2) return "0.1-0.2";
  if (p < 0.3) return "0.2-0.3";
  if (p < 0.4) return "0.3-0.4";
  if (p < 0.6) return "0.4-0.6";
  if (p < 0.8) return "0.6-0.8";
  if (p < 0.9) return "0.8-0.9";
  return ">=0.9";
}

async function main(): Promise<void> {
  const generatedAt = new Date().toISOString();
  const cfg = getPaperTradingConfig();
  const activeProfiles = await getActiveBotProfiles();
  const profiles =
    activeProfiles.length > 0
      ? activeProfiles
      : [
          {
            botType: "default",
            threshold: cfg.threshold,
            minScoreBuffer: cfg.minScoreBuffer,
          },
        ];
  const thresholdByBot = new Map(profiles.map((p) => [p.botType, p.threshold + p.minScoreBuffer]));
  const uniqueThresholds = [...new Set([...thresholdByBot.values()])].sort((a, b) => a - b);
  const baseThreshold = uniqueThresholds.length > 0 ? uniqueThresholds[0]! : cfg.threshold + cfg.minScoreBuffer;

  const tick = await runPaperTradingTickV2({ dryRun: true });
  const trace = tick.trace ?? [];
  const byRec = new Map<string, CandidateView>();
  for (const t of trace) {
    if (t.score == null) continue;
    if (!byRec.has(t.recommendationId)) {
      const price = tick.scoreProvenanceSample?.find((x) => x.recommendationId === t.recommendationId)?.shadowBand ?? "unknown";
      byRec.set(t.recommendationId, { recommendationId: t.recommendationId, score: t.score, band: price });
    }
  }
  const candidates = [...byRec.values()];
  const scores = candidates.map((c) => c.score).sort((a, b) => a - b);

  const levels = [baseThreshold - 0.1, baseThreshold - 0.05, baseThreshold, baseThreshold + 0.05, baseThreshold + 0.1]
    .map((x) => Math.max(0, Math.min(1, Number(x.toFixed(4)))));

  const admittedRows = trace.filter((t) => t.admitted && t.score != null);
  const thresholdTable = levels.map((thr) => {
    const passCount = candidates.filter((c) => c.score >= thr).length;
    const passPct = candidates.length > 0 ? passCount / candidates.length : null;
    // Exact derivation only for thr >= current (stricter) from currently admitted traces.
    const stricterOrEqual = thr >= baseThreshold;
    const admittedDerivable = stricterOrEqual
      ? [...new Set(admittedRows.filter((t) => (t.score as number) >= thr).map((t) => t.recommendationId))].length
      : null;
    const surviveDerivable = stricterOrEqual ? admittedDerivable : null;
    return { threshold: thr, passCount, passPct, surviveDerivable, admittedDerivable };
  });

  const byBand = BANDS.map((band) => {
    const rows = candidates.filter((c) => c.band === band);
    const avgScore = rows.length > 0 ? rows.reduce((a, b) => a + b.score, 0) / rows.length : null;
    const at = (thr: number) => (rows.length > 0 ? rows.filter((r) => r.score >= thr).length / rows.length : null);
    return {
      band,
      count: rows.length,
      avgScore,
      passCurrent: at(baseThreshold),
      passMinus05: at(Math.max(0, baseThreshold - 0.05)),
      passPlus05: at(Math.min(1, baseThreshold + 0.05)),
    };
  });

  const lines: string[] = [];
  lines.push("# V2 Overlay Threshold Sensitivity");
  lines.push("");
  lines.push(`- Generated: ${generatedAt}`);
  lines.push(`- Mode: dry-run latest tick (read-only)`);
  lines.push("");
  lines.push("## A. Current threshold context");
  lines.push(`- Live function: \`runPaperTradingTickV2\` in \`lib/paper-trading/engine_v2_minimal.ts\``);
  lines.push("- Score field compared to threshold: `ScoredCandidate.score` (overlay finalBandAwareScore in shadow_ml path).");
  lines.push(`- Active bot thresholds (threshold + minScoreBuffer): \`${JSON.stringify(Object.fromEntries(thresholdByBot.entries()))}\``);
  lines.push(`- Sensitivity baseline threshold used: ${baseThreshold.toFixed(4)}`);
  lines.push("");
  lines.push("## B. Candidate score distribution");
  lines.push(`- candidate count (unique): ${candidates.length}`);
  lines.push(`- min / p25 / median / p75 / max: ${fmt(q(scores, 0))} / ${fmt(q(scores, 0.25))} / ${fmt(q(scores, 0.5))} / ${fmt(q(scores, 0.75))} / ${fmt(q(scores, 1))}`);
  const hist = {
    "[0.0,0.2)": candidates.filter((c) => c.score < 0.2).length,
    "[0.2,0.4)": candidates.filter((c) => c.score >= 0.2 && c.score < 0.4).length,
    "[0.4,0.6)": candidates.filter((c) => c.score >= 0.4 && c.score < 0.6).length,
    "[0.6,0.8)": candidates.filter((c) => c.score >= 0.6 && c.score < 0.8).length,
    "[0.8,1.0]": candidates.filter((c) => c.score >= 0.8).length,
  };
  lines.push(`- histogram: \`${JSON.stringify(hist)}\``);
  lines.push(`- above threshold (${baseThreshold.toFixed(4)}): ${candidates.filter((c) => c.score >= baseThreshold).length}`);
  lines.push(`- below threshold (${baseThreshold.toFixed(4)}): ${candidates.filter((c) => c.score < baseThreshold).length}`);
  lines.push("");
  lines.push("## C. Sensitivity table");
  lines.push("| threshold | pass count | pass % | survive filters (derivable) | admitted (derivable) |");
  lines.push("| ---: | ---: | ---: | ---: | ---: |");
  for (const r of thresholdTable) {
    lines.push(
      `| ${r.threshold.toFixed(4)} | ${r.passCount} | ${pct(r.passPct)} | ${r.surviveDerivable == null ? "n/a" : String(r.surviveDerivable)} | ${r.admittedDerivable == null ? "n/a" : String(r.admittedDerivable)} |`
    );
  }
  lines.push("- Note: for thresholds below current, post-threshold survival/admission is not exactly derivable from one trace because those candidates were never evaluated downstream.");
  lines.push("");
  lines.push("## D. By-band sensitivity");
  lines.push("| band | count | avg overlay score | pass@current | pass@(current-0.05) | pass@(current+0.05) |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: |");
  for (const r of byBand) {
    lines.push(
      `| ${r.band} | ${r.count} | ${fmt(r.avgScore)} | ${pct(r.passCurrent)} | ${pct(r.passMinus05)} | ${pct(r.passPlus05)} |`
    );
  }
  lines.push("");
  lines.push("## E. Blunt conclusion");
  const passRateCurrent = candidates.length > 0 ? candidates.filter((c) => c.score >= baseThreshold).length / candidates.length : null;
  const conclusion =
    candidates.length < 15
      ? "evidence insufficient"
      : passRateCurrent != null && passRateCurrent < 0.2
        ? "threshold clearly too strict for overlay score scale"
        : passRateCurrent != null && passRateCurrent > 0.8
          ? "threshold too loose"
          : "threshold roughly appropriate";
  lines.push(`- ${conclusion}`);

  const outDir = path.join(process.cwd(), "diagnostics");
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, "v2-overlay-threshold-sensitivity.md");
  await fs.writeFile(outPath, lines.join("\n"), "utf8");
  console.log(`Wrote ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

