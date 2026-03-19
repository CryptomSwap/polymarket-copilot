/**
 * Operational refresh: after BehaviorFlag.sourceScope / automation penalty changes, stale
 * MarketSignal.behaviorPenalty and DecisionPolicySnapshot rows can still block paper trading.
 *
 * Order (matches scheduled-jobs / streaming-sync):
 * 1. recomputeRecommendations — generateSignals (fresh behaviorPenalty) → new MarketSignal + Recommendation rows
 * 2. recomputeDecisions — DecisionPolicySnapshot from staged engine
 * 3. Paper candidate loader diagnostics
 *
 * Default: dry-run (no writes). Use --apply to execute.
 * Optional: --funder 0x... (else getFunderForDecisionRecompute)
 *
 * npm run refresh:paper-policy-pipeline
 * npm run refresh:paper-policy-pipeline -- --apply
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import { getFunderForDecisionRecompute, recomputeDecisions } from "../lib/decision/recompute";
import { recomputeRecommendations } from "../lib/polymarket/recommendations-recompute";
import { getAutomationBehaviorPenaltyForFunder } from "../lib/polymarket/signals";
import { getPaperTradingCandidatesWithDiagnostics } from "../lib/paper-trading/candidates";

const BEHAVIOR_BLOCKED = "Behavior flags suggest pausing new trades.";

function parseArgs(): { apply: boolean; funderArg: string | null } {
  const apply = process.argv.includes("--apply");
  let funderArg: string | null = null;
  const i = process.argv.indexOf("--funder");
  if (i >= 0 && process.argv[i + 1]) funderArg = process.argv[i + 1].trim().toLowerCase();
  return { apply, funderArg };
}

async function samplePersistedSignalBehaviorPenalty(funder: string): Promise<number | null> {
  const s = await prisma.marketSignal.findFirst({
    where: { funderAddress: funder },
    select: { behaviorPenalty: true },
    orderBy: { updatedAt: "desc" },
  });
  if (s?.behaviorPenalty == null || s.behaviorPenalty === "") return null;
  const n = parseFloat(String(s.behaviorPenalty));
  return Number.isFinite(n) ? n : null;
}

async function countBehaviorBlockedRecommendations(funder: string): Promise<number> {
  return prisma.recommendation.count({
    where: {
      marketSignal: { funderAddress: funder },
      blockedReason: BEHAVIOR_BLOCKED,
    },
  });
}

async function countPortfolioBlockedSnapshots(funder: string): Promise<number> {
  const snaps = await prisma.decisionPolicySnapshot.findMany({
    where: { funderAddress: funder, policyState: "BLOCK" },
    select: { reasoningJson: true },
    take: 500,
    orderBy: { updatedAt: "desc" },
  });
  let n = 0;
  for (const row of snaps) {
    try {
      const j = JSON.parse(row.reasoningJson) as {
        portfolioFitReasons?: string[];
        blockReason?: string;
      };
      const pr = j.portfolioFitReasons ?? [];
      const hasConc =
        pr.some(
          (r) =>
            /concentration|theme exposure|Portfolio overconcentrated|High concentration/i.test(r)
        ) || /concentration|theme exposure|portfolio/i.test(String(j.blockReason ?? ""));
      if (hasConc) n++;
    } catch {
      /* skip */
    }
  }
  return n;
}

function classifyDiagnosticsReasons(loadDiagnostics: {
  sampleFilteredByPolicy?: { reason?: string | null }[];
}): { behaviorSamples: number; portfolioSamples: number } {
  const samples = loadDiagnostics.sampleFilteredByPolicy ?? [];
  let behaviorSamples = 0;
  let portfolioSamples = 0;
  for (const row of samples) {
    const r = row.reason ?? "";
    if (r.includes(BEHAVIOR_BLOCKED)) behaviorSamples++;
    if (
      /High concentration|Portfolio overconcentrated|theme exposure|Portfolio fit/i.test(r) &&
      !r.includes(BEHAVIOR_BLOCKED)
    )
      portfolioSamples++;
  }
  return { behaviorSamples, portfolioSamples };
}

