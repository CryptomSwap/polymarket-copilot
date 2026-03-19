/**
 * Policy refresh automation: queue, stale self-heal reconcile, worker job policy_refresh_pending.
 *
 * Writes:
 * - dump/policy-refresh-automation-report.json
 * - dump/policy-refresh-automation-report.md
 *
 * npm run dump:policy-refresh-automation-report
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import { getFunderForDecisionRecompute } from "../lib/decision/recompute";
import {
  analyzeFunderPolicyStaleState,
  discoverFundersForStalePolicyScan,
} from "../lib/policy-refresh-queue";
import { getPaperTradingCandidatesWithDiagnostics } from "../lib/paper-trading/candidates";
import { JOB_NAMES, JOB_INTERVALS_MS } from "../lib/ops/scheduled-jobs";

async function main(): Promise<void> {
  const dumpDir = path.join(process.cwd(), "dump");
  await fs.mkdir(dumpDir, { recursive: true });

  const jobWired = (JOB_NAMES as readonly string[]).includes("policy_refresh_pending");
  const intervalMs = JOB_INTERVALS_MS.policy_refresh_pending;

  const queueRows = await prisma.funderPolicyRefreshState.findMany({
    orderBy: { updatedAt: "desc" },
    take: 50,
  });

  const pending = queueRows.filter((r) => r.dirtyAt != null);
  const scanFunders = await discoverFundersForStalePolicyScan();

  const staleAnalyses: Awaited<ReturnType<typeof analyzeFunderPolicyStaleState>>[] = [];
  for (const f of scanFunders.slice(0, 25)) {
    staleAnalyses.push(await analyzeFunderPolicyStaleState(f));
  }
  const staleDetectedList = staleAnalyses.filter((a) => a.stale);

  const funder =
    pending[0]?.funderAddress ??
    staleDetectedList[0]?.funderAddress ??
    queueRows[0]?.funderAddress ??
    (await getFunderForDecisionRecompute()) ??
    "";

  const primaryAnalysis = funder ? await analyzeFunderPolicyStaleState(funder) : null;

  const queueRowForPrimary = funder
    ? queueRows.find((r) => r.funderAddress === funder) ??
      (await prisma.funderPolicyRefreshState.findUnique({ where: { funderAddress: funder } }))
    : null;

  const { loadDiagnostics } = funder
    ? await getPaperTradingCandidatesWithDiagnostics(funder)
    : { loadDiagnostics: null };

  const recentStaleEnqueues = queueRows.filter(
    (r) =>
      r.lastStaleEnqueueAt &&
      Date.now() - r.lastStaleEnqueueAt.getTime() < 24 * 60 * 60 * 1000
  );

  const report = {
    generatedAt: new Date().toISOString(),
    automation: {
      queueModel: "FunderPolicyRefreshState",
      workerJobName: "policy_refresh_pending",
      jobFlow:
        "Each tick: reconcileStalePolicyFunders() (auto-enqueue stale) → processPendingPolicyRefreshes()",
      jobRegisteredInScheduledJobs: jobWired,
      intervalMs,
      intervalHuman: `${Math.round(intervalMs / 1000)}s`,
      triggers: [
        "Portfolio recompute after BehaviorFlag writes → markFunderPolicyRefreshNeeded",
        "backfill-behavior-flag-sources --apply → mark per funder",
        "Stale reconcile: penalty mismatch OR behavior-block copy with live penalty < 0.25",
      ],
    },
    staleSelfHeal: {
      scanFundersCount: scanFunders.length,
      staleFundersDetected: staleDetectedList.map((a) => ({
        funderAddress: a.funderAddress,
        reasons: a.reasons,
        livePenalty: a.livePenalty,
        persistedPenalty: a.persistedPenalty,
        behaviorBlockedRecCount: a.behaviorBlockedRecCount,
      })),
      staleDetectedCount: staleDetectedList.length,
      note: "Worker auto-enqueues these (up to 8/tick) unless already dirty, in-flight, or post-success cooldown.",
    },
    queue: {
      rowCountReturned: queueRows.length,
      pendingRefreshCount: pending.length,
      pendingFunders: pending.map((r) => ({
        funderAddress: r.funderAddress,
        dirtyAt: r.dirtyAt?.toISOString() ?? null,
        lastStaleEnqueueReason: r.lastStaleEnqueueReason ?? null,
        lastStaleEnqueueAt: r.lastStaleEnqueueAt?.toISOString() ?? null,
        lastRefreshStartedAt: r.lastRefreshStartedAt?.toISOString() ?? null,
        lastRefreshSuccessAt: r.lastRefreshSuccessAt?.toISOString() ?? null,
        lastRefreshError: r.lastRefreshError ? r.lastRefreshError.slice(0, 200) : null,
      })),
      recentStaleAutoEnqueues24h: recentStaleEnqueues.map((r) => ({
        funderAddress: r.funderAddress,
        lastStaleEnqueueReason: r.lastStaleEnqueueReason,
        lastStaleEnqueueAt: r.lastStaleEnqueueAt?.toISOString(),
        currentlyDirty: r.dirtyAt != null,
      })),
    },
    primaryFunder: funder || null,
    primaryFunderAnalysis: primaryAnalysis,
    primaryFunderQueue: queueRowForPrimary
      ? {
          dirtyAt: queueRowForPrimary.dirtyAt?.toISOString() ?? null,
          lastStaleEnqueueReason: queueRowForPrimary.lastStaleEnqueueReason ?? null,
          lastStaleEnqueueAt: queueRowForPrimary.lastStaleEnqueueAt?.toISOString() ?? null,
          likelyAutoEnqueuedForStale:
            !!queueRowForPrimary.lastStaleEnqueueReason &&
            /behavior_penalty_mismatch|stale_behavior_block_copy/.test(
              queueRowForPrimary.lastStaleEnqueueReason
            ),
        }
      : null,
    paperLoader: loadDiagnostics
      ? {
          afterPolicyFilter: loadDiagnostics.afterPolicyFilter,
          zeroCandidatesReason: loadDiagnostics.zeroCandidatesReason ?? null,
          policyStateCounts: loadDiagnostics.policyStateCounts ?? {},
        }
      : null,
    verification: {
      workerMustRun:
        "Run `npm run worker` — next policy_refresh_pending will enqueue stale funders then refresh after debounce.",
      manualJob: 'POST /api/ops/run-job body: {"jobName":"policy_refresh_pending"}',
      migrateNote: "Apply migration adding lastStaleEnqueueReason / lastStaleEnqueueAt if not yet deployed.",
    },
  };

  const jsonPath = path.join(dumpDir, "policy-refresh-automation-report.json");
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");
  console.log("Wrote", jsonPath);

  const md = [
    "# Policy refresh automation",
    "",
    "| Item | Value |",
    "|------|-------|",
    "| Job wired | " + jobWired + " |",
    "| Interval | " + Math.round(intervalMs / 1000) + "s |",
    "| Stale funders detected (scan) | " + staleDetectedList.length + " |",
    "| Pending dirty | " + pending.length + " |",
    "| Primary funder | `" + (funder || "—") + "` |",
    "| Primary: stale | " + (primaryAnalysis?.stale ?? "—") + " |",
    "| Primary: dirty now | " + (queueRowForPrimary?.dirtyAt ? "yes" : "no") + " |",
    "| Last stale enqueue reason | " + (queueRowForPrimary?.lastStaleEnqueueReason ?? "—") + " |",
    "",
    "## Stale detected (sample)",
    "",
    staleDetectedList.length === 0
      ? "_None._"
      : "```json\n" +
        JSON.stringify(
          staleDetectedList.slice(0, 10).map((a) => ({
            funder: a.funderAddress,
            reasons: a.reasons,
            live: a.livePenalty,
            persisted: a.persistedPenalty,
            behaviorBlockedRecs: a.behaviorBlockedRecCount,
          })),
          null,
          2
        ) +
        "\n```",
    "",
    "## Verify",
    "",
    report.verification.workerMustRun,
    "",
  ].join("\n");

  await fs.writeFile(path.join(dumpDir, "policy-refresh-automation-report.md"), md, "utf8");
  console.log("Wrote dump/policy-refresh-automation-report.md");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
