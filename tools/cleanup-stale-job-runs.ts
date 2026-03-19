/**
 * Cleanup stale/zombie ScheduledJobRun rows (status=running but older than safe threshold).
 *
 * Conservative by design:
 * - Only marks "running" rows that are clearly older than (job maxDurationMs * multiplier + graceMs).
 * - Optionally releases ScheduledJobLease rows only when the lease is already expired OR matches the run's leaseId.
 *
 * Usage:
 * - Dry run:   npx tsx tools/cleanup-stale-job-runs.ts --dry-run
 * - Apply:      npx tsx tools/cleanup-stale-job-runs.ts --apply
 */

import "dotenv/config";
import { prisma } from "../lib/db";
import { JOB_MAX_DURATION_MS, type JobName } from "../lib/ops/scheduled-jobs";

type ScheduledRunRow = {
  id: string;
  jobName: string;
  startedAt: Date;
  metadataJson: string | null;
};

const DRY_RUN_DEFAULT = true;
const STALE_MULTIPLIER = Number(process.env.JOB_ZOMBIE_STALE_MULTIPLIER ?? "1.5") || 1.5;
const STALE_MIN_GRACE_MS = Number(process.env.JOB_ZOMBIE_STALE_MIN_GRACE_MS ?? "60000") || 60_000;

function safeJsonParse(s: string | null | undefined): Record<string, unknown> | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function getMaxDurationMsForJob(jobName: string): number {
  return (JOB_MAX_DURATION_MS as Record<string, number>)[jobName] ?? 5 * 60 * 1000;
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const apply = args.has("--apply");
  const dryRun = args.has("--dry-run") || (!apply && DRY_RUN_DEFAULT);

  const now = Date.now();
  const running = await prisma.scheduledJobRun.findMany({
    where: { status: "running" },
    select: { id: true, jobName: true, startedAt: true, metadataJson: true },
    orderBy: { startedAt: "asc" },
    take: 2000,
  });

  const candidates: Array<{
    run: ScheduledRunRow;
    ageMs: number;
    maxDurationMs: number;
    staleThresholdMs: number;
    leaseIdFromRun: string | null;
  }> = [];

  for (const r of running) {
    const jobName = r.jobName;
    const ageMs = now - r.startedAt.getTime();
    const maxDurationMs = getMaxDurationMsForJob(jobName);
    const staleThresholdMs = Math.floor(maxDurationMs * STALE_MULTIPLIER + STALE_MIN_GRACE_MS);

    if (ageMs > staleThresholdMs) {
      const meta = safeJsonParse(r.metadataJson) ?? {};
      const leaseIdFromRun = typeof meta.leaseId === "string" ? (meta.leaseId as string) : null;
      candidates.push({ run: r, ageMs, maxDurationMs, staleThresholdMs, leaseIdFromRun });
    }
  }

  if (candidates.length === 0) {
    console.log(`[cleanup-stale-job-runs] no stale/zombie running jobs found (dryRun=${dryRun})`);
    await prisma.$disconnect();
    return;
  }

  const byJob: Record<string, number> = {};
  for (const c of candidates) byJob[c.run.jobName] = (byJob[c.run.jobName] ?? 0) + 1;

  console.log(`[cleanup-stale-job-runs] dryRun=${dryRun} apply=${apply}`);
  console.log(`[cleanup-stale-job-runs] foundCandidates=${candidates.length} byJob=`, byJob);

  // Fetch current leases for candidate jobs so we can release safely.
  const candidateJobs = Array.from(new Set(candidates.map((c) => c.run.jobName)));
  const leases = await prisma.scheduledJobLease.findMany({
    where: { jobName: { in: candidateJobs } },
    select: { jobName: true, leaseId: true, leaseExpiresAt: true },
  });
  const leaseByJob = new Map<string, { leaseId: string; leaseExpiresAt: Date }>();
  for (const l of leases) leaseByJob.set(l.jobName, { leaseId: l.leaseId, leaseExpiresAt: l.leaseExpiresAt });

  let updatedRuns = 0;
  let releasedLeases = 0;

  for (const c of candidates) {
    const { run, ageMs, leaseIdFromRun } = c;
    const meta = safeJsonParse(run.metadataJson);
    const hasMetadata = meta != null;
    const legacy = !hasMetadata || leaseIdFromRun == null;

    const errorMessage = legacy ? "cleanup_stale_legacy_run" : `cleanup_stale_running_run:${ageMs}ms`;

    if (dryRun) {
      console.log(`[DRY] would fail run`, {
        id: run.id,
        jobName: run.jobName,
        ageMs,
        errorMessage,
      });
    } else {
      await prisma.scheduledJobRun.update({
        where: { id: run.id },
        data: {
          status: "failure",
          finishedAt: new Date(),
          durationMs: ageMs,
          errorMessage,
        },
      });
      updatedRuns++;
    }

    const lease = leaseByJob.get(run.jobName);
    if (!lease || !leaseIdFromRun) continue;
    const leaseExpired = lease.leaseExpiresAt.getTime() <= now;

    // Be conservative: only release a lease when it is already expired.
    // Releasing a non-expired lease can allow overlap with a still-running (hung) job.
    if (leaseExpired) {
      if (dryRun) {
        console.log(`[DRY] would release lease`, {
          jobName: run.jobName,
          leaseId: lease.leaseId,
          leaseExpired,
        });
      } else {
        await prisma.scheduledJobLease.updateMany({
          where: { jobName: run.jobName, leaseId: lease.leaseId },
          data: { leaseExpiresAt: new Date(0), lastHeartbeatAt: new Date() },
        });
        releasedLeases++;
      }
    }
  }

  console.log(`[cleanup-stale-job-runs] updatedRuns=${updatedRuns} releasedLeases=${releasedLeases} candidates=${candidates.length}`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

