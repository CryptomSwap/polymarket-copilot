import "dotenv/config";
import * as fs from "fs/promises";
import * as path from "path";
import { runPaperTradingTickV2, type PaperTickV2TraceEntry } from "../lib/paper-trading/engine_v2_minimal";
import { prisma } from "../lib/db";

const BANDS = ["<0.1", "0.1-0.2", "0.2-0.3", "0.3-0.4", "0.4-0.6", "0.6-0.8", "0.8-0.9", ">=0.9"] as const;

type CandidateAgg = {
  recommendationId: string;
  band: string;
  rows: PaperTickV2TraceEntry[];
};

function classifyOutcome(
  c: CandidateAgg,
  tickBreakdown: {
    sameTickCollision: number;
    existingDbCollision: number;
    openRowCollision: number;
    preSuppressedAlreadyOpen: number;
    closedRowBypassed: number;
  }
): { admitted: boolean; finalReason: string; blockerClass: string } {
  const admitted = c.rows.some((r) => r.admitted);
  if (admitted) return { admitted: true, finalReason: "admitted", blockerClass: "n/a" };

  const reasons = new Set(c.rows.map((r) => r.rejectReason).filter(Boolean));
  if (reasons.size === 1 && reasons.has("dedupe")) {
    // Candidate-level trace does not expose exact dedupe subtype; infer from tick-level counters.
    if (tickBreakdown.openRowCollision > 0 || tickBreakdown.preSuppressedAlreadyOpen > 0) {
      return { admitted: false, finalReason: "dedupe", blockerClass: "open-row collision / already-open exposure" };
    }
    if (tickBreakdown.existingDbCollision > 0) {
      return { admitted: false, finalReason: "dedupe", blockerClass: "existing-db dedupe collision" };
    }
    if (tickBreakdown.sameTickCollision > 0) {
      return { admitted: false, finalReason: "dedupe", blockerClass: "same-tick dedupe collision" };
    }
    return { admitted: false, finalReason: "dedupe", blockerClass: "dedupe (unattributed subtype)" };
  }

  return { admitted: false, finalReason: [...reasons].join(",") || "unknown", blockerClass: "other" };
}

