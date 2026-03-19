/**
 * Decision snapshot pipeline debug report.
 * Inspects recent Recommendations and DecisionPolicySnapshot rows to find why paper candidates
 * see no decision snapshots.
 *
 * Writes:
 * - dump/decision-snapshot-pipeline-debug-report.json
 * - dump/decision-snapshot-pipeline-debug-report.md
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import { getFunderForDecisionRecompute } from "../lib/decision/recompute";

const LOOKBACK_DAYS = 30;
const MAX_SAMPLE = 30;

async function main(): Promise<void> {
  const dumpDir = path.join(process.cwd(), "dump");
  await fs.mkdir(dumpDir, { recursive: true });

  const funder = (await getFunderForDecisionRecompute()) ?? (await prisma.marketSignal.findFirst({ select: { funderAddress: true } }).then((r) => r?.funderAddress ?? ""))
    .toLowerCase()
    .trim();

  const from = new Date();
  from.setDate(from.getDate() - LOOKBACK_DAYS);

  const recommendations = await prisma.recommendation.findMany({
    where: { marketSignal: { funderAddress: funder }, createdAt: { gte: from } },
    select: { id: true, blockedReason: true, action: true, createdAt: true },
    orderBy: { createdAt: "desc" },
    take: 500,
  });

  const recIds = recommendations.map((r) => r.id);
  const snapshots =
    recIds.length > 0
      ? await prisma.decisionPolicySnapshot.findMany({
          where: { recommendationId: { in: recIds }, funderAddress: funder },
          orderBy: { createdAt: "desc" },
        })
      : [];

  const snapshotByRec = new Map<string, typeof snapshots[number][]>();
  for (const s of snapshots) {
    const list = snapshotByRec.get(s.recommendationId) ?? [];
    list.push(s);
    snapshotByRec.set(s.recommendationId, list);
  }

  const withSnapshot: string[] = [];
  const withoutSnapshot: string[] = [];
  const malformedSnapshots: Array<{ recommendationId: string; policyState: string; finalSuggestedSize: string }> = [];

  for (const r of recommendations) {
    const snaps = snapshotByRec.get(r.id) ?? [];
    if (snaps.length === 0) {
      withoutSnapshot.push(r.id);
      continue;
    }
    withSnapshot.push(r.id);
    for (const s of snaps) {
      if (!s.policyState || s.finalSuggestedSize == null || s.sizeMultiplier == null) {
        malformedSnapshots.push({
          recommendationId: s.recommendationId,
          policyState: s.policyState,
          finalSuggestedSize: s.finalSuggestedSize,
        });
      }
    }
  }

  const result = {
    generatedAt: new Date().toISOString(),
    lookbackDays: LOOKBACK_DAYS,
    funderAddress: funder,
    recentRecommendations: recommendations.length,
    recommendationsWithSnapshot: withSnapshot.length,
    recommendationsWithoutSnapshot: withoutSnapshot.length,
    pctWithSnapshot: recommendations.length > 0 ? (withSnapshot.length / recommendations.length) * 100 : 0,
    pctWithoutSnapshot: recommendations.length > 0 ? (withoutSnapshot.length / recommendations.length) * 100 : 0,
    snapshotsTotal: snapshots.length,
    malformedSnapshots: malformedSnapshots.slice(0, MAX_SAMPLE),
    sampleRecommendationsMissingSnapshot: recommendations
      .filter((r) => withoutSnapshot.includes(r.id))
      .slice(0, MAX_SAMPLE)
      .map((r) => ({ id: r.id, blockedReason: r.blockedReason, action: r.action, createdAt: r.createdAt })),
    sampleRecommendationsWithSnapshot: recommendations
      .filter((r) => withSnapshot.includes(r.id))
      .slice(0, MAX_SAMPLE)
      .map((r) => ({
        id: r.id,
        blockedReason: r.blockedReason,
        action: r.action,
        createdAt: r.createdAt,
        snapshots: (snapshotByRec.get(r.id) ?? []).map((s) => ({
          policyState: s.policyState,
          blendedScore: s.blendedScore,
          finalSuggestedSize: s.finalSuggestedSize,
          createdAt: s.createdAt,
        })),
      })),
  };

  const jsonPath = path.join(dumpDir, "decision-snapshot-pipeline-debug-report.json");
  await fs.writeFile(jsonPath, JSON.stringify(result, null, 2), "utf8");
  console.log("Wrote", jsonPath);

  const lines: string[] = [];
  lines.push("# Decision snapshot pipeline debug report");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|--------|-------|");
  lines.push("| Funder | " + funder + " |");
  lines.push("| Lookback days | " + LOOKBACK_DAYS + " |");
  lines.push("| Recent recommendations | " + result.recentRecommendations + " |");
  lines.push("| With snapshot | " + result.recommendationsWithSnapshot + " |");
  lines.push("| Without snapshot | " + result.recommendationsWithoutSnapshot + " |");
  lines.push("| % with snapshot | " + result.pctWithSnapshot.toFixed(1) + "% |");
  lines.push("| % without snapshot | " + result.pctWithoutSnapshot.toFixed(1) + "% |");
  lines.push("| Total snapshots | " + result.snapshotsTotal + " |");
  lines.push("");
  lines.push("## Sample recommendations missing snapshots");
  lines.push("");
  if (result.sampleRecommendationsMissingSnapshot.length === 0) {
    lines.push("None.");
  } else {
    lines.push("| id | blockedReason | action | createdAt |");
    lines.push("|----|---------------|--------|-----------|");
    for (const r of result.sampleRecommendationsMissingSnapshot) {
      lines.push(
        "| " +
          r.id.slice(0, 12) +
          "… | " +
          (r.blockedReason ?? "—") +
          " | " +
          r.action +
          " | " +
          r.createdAt.toISOString() +
          " |"
      );
    }
  }
  lines.push("");
  lines.push("## Sample recommendations with snapshots");
  lines.push("");
  if (result.sampleRecommendationsWithSnapshot.length === 0) {
    lines.push("None.");
  } else {
    lines.push("| id | policyState | finalSuggestedSize | createdAt |");
    lines.push("|----|-------------|--------------------|-----------|");
    for (const r of result.sampleRecommendationsWithSnapshot) {
      const s = r.snapshots[0];
      lines.push(
        "| " +
          r.id.slice(0, 12) +
          "… | " +
          (s?.policyState ?? "—") +
          " | " +
          (s?.finalSuggestedSize ?? "—") +
          " | " +
          (s?.createdAt?.toISOString() ?? "—") +
          " |"
      );
    }
  }
  lines.push("");
  lines.push("## Malformed snapshots (if any)");
  lines.push("");
  if (result.malformedSnapshots.length === 0) {
    lines.push("None.");
  } else {
    lines.push("| recommendationId | policyState | finalSuggestedSize |");
    lines.push("|------------------|-------------|--------------------|");
    for (const s of result.malformedSnapshots) {
      lines.push("| " + s.recommendationId.slice(0, 12) + "… | " + s.policyState + " | " + s.finalSuggestedSize + " |");
    }
  }

  const mdPath = path.join(dumpDir, "decision-snapshot-pipeline-debug-report.md");
  await fs.writeFile(mdPath, lines.join("\n"), "utf8");
  console.log("Wrote", mdPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

