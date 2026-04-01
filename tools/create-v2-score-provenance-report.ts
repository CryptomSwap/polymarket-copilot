import "dotenv/config";
import * as fs from "fs/promises";
import * as path from "path";
import { runPaperTradingTickV2 } from "../lib/paper-trading/engine_v2_minimal";

function fmt(n: number | null | undefined, d = 6): string {
  return n == null ? "-" : n.toFixed(d);
}

function parseBoolEnv(key: string, fallback: boolean): boolean {
  const raw = process.env[key]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === "1" || raw === "true" || raw === "yes" || raw === "on") return true;
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") return false;
  return fallback;
}

function parseScoreBucketRows(md: string): Array<{ bucket: string; avgMarkout: number | null }> {
  const out: Array<{ bucket: string; avgMarkout: number | null }> = [];
  const lines = md.split(/\r?\n/);
  let inTable = false;
  for (const line of lines) {
    if (line.startsWith("### Structured score separation")) {
      inTable = false;
      continue;
    }
    if (line.startsWith("| score bucket |")) {
      inTable = true;
      continue;
    }
    if (!inTable) continue;
    if (!line.startsWith("|")) break;
    if (line.includes("---")) continue;
    const cols = line.split("|").map((x) => x.trim()).filter((x) => x.length > 0);
    if (cols.length < 5) continue;
    const bucket = cols[0] ?? "";
    const avgMarkout = cols[2] === "-" ? null : Number(cols[2]);
    out.push({ bucket, avgMarkout: Number.isFinite(avgMarkout as number) ? (avgMarkout as number) : null });
  }
  return out;
}

async function main(): Promise<void> {
  const generatedAt = new Date().toISOString();
  const useStructuredScorer = parseBoolEnv("PAPER_TRADING_USE_STRUCTURED_SCORER", false);
  const tick = await runPaperTradingTickV2();

  const evidencePath = path.join(process.cwd(), "diagnostics", "v2-structured-live-evidence-pack.md");
  let evidenceMd = "";
  try {
    evidenceMd = await fs.readFile(evidencePath, "utf8");
  } catch {
    evidenceMd = "";
  }
  const scoreBuckets = evidenceMd ? parseScoreBucketRows(evidenceMd) : [];

  const inversionNote = (() => {
    if (scoreBuckets.length < 2) return "Insufficient score-bucket rows in evidence artifact.";
    const sorted = [...scoreBuckets].filter((r) => r.avgMarkout != null);
    if (sorted.length < 2) return "No comparable avg markout rows.";
    const top = sorted[sorted.length - 1]!;
    const mid = sorted[Math.floor((sorted.length - 1) / 2)]!;
    if ((top.avgMarkout ?? 0) >= (mid.avgMarkout ?? 0)) {
      return `Top bucket (${top.bucket}) avg markout >= mid bucket (${mid.bucket}).`;
    }
    return `Top bucket (${top.bucket}) avg markout < mid bucket (${mid.bucket}) -> global inversion still present.`;
  })();

  const lines: string[] = [];
  lines.push("# V2 Score Provenance Report");
  lines.push("");
  lines.push(`- Generated: ${generatedAt}`);
  lines.push(`- Env scorer switch: PAPER_TRADING_USE_STRUCTURED_SCORER=${useStructuredScorer}`);
  lines.push("");
  lines.push("## A. End-to-end scorer path");
  lines.push("- Candidate generation: `loadShadowCandidatesForPaperTick` in `lib/paper-trading/candidates.ts`.");
  lines.push("- Score assignment switch: `runPaperTradingTickV2` in `lib/paper-trading/engine_v2_minimal.ts`.");
  lines.push("- Structured path score field: `ScoredCandidate.score = structured blended score` from `scoreStructuredCandidates`.");
  lines.push("- Shadow path score field: raw `shadowMlScore` is computed first, then band-aware overlay may set `ScoredCandidate.score` for global comparability.");
  lines.push("- Ranking: `passedFilter.sort((a,b)=>b.score-a.score)` (descending).");
  lines.push("- Thresholding: `if (score < threshold)` where `threshold = profile.threshold + profile.minScoreBuffer`.");
  lines.push("- Admission/open create: `prisma.paperTrade.create({ score, threshold, ... })` using same `score` field.");
  lines.push("");
  lines.push("## B. Effective score used at each stage");
  lines.push(`- Active scorer in live tick: ${useStructuredScorer ? "structured" : "shadow_ml"}`);
  lines.push("- `actualScoreUsedForOrdering/Threshold` is exactly `ScoredCandidate.score`.");
  lines.push("- No later overwrite/switch after scoring map construction; downstream stages only filter/reject.");
  lines.push("");
  lines.push("## C. Overwrite/switch points");
  lines.push("- Single switch point: env gate `PAPER_TRADING_USE_STRUCTURED_SCORER`.");
  lines.push("- No mid-pipeline scorer switch after the gate in current V2 path.");
  lines.push("");
  lines.push("## D. Tick score provenance sample (top N)");
  lines.push("```json");
  lines.push(JSON.stringify(tick.scoreProvenanceSample ?? [], null, 2));
  lines.push("```");
  lines.push("");
  lines.push("## E. Inversion source assessment");
  lines.push(`- Evidence artifact check: ${inversionNote}`);
  const hasBandAware = (tick.scoreProvenanceSample ?? []).some((r) => r.finalBandAwareScore != null);
  lines.push(
    hasBandAware
      ? "- Shadow path currently applies band-aware overlay (raw shadow score retained in provenance alongside final score)."
      : "- Shadow path currently uses raw shadow score directly (no band-aware overlay in tick sample)."
  );
  lines.push(
    "- Downstream filters (spread/caps/dedupe) can change admitted set composition, but they do not alter the ranking score value itself."
  );

  const outDir = path.join(process.cwd(), "diagnostics");
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, "v2-score-provenance-report.md");
  await fs.writeFile(outPath, lines.join("\n"), "utf8");
  console.log(`Wrote ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
