import "dotenv/config";
import * as fs from "fs/promises";
import * as path from "path";
import { runPaperTradingTickV2, type PaperTickV2RejectReason } from "../lib/paper-trading/engine_v2_minimal";
import { prisma } from "../lib/db";

type EligibleOutcome = {
  recommendationId: string;
  assetId: string;
  marketId: string;
  side: string;
  botType: string;
  score: number | null;
  admitted: boolean;
  rejectReason: PaperTickV2RejectReason | null;
};

function fmt(n: number | null, d = 6): string {
  return n == null ? "-" : n.toFixed(d);
}

function avg(nums: number[]): number | null {
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

async function main(): Promise<void> {
  const generatedAt = new Date().toISOString();
  const tick = await runPaperTradingTickV2({ dryRun: true });
  const trace = tick.trace ?? [];

  const eligibleOutcomes: EligibleOutcome[] = trace
    .filter((t) => t.rejectReason === null || t.rejectReason === "dedupe" || t.rejectReason === "global_max_open_total" || t.rejectReason === "bot_max_open")
    .map((t) => ({
      recommendationId: t.recommendationId,
      assetId: t.assetId,
      marketId: t.marketId,
      side: t.side,
      botType: t.botType,
      score: t.score,
      admitted: t.admitted,
      rejectReason: t.rejectReason,
    }));

  const uniqueEligible = new Set(eligibleOutcomes.map((e) => e.recommendationId));
  const admittedEligible = eligibleOutcomes.filter((e) => e.admitted);
  const rejectedEligible = eligibleOutcomes.filter((e) => !e.admitted);

  const rejectBreakdown = rejectedEligible.reduce<Record<string, number>>((acc, r) => {
    const key = r.rejectReason ?? "unknown";
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

  const dedupeRejected = rejectedEligible.filter((r) => r.rejectReason === "dedupe");

  // In this tick, dedupeKey effectively groups by botType+assetId+side (plus model/time bucket).
  const dedupeGroups = new Map<
    string,
    Array<{
      recommendationId: string;
      score: number | null;
      admitted: boolean;
    }>
  >();
  for (const e of eligibleOutcomes.filter((x) => x.admitted || x.rejectReason === "dedupe")) {
    const key = `${e.botType}|${e.assetId}|${e.side}`;
    const arr = dedupeGroups.get(key) ?? [];
    arr.push({
      recommendationId: e.recommendationId,
      score: e.score,
      admitted: e.admitted,
    });
    dedupeGroups.set(key, arr);
  }

  const dedupeRows: Array<{
    key: string;
    count: number;
    preserved: string;
    preservedScore: number | null;
    suppressed: string;
    suppressedScores: string;
    topScorePreserved: boolean;
  }> = [];

  for (const [key, rows] of dedupeGroups.entries()) {
    if (rows.length <= 1) continue;
    const sorted = [...rows].sort((a, b) => {
      const sa = a.score ?? -Infinity;
      const sb = b.score ?? -Infinity;
      if (sb !== sa) return sb - sa;
      return a.recommendationId.localeCompare(b.recommendationId);
    });
    const preserved = rows.find((r) => r.admitted) ?? sorted[0]!;
    const suppressed = rows.filter((r) => !r.admitted);
    dedupeRows.push({
      key,
      count: rows.length,
      preserved: preserved.recommendationId,
      preservedScore: preserved.score,
      suppressed: suppressed.map((s) => s.recommendationId).join(", "),
      suppressedScores: suppressed.map((s) => fmt(s.score)).join(", "),
      topScorePreserved: preserved.recommendationId === sorted[0]!.recommendationId,
    });
  }

  const dbCollisionRows = await Promise.all(
    dedupeRejected.map(async (r) => {
      const openCount = await prisma.paperTrade.count({
        where: {
          status: "open",
          botType: r.botType,
          assetId: r.assetId,
          side: r.side,
        },
      });
      return {
        recommendationId: r.recommendationId,
        botType: r.botType,
        assetId: r.assetId,
        side: r.side,
        score: r.score,
        openTradeCollisions: openCount,
      };
    })
  );

  const admittedScores = admittedEligible.map((x) => x.score).filter((x): x is number => x != null);
  const rejectedScores = rejectedEligible.map((x) => x.score).filter((x): x is number => x != null);
  const dedupeSuppressedScores = dedupeRejected.map((x) => x.score).filter((x): x is number => x != null);
  const dedupePreservedScores = admittedEligible
    .filter((x) => dedupeRows.some((d) => d.key.startsWith(`${x.botType}|${x.assetId}|${x.side}`)))
    .map((x) => x.score)
    .filter((x): x is number => x != null);

  const lines: string[] = [];
  lines.push("# V2 Admission Blockers Audit");
  lines.push("");
  lines.push(`- Generated: ${generatedAt}`);
  lines.push("- Mode: dry-run V2 tick (read-only)");
  lines.push(`- Scorer source: ${tick.scorePopulationSnapshot?.scorerSource ?? "shadow_ml"}`);
  lines.push("");
  lines.push("## A. Eligible set");
  lines.push(`- eligible outcomes (passed threshold + survived liquidity filters, per bot decision): ${eligibleOutcomes.length}`);
  lines.push(`- eligible unique candidates: ${uniqueEligible.size}`);
  if (tick.duplicateExposureSuppression) {
    lines.push(
      `- pre-admission suppressed already-open exposures: ${tick.duplicateExposureSuppression.totalSuppressed}`
    );
    lines.push(
      `- suppression by botType: ${JSON.stringify(tick.duplicateExposureSuppression.byBotType)}`
    );
    lines.push(`- suppression by band: ${JSON.stringify(tick.duplicateExposureSuppression.byBand)}`);
  }
  lines.push("");
  lines.push("## B. Admission outcomes (eligible only)");
  lines.push("| recommendationId | botType | marketId | side | score | outcome | reject reason |");
  lines.push("| --- | --- | --- | --- | ---: | --- | --- |");
  for (const e of eligibleOutcomes) {
    lines.push(
      `| ${e.recommendationId} | ${e.botType} | ${e.marketId} | ${e.side} | ${fmt(e.score)} | ${
        e.admitted ? "admitted" : "rejected"
      } | ${e.rejectReason ?? "-"} |`
    );
  }
  lines.push("");
  lines.push("## C. Reject reason breakdown (eligible set)");
  for (const [reason, count] of Object.entries(rejectBreakdown).sort((a, b) => b[1] - a[1])) {
    lines.push(`- ${reason}: ${count}`);
  }
  lines.push("");
  lines.push("## D. Dedupe deep dive");
  lines.push(`- dedupe-rejected outcomes: ${dedupeRejected.length}`);
  if (tick.dedupeCollisionBreakdown) {
    lines.push(
      `- collision split: already-open-suppressed=${tick.dedupeCollisionBreakdown.preSuppressedAlreadyOpen}, same-tick=${tick.dedupeCollisionBreakdown.sameTickCollision}, existing-db=${tick.dedupeCollisionBreakdown.existingDbCollision}, unique-constraint=${tick.dedupeCollisionBreakdown.uniqueConstraintCollision}, open-row=${tick.dedupeCollisionBreakdown.openRowCollision}, closed-row=${tick.dedupeCollisionBreakdown.closedRowCollision}, closed-row-bypassed=${tick.dedupeCollisionBreakdown.closedRowBypassed}`
    );
  }
  lines.push(`- dedupe collision groups (botType|assetId|side): ${dedupeRows.length}`);
  lines.push("| dedupe grouping key | collisions | preserved recommendation | preserved score | suppressed recommendations | suppressed scores | top-score preserved |");
  lines.push("| --- | ---: | --- | ---: | --- | --- | --- |");
  for (const d of dedupeRows) {
    lines.push(
      `| ${d.key} | ${d.count} | ${d.preserved} | ${fmt(d.preservedScore)} | ${d.suppressed || "-"} | ${d.suppressedScores || "-"} | ${
        d.topScorePreserved ? "yes" : "no"
      } |`
    );
  }
  lines.push("");
  lines.push("### D1. Dedupe-rejected candidates vs existing open positions");
  lines.push("| recommendationId | botType | side | score | existing open trades (same bot+asset+side) |");
  lines.push("| --- | --- | --- | ---: | ---: |");
  for (const r of dbCollisionRows) {
    lines.push(
      `| ${r.recommendationId} | ${r.botType} | ${r.side} | ${fmt(r.score)} | ${r.openTradeCollisions} |`
    );
  }
  const withDbCollision = dbCollisionRows.filter((r) => r.openTradeCollisions > 0).length;
  lines.push(`- dedupe rejects with existing open-trade collision: ${withDbCollision} / ${dbCollisionRows.length}`);
  lines.push("- Dedupe behavior indicates prevention of multiple entries for the same botType+assetId+side within the same tick/bucket.");
  lines.push("");
  lines.push("## E. Score vs admission");
  lines.push(`- admitted avg score (eligible set): ${fmt(avg(admittedScores))}`);
  lines.push(`- rejected avg score (eligible set): ${fmt(avg(rejectedScores))}`);
  lines.push(`- dedupe preserved avg score: ${fmt(avg(dedupePreservedScores))}`);
  lines.push(`- dedupe suppressed avg score: ${fmt(avg(dedupeSuppressedScores))}`);
  lines.push("");
  lines.push("## F. Blunt conclusion");
  let conclusion = "evidence insufficient";
  if (dedupeRejected.length > 0 && (rejectBreakdown["dedupe"] ?? 0) >= (rejectBreakdown["global_max_open_total"] ?? 0) && (rejectBreakdown["dedupe"] ?? 0) >= (rejectBreakdown["bot_max_open"] ?? 0)) {
    conclusion = "dedupe is blocking otherwise valid trades";
  } else if ((rejectBreakdown["global_max_open_total"] ?? 0) > (rejectBreakdown["dedupe"] ?? 0) || (rejectBreakdown["bot_max_open"] ?? 0) > (rejectBreakdown["dedupe"] ?? 0)) {
    conclusion = "budget/cap is the blocker";
  } else if (eligibleOutcomes.length === 0) {
    conclusion = "threshold is still indirectly blocking";
  } else if (Object.keys(rejectBreakdown).length > 1) {
    conclusion = "mixed causes";
  }
  lines.push(`- ${conclusion}`);

  const outDir = path.join(process.cwd(), "diagnostics");
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, "v2-admission-blockers-audit.md");
  await fs.writeFile(outPath, lines.join("\n"), "utf8");
  console.log(`Wrote ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

