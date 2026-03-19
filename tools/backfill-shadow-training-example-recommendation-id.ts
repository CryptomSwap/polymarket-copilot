/**
 * Backfill MlShadowTrainingExample.recommendationId where missing.
 * 1) From ShadowCandidate: if example.shadowCandidateId exists in ShadowCandidate and has recommendationId, use it (exact).
 * 2) From PaperTrade: same assetId + side, entryTime within ±TIME_WINDOW_HOURS of example.createdAt; assign only when exactly one match.
 * Dry-run by default; --apply to write. Never overwrite non-null recommendationId.
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";

const TIME_WINDOW_HOURS = 2;
const LOOKBACK_DAYS = 90;

function parseRecommendationId(metadataJson: string | null): string | null {
  if (!metadataJson) return null;
  try {
    const o = JSON.parse(metadataJson) as Record<string, unknown>;
    const id = o.recommendationId;
    return typeof id === "string" ? id.trim() || null : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const dryRun = !apply;

  const examples = await prisma.mlShadowTrainingExample.findMany({
    where: { recommendationId: null },
    select: { id: true, shadowCandidateId: true, assetId: true, side: true, createdAt: true },
  });

  const totalMissing = examples.length;
  const fromShadowCandidate: Array<{ id: string; recommendationId: string }> = [];
  const fromPaperTrade: Array<{ id: string; recommendationId: string }> = [];
  const ambiguous: string[] = [];
  const unmatched: string[] = [];

  const candidateIds = examples.map((e) => e.shadowCandidateId).filter((id) => !id.startsWith("offline-"));
  const shadowCandidates =
    candidateIds.length > 0
      ? await prisma.shadowCandidate.findMany({
          where: { id: { in: candidateIds } },
          select: { id: true, recommendationId: true },
        })
      : [];
  const recIdByCandidateId = new Map<string, string>();
  for (const sc of shadowCandidates) {
    const r = sc.recommendationId?.trim();
    if (r) recIdByCandidateId.set(sc.id, r);
  }

  const lookbackFrom = new Date();
  lookbackFrom.setDate(lookbackFrom.getDate() - LOOKBACK_DAYS);
  const allTrades = await prisma.paperTrade.findMany({
    where: { entryTime: { gte: lookbackFrom } },
    select: { id: true, assetId: true, side: true, entryTime: true, metadataJson: true },
  });
  const tradesWithRecId = allTrades
    .map((t) => ({ ...t, recommendationId: parseRecommendationId(t.metadataJson) }))
    .filter((t) => t.recommendationId != null);

  for (const ex of examples) {
    if (ex.shadowCandidateId.startsWith("offline-")) {
      // Synthetic row; try PaperTrade match below
    } else {
      const recId = recIdByCandidateId.get(ex.shadowCandidateId);
      if (recId) {
        fromShadowCandidate.push({ id: ex.id, recommendationId: recId });
        continue;
      }
    }

    // PaperTrade match: same assetId, side, entryTime within ±TIME_WINDOW_HOURS of example.createdAt
    const windowMs = TIME_WINDOW_HOURS * 60 * 60 * 1000;
    const lo = ex.createdAt.getTime() - windowMs;
    const hi = ex.createdAt.getTime() + windowMs;
    const matching = tradesWithRecId.filter(
      (t) =>
        t.assetId === ex.assetId &&
        t.side === ex.side &&
        t.entryTime.getTime() >= lo &&
        t.entryTime.getTime() <= hi
    );
    if (matching.length === 1) {
      fromPaperTrade.push({ id: ex.id, recommendationId: matching[0].recommendationId! });
    } else if (matching.length > 1) {
      ambiguous.push(ex.id);
    } else {
      unmatched.push(ex.id);
    }
  }

  const toUpdate = [...fromShadowCandidate, ...fromPaperTrade];
  if (!dryRun && toUpdate.length > 0) {
    for (const { id, recommendationId } of toUpdate) {
      await prisma.mlShadowTrainingExample.update({
        where: { id },
        data: { recommendationId },
      });
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    dryRun,
    applied: !dryRun && toUpdate.length > 0,
    totalMissingRecommendationId: totalMissing,
    fromShadowCandidate: fromShadowCandidate.length,
    fromPaperTrade: fromPaperTrade.length,
    exactUniqueMatches: toUpdate.length,
    ambiguousSkipped: ambiguous.length,
    unmatched: unmatched.length,
    sampleFromShadowCandidate: fromShadowCandidate.slice(0, 5),
    sampleFromPaperTrade: fromPaperTrade.slice(0, 5),
    sampleAmbiguous: ambiguous.slice(0, 5),
    sampleUnmatched: unmatched.slice(0, 5),
    caveats: [
      "Only rows with recommendationId = null were considered. Non-null never overwritten.",
      "ShadowCandidate match: exact by shadowCandidateId when ShadowCandidate.recommendationId is set.",
      "PaperTrade match: same assetId + side, entryTime within ±" + TIME_WINDOW_HOURS + "h of example.createdAt; assign only when exactly one such trade.",
    ],
  };

  const dumpDir = path.join(process.cwd(), "dump");
  await fs.mkdir(dumpDir, { recursive: true });
  const jsonPath = path.join(dumpDir, "shadow-training-example-recommendation-id-backfill.json");
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");
  console.log("Wrote", jsonPath);

  const md = [
    "# Shadow training example recommendationId backfill",
    "",
    "| Metric | Value |",
    "|--------|-------|",
    "| Dry run | " + dryRun + " |",
    "| Applied | " + report.applied + " |",
    "| Total missing recommendationId | " + totalMissing + " |",
    "| Matched from ShadowCandidate | " + fromShadowCandidate.length + " |",
    "| Matched from PaperTrade (unique) | " + fromPaperTrade.length + " |",
    "| Ambiguous (skipped) | " + ambiguous.length + " |",
    "| Unmatched | " + unmatched.length + " |",
    "",
    "## Caveats",
    ...report.caveats.map((c) => "- " + c),
    "",
    "Run with `--apply` to write. Default is dry-run.",
  ].join("\n");
  const mdPath = path.join(dumpDir, "shadow-training-example-recommendation-id-backfill.md");
  await fs.writeFile(mdPath, md, "utf8");
  console.log("Wrote", mdPath);

  console.log(
    "Total missing: " +
      totalMissing +
      " | From ShadowCandidate: " +
      fromShadowCandidate.length +
      " | From PaperTrade: " +
      fromPaperTrade.length +
      " | Ambiguous: " +
      ambiguous.length +
      " | Unmatched: " +
      unmatched.length +
      (dryRun ? " (dry-run; use --apply to write)" : " (applied)")
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
