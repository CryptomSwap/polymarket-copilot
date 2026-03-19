import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import { getFunderForDecisionRecompute } from "../lib/decision/recompute";
import { CORE_ALLOWED_POLICY_STATES } from "../lib/paper-trading/bot-profiles";

const LOOKBACK_HOURS = 24;
const SAMPLE_LIMIT = 12;

type MismatchReason =
  | "no_snapshot_produced"
  | "wrong_funder"
  | "wrong_join_key"
  | "outside_recency_window"
  | "filtered_by_policy_state"
  | "cleaned_up_missing";

function keyOf(marketId: string, outcome: string): string {
  return `${marketId}::${outcome}`;
}

async function main(): Promise<void> {
  const dumpDir = path.join(process.cwd(), "dump");
  await fs.mkdir(dumpDir, { recursive: true });

  const funder = (await getFunderForDecisionRecompute())?.trim().toLowerCase() ?? "";
  if (!funder) throw new Error("No funder resolved for decision snapshot gap report.");

  const now = Date.now();
  const recentFrom = new Date(now - LOOKBACK_HOURS * 60 * 60 * 1000);
  const historicalFrom = new Date(now - 30 * 24 * 60 * 60 * 1000);

  const recentRecommendations = await prisma.recommendation.findMany({
    where: {
      marketSignal: { funderAddress: funder },
      createdAt: { gte: recentFrom },
    },
    include: {
      marketSignal: {
        select: { marketId: true, outcome: true, side: true, marketPrice: true },
      },
    },
    orderBy: { createdAt: "desc" },
    take: 800,
  });

  const recIds = recentRecommendations.map((r) => r.id);
  const exactSnapshots = recIds.length
    ? await prisma.decisionPolicySnapshot.findMany({
        where: {
          recommendationId: { in: recIds },
          funderAddress: funder,
        },
      })
    : [];
  const exactSnapshotByRec = new Map<string, (typeof exactSnapshots)[number]>();
  for (const s of exactSnapshots) exactSnapshotByRec.set(s.recommendationId, s);

  const historicalSnapshotsForFunder = await prisma.decisionPolicySnapshot.findMany({
    where: { funderAddress: funder, createdAt: { gte: historicalFrom } },
    include: {
      recommendation: {
        include: { marketSignal: { select: { marketId: true, outcome: true } } },
      },
    },
    orderBy: { createdAt: "desc" },
    take: 4000,
  });

  const marketOutcomeSeenForFunder = new Set<string>();
  for (const s of historicalSnapshotsForFunder) {
    const m = s.recommendation?.marketSignal?.marketId;
    const o = s.recommendation?.marketSignal?.outcome;
    if (m && o) marketOutcomeSeenForFunder.add(keyOf(m, o));
  }

  const nearbyOtherFunderSnapshots = await prisma.decisionPolicySnapshot.findMany({
    where: { createdAt: { gte: historicalFrom }, funderAddress: { not: funder } },
    include: {
      recommendation: {
        include: { marketSignal: { select: { marketId: true, outcome: true } } },
      },
    },
    orderBy: { createdAt: "desc" },
    take: 5000,
  });
  const marketOutcomeToOtherFunders = new Map<string, Set<string>>();
  for (const s of nearbyOtherFunderSnapshots) {
    const m = s.recommendation?.marketSignal?.marketId;
    const o = s.recommendation?.marketSignal?.outcome;
    if (!m || !o) continue;
    const k = keyOf(m, o);
    const set = marketOutcomeToOtherFunders.get(k) ?? new Set<string>();
    set.add(s.funderAddress);
    marketOutcomeToOtherFunders.set(k, set);
  }

  const reasonsCount: Record<MismatchReason, number> = {
    no_snapshot_produced: 0,
    wrong_funder: 0,
    wrong_join_key: 0,
    outside_recency_window: 0,
    filtered_by_policy_state: 0,
    cleaned_up_missing: 0,
  };
  const reasonSamples: Record<MismatchReason, string[]> = {
    no_snapshot_produced: [],
    wrong_funder: [],
    wrong_join_key: [],
    outside_recency_window: [],
    filtered_by_policy_state: [],
    cleaned_up_missing: [],
  };

  let joined = 0;
  let policyFiltered = 0;

  for (const r of recentRecommendations) {
    const joinedSnapshot = exactSnapshotByRec.get(r.id);
    if (joinedSnapshot) {
      joined++;
      if (!CORE_ALLOWED_POLICY_STATES.includes(joinedSnapshot.policyState)) {
        policyFiltered++;
        reasonsCount.filtered_by_policy_state++;
        if (reasonSamples.filtered_by_policy_state.length < SAMPLE_LIMIT) {
          reasonSamples.filtered_by_policy_state.push(r.id);
        }
      }
      continue;
    }

    const moKey = keyOf(r.marketSignal.marketId, r.marketSignal.outcome);
    const seenForFunder = marketOutcomeSeenForFunder.has(moKey);
    const seenOtherFunders = marketOutcomeToOtherFunders.get(moKey);

    if (seenOtherFunders && seenOtherFunders.size > 0) {
      reasonsCount.wrong_funder++;
      if (reasonSamples.wrong_funder.length < SAMPLE_LIMIT) reasonSamples.wrong_funder.push(r.id);
      continue;
    }
    if (seenForFunder) {
      reasonsCount.wrong_join_key++;
      if (reasonSamples.wrong_join_key.length < SAMPLE_LIMIT) reasonSamples.wrong_join_key.push(r.id);
      continue;
    }

    const hadOldSignals = await prisma.marketSignal.count({
      where: {
        funderAddress: funder,
        marketId: r.marketSignal.marketId,
        outcome: r.marketSignal.outcome,
        createdAt: { lt: recentFrom, gte: historicalFrom },
      },
    });
    if (hadOldSignals > 0) {
      reasonsCount.cleaned_up_missing++;
      if (reasonSamples.cleaned_up_missing.length < SAMPLE_LIMIT) reasonSamples.cleaned_up_missing.push(r.id);
    } else {
      reasonsCount.no_snapshot_produced++;
      if (reasonSamples.no_snapshot_produced.length < SAMPLE_LIMIT) reasonSamples.no_snapshot_produced.push(r.id);
    }
  }

  // Recency window gap: same funder has snapshots historically but none in window.
  if (historicalSnapshotsForFunder.length > 0) {
    const recentSnapshotCountForFunder = historicalSnapshotsForFunder.filter(
      (s) => s.createdAt.getTime() >= recentFrom.getTime()
    ).length;
    if (recentSnapshotCountForFunder === 0 && recentRecommendations.length > 0) {
      reasonsCount.outside_recency_window = recentRecommendations.length;
      reasonSamples.outside_recency_window = recentRecommendations
        .slice(0, SAMPLE_LIMIT)
        .map((r) => r.id);
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    funderAddress: funder,
    lookbackHours: LOOKBACK_HOURS,
    recentRecommendationsCount: recentRecommendations.length,
    recentSnapshotsCount: exactSnapshots.length,
    joinCoveragePct:
      recentRecommendations.length > 0
        ? (joined / recentRecommendations.length) * 100
        : 0,
    policyFilteredAfterJoinCount: policyFiltered,
    mismatchReasons: reasonsCount,
    mismatchReasonSamples: reasonSamples,
    sampleRecommendationJoinKeys: recentRecommendations.slice(0, SAMPLE_LIMIT).map((r) => ({
      recommendationId: r.id,
      funderAddress: funder,
      marketId: r.marketSignal.marketId,
      outcome: r.marketSignal.outcome,
      side: r.marketSignal.side,
      marketPrice: r.marketSignal.marketPrice,
      createdAt: r.createdAt.toISOString(),
      exactSnapshotFound: exactSnapshotByRec.has(r.id),
    })),
    sampleNearbySnapshotsOtherFunders: nearbyOtherFunderSnapshots.slice(0, SAMPLE_LIMIT).map((s) => ({
      snapshotId: s.id,
      recommendationId: s.recommendationId,
      funderAddress: s.funderAddress,
      policyState: s.policyState,
      createdAt: s.createdAt.toISOString(),
      marketId: s.recommendation?.marketSignal?.marketId ?? null,
      outcome: s.recommendation?.marketSignal?.outcome ?? null,
    })),
  };

  const jsonPath = path.join(dumpDir, "decision-snapshot-gap-report.json");
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");

  const md: string[] = [];
  md.push("# Decision snapshot gap report");
  md.push("");
  md.push("| Metric | Value |");
  md.push("|--------|-------|");
  md.push(`| Funder | \`${report.funderAddress}\` |`);
  md.push(`| Recent recommendations | ${report.recentRecommendationsCount} |`);
  md.push(`| Recent snapshots (exact join) | ${report.recentSnapshotsCount} |`);
  md.push(`| Join coverage | ${report.joinCoveragePct.toFixed(2)}% |`);
  md.push(`| Policy-filtered after join | ${report.policyFilteredAfterJoinCount} |`);
  md.push("");
  md.push("## Mismatch reasons");
  md.push("");
  for (const [reason, count] of Object.entries(report.mismatchReasons)) {
    md.push(`- ${reason}: ${count}`);
  }
  md.push("");
  md.push("## Sample recommendation join keys");
  md.push("");
  md.push("| recommendationId | marketId | outcome | exactSnapshotFound |");
  md.push("|------------------|----------|---------|--------------------|");
  for (const s of report.sampleRecommendationJoinKeys) {
    md.push(`| ${s.recommendationId} | ${s.marketId} | ${s.outcome} | ${s.exactSnapshotFound} |`);
  }
  md.push("");
  md.push("## Sample nearby snapshots (other funders)");
  md.push("");
  if (report.sampleNearbySnapshotsOtherFunders.length === 0) {
    md.push("None.");
  } else {
    md.push("| snapshotId | funderAddress | policyState | marketId | outcome |");
    md.push("|------------|---------------|-------------|----------|---------|");
    for (const s of report.sampleNearbySnapshotsOtherFunders) {
      md.push(
        `| ${s.snapshotId} | ${s.funderAddress} | ${s.policyState} | ${s.marketId ?? "—"} | ${s.outcome ?? "—"} |`
      );
    }
  }

  const mdPath = path.join(dumpDir, "decision-snapshot-gap-report.md");
  await fs.writeFile(mdPath, md.join("\n"), "utf8");
  console.log(`Wrote ${jsonPath}`);
  console.log(`Wrote ${mdPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