async function main(): Promise<void> {
  const ticks = Math.max(1, parseInt(process.env.PAPER_ELIGIBLE_CONVERSION_TICKS ?? "24", 10));
  const cadenceMs = Math.max(0, parseInt(process.env.PAPER_ELIGIBLE_CONVERSION_CADENCE_MS ?? "500", 10));
  const generatedAt = new Date();

  let eligibleUnique = 0;
  let admittedUnique = 0;
  let eligibleDecisionRows = 0;
  const byBand: Record<string, number> = {};
  const byBotType: Record<string, number> = {};
  const blockerCounts: Record<string, number> = {};
  const blockerClassCounts: Record<string, number> = {};
  const mappingRows: Array<{
    tickTime: string;
    recommendationId: string;
    band: string;
    botTypes: string;
    admitted: boolean;
    finalReason: string;
    blockerClass: string;
  }> = [];

  let sumSameTick = 0;
  let sumExistingDb = 0;
  let sumOpenRow = 0;
  let sumPreSuppressed = 0;
  let sumClosedBypassed = 0;

  for (let i = 0; i < ticks; i++) {
    const r = await runPaperTradingTickV2({ dryRun: true });
    const byRec = new Map<string, CandidateAgg>();
    const bandByRec = new Map((r.scoreProvenanceSample ?? []).map((p) => [p.recommendationId, p.shadowBand ?? "unknown"]));

    for (const t of r.trace ?? []) {
      const eligibleDecision =
        t.admitted ||
        (t.rejectReason !== "below_threshold" &&
          t.rejectReason !== "score_failed" &&
          t.rejectReason !== "liquidity_spread" &&
          t.rejectReason !== "liquidity_slippage");
      if (!eligibleDecision) continue;
      eligibleDecisionRows++;
      byBotType[t.botType] = (byBotType[t.botType] ?? 0) + 1;
      const e = byRec.get(t.recommendationId) ?? {
        recommendationId: t.recommendationId,
        band: bandByRec.get(t.recommendationId) ?? "unknown",
        rows: [],
      };
      e.rows.push(t);
      byRec.set(t.recommendationId, e);
    }

    const breakdown = {
      sameTickCollision: r.dedupeCollisionBreakdown?.sameTickCollision ?? 0,
      existingDbCollision: r.dedupeCollisionBreakdown?.existingDbCollision ?? 0,
      openRowCollision: r.dedupeCollisionBreakdown?.openRowCollision ?? 0,
      preSuppressedAlreadyOpen: r.dedupeCollisionBreakdown?.preSuppressedAlreadyOpen ?? 0,
      closedRowBypassed: r.dedupeCollisionBreakdown?.closedRowBypassed ?? 0,
    };
    sumSameTick += breakdown.sameTickCollision;
    sumExistingDb += breakdown.existingDbCollision;
    sumOpenRow += breakdown.openRowCollision;
    sumPreSuppressed += breakdown.preSuppressedAlreadyOpen;
    sumClosedBypassed += breakdown.closedRowBypassed;

    for (const c of byRec.values()) {
      eligibleUnique++;
      byBand[c.band] = (byBand[c.band] ?? 0) + 1;
      const outcome = classifyOutcome(c, breakdown);
      if (outcome.admitted) admittedUnique++;
      blockerCounts[outcome.finalReason] = (blockerCounts[outcome.finalReason] ?? 0) + 1;
      blockerClassCounts[outcome.blockerClass] = (blockerClassCounts[outcome.blockerClass] ?? 0) + 1;
      mappingRows.push({
        tickTime: r.tickTime,
        recommendationId: c.recommendationId,
        band: c.band,
        botTypes: Array.from(new Set(c.rows.map((x) => x.botType))).join(","),
        admitted: outcome.admitted,
        finalReason: outcome.finalReason,
        blockerClass: outcome.blockerClass,
      });
    }

    if (i < ticks - 1 && cadenceMs > 0) await new Promise((res) => setTimeout(res, cadenceMs));
  }

  // Real persistence check for same wall clock window.
  const windowStart = new Date(generatedAt.getTime() - ticks * cadenceMs - 5 * 60 * 1000);
  const persisted = await prisma.paperTrade.count({
    where: {
      dedupeKey: { contains: "|v2|" },
      createdAt: { gte: windowStart },
    },
  });

  const lines: string[] = [];
  lines.push("# V2 Eligible To Admission Conversion Audit");
  lines.push("");
  lines.push(`- Generated: ${generatedAt.toISOString()}`);
  lines.push(`- Window: ${ticks} dry-run ticks, cadence ${cadenceMs}ms`);
  lines.push("");
  lines.push("## A. Eligible set");
  lines.push(`- unique candidates passing threshold and surviving filters: ${eligibleUnique}`);
  lines.push(`- per-bot eligible decision rows: ${eligibleDecisionRows}`);
  lines.push(`- by band: ${JSON.stringify(byBand)}`);
  lines.push(`- by botType (decision rows): ${JSON.stringify(byBotType)}`);
  lines.push("");
  lines.push("## B. Final outcome mapping");
  lines.push("| tickTime | recommendationId | band | botTypes | admitted | final reason | blocker class |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const m of mappingRows.slice(0, 60)) {
    lines.push(
      `| ${m.tickTime} | ${m.recommendationId} | ${m.band} | ${m.botTypes} | ${m.admitted ? "yes" : "no"} | ${m.finalReason} | ${m.blockerClass} |`
    );
  }
  if (mappingRows.length > 60) lines.push(`- truncated ${mappingRows.length - 60} additional mapping rows`);
  lines.push("");
  lines.push("## C. Dry-run vs real-path distinction");
  lines.push("- Primary conversion evidence in this report is from dry-run trace simulation.");
  lines.push("- In dry-run, admission decisions are simulated and not inserted by this script.");
  lines.push(`- Persisted V2 rows in same approximate wall-clock window: ${persisted}`);
  lines.push("");
  lines.push("## D. Collision accounting sanity");
  lines.push(`- unique eligible candidates: ${eligibleUnique}`);
  lines.push(`- per-bot eligible decision rows: ${eligibleDecisionRows}`);
  lines.push(`- admitted unique candidates: ${admittedUnique}`);
  lines.push(`- blocker counts (unique-candidate mapped): ${JSON.stringify(blockerCounts)}`);
  lines.push(`- blocker classes (unique-candidate mapped): ${JSON.stringify(blockerClassCounts)}`);
  lines.push(
    `- dedupe subtype counters (tick aggregate): preSuppressedAlreadyOpen=${sumPreSuppressed}, openRowCollision=${sumOpenRow}, existingDbCollision=${sumExistingDb}, sameTickCollision=${sumSameTick}, closedRowBypassed=${sumClosedBypassed}`
  );
  lines.push("- Count differences are expected because reject totals are per-bot decision rows, while mapping is collapsed to unique candidates.");
  lines.push("");
  lines.push("## E. Blunt conclusion");
  let conclusion = "evidence insufficient";
  if (eligibleUnique > 0 && admittedUnique > 0 && sumClosedBypassed > 0) conclusion = "dry-run measurement artifact";
  else if (eligibleUnique > 0 && admittedUnique === 0 && (sumOpenRow + sumExistingDb + sumSameTick) > 0)
    conclusion = "dedupe still blocks real conversion";
  else if (eligibleUnique > 0 && admittedUnique > 0) conclusion = "accounting/reporting mismatch only";
  lines.push(`- ${conclusion}`);

  const outDir = path.join(process.cwd(), "diagnostics");
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, "v2-eligible-to-admission-conversion-audit.md");
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