async function main(): Promise<void> {
  const { apply, funderArg } = parseArgs();
  const dumpDir = path.join(process.cwd(), "dump");
  await fs.mkdir(dumpDir, { recursive: true });

  const funder =
    funderArg ||
    process.env.REFRESH_PAPER_POLICY_FUNDER?.trim().toLowerCase() ||
    (await getFunderForDecisionRecompute());

  if (!funder) {
    const err = {
      generatedAt: new Date().toISOString(),
      error: "No funder: pass --funder 0x... or set REFRESH_PAPER_POLICY_FUNDER or ensure snapshots/recommendations exist.",
    };
    await fs.writeFile(
      path.join(dumpDir, "refresh-paper-policy-pipeline.json"),
      JSON.stringify(err, null, 2),
      "utf8"
    );
    console.error(err.error);
    process.exit(1);
    return;
  }

  const automationPenaltyLive = await getAutomationBehaviorPenaltyForFunder(funder);
  const persistedPenaltyBefore = await samplePersistedSignalBehaviorPenalty(funder);
  const recCountBefore = await prisma.recommendation.count({
    where: { marketSignal: { funderAddress: funder } },
  });
  const behaviorBlockedBefore = await countBehaviorBlockedRecommendations(funder);
  const portfolioBlockSnapshotsBefore = await countPortfolioBlockedSnapshots(funder);

  const { loadDiagnostics: diagBefore } = await getPaperTradingCandidatesWithDiagnostics(funder);
  const classifyBefore = classifyDiagnosticsReasons(diagBefore);

  let recomputeRecResult: Awaited<ReturnType<typeof recomputeRecommendations>> | null = null;
  let recomputeDecResult: Awaited<ReturnType<typeof recomputeDecisions>> | null = null;

  if (apply) {
    recomputeRecResult = await recomputeRecommendations(funder, { captureSnapshotsFirst: false });
    if (recomputeRecResult.errors.length > 0) {
      console.warn("recomputeRecommendations errors:", recomputeRecResult.errors);
    }
    recomputeDecResult = await recomputeDecisions(funder);
    if (recomputeDecResult.errors.length > 0) {
      console.warn("recomputeDecisions errors:", recomputeDecResult.errors);
    }
  }

  const persistedPenaltyAfter = apply
    ? await samplePersistedSignalBehaviorPenalty(funder)
    : null;
  const automationPenaltyAfter = apply ? await getAutomationBehaviorPenaltyForFunder(funder) : automationPenaltyLive;

  const { loadDiagnostics: diagAfter } = apply
    ? await getPaperTradingCandidatesWithDiagnostics(funder)
    : diagBefore;
  const classifyAfter = classifyDiagnosticsReasons(diagAfter);

  const behaviorBlockedAfter = apply
    ? await countBehaviorBlockedRecommendations(funder)
    : behaviorBlockedBefore;
  const portfolioBlockSnapshotsAfter = apply
    ? await countPortfolioBlockedSnapshots(funder)
    : portfolioBlockSnapshotsBefore;

  const behaviorBlockDisappeared =
    apply && behaviorBlockedBefore > 0 && behaviorBlockedAfter === 0;
  const behaviorBlockReduced = apply && behaviorBlockedAfter < behaviorBlockedBefore;

  const report = {
    generatedAt: new Date().toISOString(),
    mode: apply ? "apply" : "dry-run",
    funderAddress: funder,
    behaviorPenalty: {
      automationScopedLive_beforeRefresh: automationPenaltyLive,
      persistedOnMarketSignal_beforeRefresh: persistedPenaltyBefore,
      note:
        "persisted value should match live after refresh; mismatch before refresh indicates stale signals.",
      afterRefresh_automationScopedLive: automationPenaltyAfter,
      afterRefresh_persistedOnMarketSignal: persistedPenaltyAfter,
    },
    refreshSteps: apply
      ? {
          recomputeRecommendations: {
            signalsWritten: recomputeRecResult?.signalsWritten ?? 0,
            recommendationsWritten: recomputeRecResult?.recommendationsWritten ?? 0,
            errors: recomputeRecResult?.errors ?? [],
          },
          recomputeDecisions: {
            snapshotsUpserted: recomputeDecResult?.snapshotsUpserted ?? 0,
            profilesCreated: recomputeDecResult?.profilesCreated ?? 0,
            profilesUpdated: recomputeDecResult?.profilesUpdated ?? 0,
            errors: recomputeDecResult?.errors ?? [],
          },
        }
      : {
          wouldRun: [
            "recomputeRecommendations(funder, { captureSnapshotsFirst: false })",
            "recomputeDecisions(funder)",
          ],
        },
    recommendations: {
      countBefore: recCountBefore,
      countAfterApply: apply
        ? await prisma.recommendation.count({
            where: { marketSignal: { funderAddress: funder } },
          })
        : null,
      behaviorBlockedCount_before: behaviorBlockedBefore,
      behaviorBlockedCount_after: behaviorBlockedAfter,
    },
    snapshots: {
      portfolioStyleBlockCount_estimate_before: portfolioBlockSnapshotsBefore,
      portfolioStyleBlockCount_estimate_after: portfolioBlockSnapshotsAfter,
    },
    paperLoaderAfterRefresh: {
      recommendationsFound: diagAfter.recommendationsFound,
      policyStateCounts: diagAfter.policyStateCounts ?? {},
      afterPolicyFilter: diagAfter.afterPolicyFilter,
      zeroCandidatesReason: diagAfter.zeroCandidatesReason ?? null,
      sampleBehaviorVsPortfolio: {
        before: classifyBefore,
        after: classifyAfter,
      },
    },
    interpretation: {
      behaviorBasedBlockShouldClear:
        apply &&
        automationPenaltyLive < 0.25 &&
        behaviorBlockedAfter === 0 &&
        classifyAfter.behaviorSamples === 0,
      behaviorBlockDisappeared,
      behaviorBlockReduced,
      remainingBlocksLikelyPortfolioOrOther:
        "If afterPolicyFilter is still 0, check zeroCandidatesReason and portfolioStyleBlockCount / sample reasons (concentration, portfolio penalty, market quality).",
    },
  };

  const jsonPath = path.join(dumpDir, "refresh-paper-policy-pipeline.json");
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");
  console.log("Wrote", jsonPath);

  const md: string[] = [
    "# Refresh paper policy pipeline",
    "",
    "| Field | Value |",
    "|-------|-------|",
    "| Mode | " + report.mode + " |",
    "| Funder | `" + funder + "` |",
    "| Automation behaviorPenalty (live, before) | " + automationPenaltyLive + " |",
    "| Persisted MarketSignal.behaviorPenalty (before) | " + String(persistedPenaltyBefore) + " |",
  ];
  if (apply) {
    md.push("| Signals written | " + (recomputeRecResult?.signalsWritten ?? 0) + " |");
    md.push("| Recommendations written | " + (recomputeRecResult?.recommendationsWritten ?? 0) + " |");
    md.push("| Decision snapshots upserted | " + (recomputeDecResult?.snapshotsUpserted ?? 0) + " |");
    md.push("| Persisted behaviorPenalty after | " + String(persistedPenaltyAfter) + " |");
    md.push("| Recs with behavior block (after) | " + behaviorBlockedAfter + " |");
  } else {
    md.push("| (dry-run: no DB refresh) | |");
  }
  md.push("| afterPolicyFilter | " + diagAfter.afterPolicyFilter + " |");
  md.push("| zeroCandidatesReason | " + (diagAfter.zeroCandidatesReason || "—") + " |");
  md.push("| Behavior samples in policy filter (after) | " + classifyAfter.behaviorSamples + " |");
  md.push("| Portfolio-style samples (after) | " + classifyAfter.portfolioSamples + " |");
  md.push("");
  md.push("## policyStateCounts (after)");
  md.push("");
  md.push("```json");
  md.push(JSON.stringify(diagAfter.policyStateCounts ?? {}, null, 2));
  md.push("```");
  md.push("");
  if (!apply) {
    md.push("Run with `--apply` to execute recomputeRecommendations → recomputeDecisions.");
  }

  await fs.writeFile(path.join(dumpDir, "refresh-paper-policy-pipeline.md"), md.join("\n"), "utf8");
  console.log("Wrote dump/refresh-paper-policy-pipeline.md");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
