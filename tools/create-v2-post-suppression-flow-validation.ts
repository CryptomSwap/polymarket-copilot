import "dotenv/config";
import * as fs from "fs/promises";
import * as path from "path";
import { runPaperTradingTickV2, type PaperTickV2RejectReason } from "../lib/paper-trading/engine_v2_minimal";

function pct(n: number, d: number): string {
  if (!d) return "-";
  return `${((n / d) * 100).toFixed(2)}%`;
}

type Counts = Record<string, number>;

function addCount(map: Counts, key: string, n = 1): void {
  map[key] = (map[key] ?? 0) + n;
}

async function main(): Promise<void> {
  const ticks = Math.max(1, parseInt(process.env.PAPER_POST_SUPPRESSION_VALIDATION_TICKS ?? "24", 10));
  const cadenceMs = Math.max(0, parseInt(process.env.PAPER_POST_SUPPRESSION_VALIDATION_CADENCE_MS ?? "500", 10));
  const generatedAt = new Date().toISOString();

  let rawCandidates = 0;
  let scoredUnique = 0;
  let passThresholdUnique = 0;
  let surviveFiltersUnique = 0;
  let eligibleUnique = 0;
  let admittedUnique = 0;
  let eligibleUniqueNonDuplicate = 0;
  let admittedFromEligibleUniqueNonDuplicate = 0;

  let preSuppressedAlreadyOpen = 0;
  let finalDedupeSameTick = 0;
  let finalDedupeExistingDb = 0;
  let finalDedupeUniqueConstraint = 0;

  const suppressedByBotType: Counts = {};
  const suppressedByBand: Counts = {};
  const blockers: Counts = {};

  for (let i = 0; i < ticks; i++) {
    const res = await runPaperTradingTickV2({ dryRun: true });
    const trace = res.trace ?? [];

    const uniqueCandidates = new Map<
      string,
      { admitted: boolean; reasons: Set<PaperTickV2RejectReason>; scored: boolean }
    >();
    for (const t of trace) {
      const e = uniqueCandidates.get(t.recommendationId) ?? {
        admitted: false,
        reasons: new Set<PaperTickV2RejectReason>(),
        scored: t.score != null,
      };
      if (t.score != null) e.scored = true;
      if (t.admitted) e.admitted = true;
      if (t.rejectReason) e.reasons.add(t.rejectReason);
      uniqueCandidates.set(t.recommendationId, e);
    }

    rawCandidates += res.candidatesLoaded;
    scoredUnique += [...uniqueCandidates.values()].filter((v) => v.scored).length;

    const passThreshold = [...uniqueCandidates.values()].filter(
      (v) => !v.reasons.has("score_failed") && !v.reasons.has("below_threshold")
    ).length;
    passThresholdUnique += passThreshold;

    const surviveFilters = [...uniqueCandidates.values()].filter(
      (v) =>
        !v.reasons.has("score_failed") &&
        !v.reasons.has("below_threshold") &&
        !v.reasons.has("liquidity_spread") &&
        !v.reasons.has("liquidity_slippage")
    ).length;
    surviveFiltersUnique += surviveFilters;
    eligibleUnique += surviveFilters;

    const admittedNow = [...uniqueCandidates.values()].filter((v) => v.admitted).length;
    admittedUnique += admittedNow;

    const suppression = res.duplicateExposureSuppression;
    const collision = res.dedupeCollisionBreakdown;
    const preSupp = suppression?.totalSuppressed ?? 0;
    preSuppressedAlreadyOpen += preSupp;
    if (suppression?.byBotType) {
      for (const [k, v] of Object.entries(suppression.byBotType)) addCount(suppressedByBotType, k, v);
    }
    if (suppression?.byBand) {
      for (const [k, v] of Object.entries(suppression.byBand)) addCount(suppressedByBand, k, v);
    }
    finalDedupeSameTick += collision?.sameTickCollision ?? 0;
    finalDedupeExistingDb += collision?.existingDbCollision ?? 0;
    finalDedupeUniqueConstraint += collision?.uniqueConstraintCollision ?? 0;

    const nonDuplicateEligible = Math.max(0, surviveFilters - preSupp);
    eligibleUniqueNonDuplicate += nonDuplicateEligible;
    admittedFromEligibleUniqueNonDuplicate += Math.min(admittedNow, nonDuplicateEligible);

    // Post-suppression blockers from reject distribution.
    for (const [reason, count] of Object.entries(res.rejectReasonDistribution ?? {})) {
      if (!count) continue;
      addCount(blockers, reason, count);
    }

    if (i < ticks - 1 && cadenceMs > 0) await new Promise((r) => setTimeout(r, cadenceMs));
  }

  const finalDedupeCollisions = finalDedupeSameTick + finalDedupeExistingDb + finalDedupeUniqueConstraint;

  let conclusion = "evidence insufficient";
  if (preSuppressedAlreadyOpen > 0 && admittedUnique > 0) conclusion = "suppression successfully restored admission flow";
  else if (preSuppressedAlreadyOpen > 0 && admittedUnique === 0 && eligibleUniqueNonDuplicate > 0)
    conclusion = "suppression reduced waste but novel flow is still weak";
  else if (preSuppressedAlreadyOpen === 0) conclusion = "suppression had little practical effect";

  const lines: string[] = [];
  lines.push("# V2 Post-Suppression Flow Validation");
  lines.push("");
  lines.push(`- Generated: ${generatedAt}`);
  lines.push(`- Window: ${ticks} dry-run ticks, cadence ${cadenceMs}ms`);
  lines.push("");
  lines.push("## A. Flow funnel (aggregated)");
  lines.push(`- raw candidates: ${rawCandidates}`);
  lines.push(`- scored unique: ${scoredUnique} (${pct(scoredUnique, rawCandidates)})`);
  lines.push(`- pass threshold unique: ${passThresholdUnique} (${pct(passThresholdUnique, rawCandidates)})`);
  lines.push(`- survive filters unique: ${surviveFiltersUnique} (${pct(surviveFiltersUnique, rawCandidates)})`);
  lines.push(`- eligible unique: ${eligibleUnique} (${pct(eligibleUnique, rawCandidates)})`);
  lines.push(`- admitted unique: ${admittedUnique} (${pct(admittedUnique, rawCandidates)})`);
  lines.push("");
  lines.push("## B. Duplicate suppression impact");
  lines.push(`- total pre-suppressed already-open duplicates: ${preSuppressedAlreadyOpen}`);
  lines.push(`- suppression by botType: ${JSON.stringify(suppressedByBotType)}`);
  lines.push(`- suppression by band: ${JSON.stringify(suppressedByBand)}`);
  lines.push(
    `- remaining final dedupe collisions: ${finalDedupeCollisions} (same-tick=${finalDedupeSameTick}, existing-db=${finalDedupeExistingDb}, unique-constraint=${finalDedupeUniqueConstraint})`
  );
  lines.push("");
  lines.push("## C. Admission blockers after suppression");
  const blockerRows = Object.entries(blockers).sort((a, b) => b[1] - a[1]);
  for (const [k, v] of blockerRows) lines.push(`- ${k}: ${v}`);
  lines.push("");
  lines.push("## D. Novel flow quality");
  lines.push(`- eligible unique non-duplicate candidates: ${eligibleUniqueNonDuplicate}`);
  lines.push(`- admitted (from novel eligible pool): ${admittedFromEligibleUniqueNonDuplicate}`);
  lines.push(
    `- admission conversion from novel eligible pool: ${pct(admittedFromEligibleUniqueNonDuplicate, Math.max(1, eligibleUniqueNonDuplicate))}`
  );
  lines.push("");
  lines.push("## E. Blunt conclusion");
  lines.push(`- ${conclusion}`);

  const outDir = path.join(process.cwd(), "diagnostics");
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, "v2-post-suppression-flow-validation.md");
  await fs.writeFile(outPath, lines.join("\n"), "utf8");
  console.log(`Wrote ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

