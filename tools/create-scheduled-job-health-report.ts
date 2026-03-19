/**
 * Scheduled job health report: stuck running rows, leases, recovery, and overlap prevention.
 *
 * Writes:
 * - dump/scheduled-job-health-report.json
 * - dump/scheduled-job-health-report.md
 *
 * npm run dump:scheduled-job-health-report
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";

const DUMP_DIR = path.join(process.cwd(), "dump");

const JOB_MAX_DURATION_MS: Record<string, number> = {
  user_sync: 3 * 60 * 1000,
  order_reconciliation: 3 * 60 * 1000,
  stream_repair: 6 * 60 * 1000,
  policy_refresh_pending: 3 * 60 * 1000,
};

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });
  const generatedAt = new Date().toISOString();

  const leases = await prisma.scheduledJobLease.findMany({
    orderBy: { jobName: "asc" },
  });
  const recentRuns = await prisma.scheduledJobRun.findMany({
    orderBy: { startedAt: "desc" },
    take: 200,
  });
  const running = recentRuns.filter((r) => r.status === "running");

  const staleRunning = running.filter((r) => {
    const max = JOB_MAX_DURATION_MS[r.jobName] ?? 5 * 60 * 1000;
    return Date.now() - r.startedAt.getTime() > max;
  });

  const staleAgeByJob: Record<string, number[]> = {};
  for (const r of staleRunning) {
    const ageMs = Date.now() - r.startedAt.getTime();
    const arr = (staleAgeByJob[r.jobName] ??= []);
    arr.push(ageMs);
  }

  const byJob: Record<string, unknown> = {};
  for (const jobName of Array.from(new Set(recentRuns.map((r) => r.jobName))).sort()) {
    const max = JOB_MAX_DURATION_MS[jobName] ?? 5 * 60 * 1000;
    const runs = recentRuns.filter((r) => r.jobName === jobName).slice(0, 20);
    const lease = leases.find((l) => l.jobName === jobName) ?? null;
    const runningCount = runs.filter((r) => r.status === "running").length;
    const staleRunningAges = staleAgeByJob[jobName] ?? [];
    const staleRunningCount = staleRunningAges.length;
    byJob[jobName] = {
      maxDurationMs: max,
      runningCount,
      staleRunningCount,
      oldestStaleRunningAgeMs: staleRunningAges.length ? Math.max(...staleRunningAges) : null,
      lastRun: runs[0]
        ? {
            id: runs[0].id,
            status: runs[0].status,
            startedAt: runs[0].startedAt.toISOString(),
            finishedAt: runs[0].finishedAt?.toISOString() ?? null,
            durationMs: runs[0].durationMs ?? null,
            errorMessage: runs[0].errorMessage ?? null,
          }
        : null,
      lease: lease
        ? {
            leaseId: lease.leaseId,
            leasedAt: lease.leasedAt.toISOString(),
            leaseExpiresAt: lease.leaseExpiresAt.toISOString(),
            lastHeartbeatAt: lease.lastHeartbeatAt.toISOString(),
            lastRunId: lease.lastRunId ?? null,
            lastRecoveredAt: lease.lastRecoveredAt?.toISOString() ?? null,
            lastRecoveredRunId: lease.lastRecoveredRunId ?? null,
          }
        : null,
      recentRuns: runs.map((r) => ({
        id: r.id,
        status: r.status,
        startedAt: r.startedAt.toISOString(),
        finishedAt: r.finishedAt?.toISOString() ?? null,
        durationMs: r.durationMs ?? null,
        errorMessage: r.errorMessage ?? null,
        metadataJson: r.metadataJson ?? null,
      })),
    };
  }

  const report = {
    generatedAt,
    overlapPrevention: {
      mechanism: "DB lease row (ScheduledJobLease) with expiry + periodic heartbeat; runScheduledJob claims lease atomically before creating run row.",
    },
    maxDurationsMs: JOB_MAX_DURATION_MS,
    leases,
    currentlyRunningRuns: running.map((r) => ({
      jobName: r.jobName,
      id: r.id,
      startedAt: r.startedAt.toISOString(),
      ageMs: Date.now() - r.startedAt.getTime(),
      metadataJson: r.metadataJson ?? null,
    })),
    staleRunningRuns: staleRunning.map((r) => ({
      jobName: r.jobName,
      id: r.id,
      startedAt: r.startedAt.toISOString(),
      ageMs: Date.now() - r.startedAt.getTime(),
      metadataJson: r.metadataJson ?? null,
    })),
    byJob,
  };

  const md = [
    "# Scheduled job health report",
    "",
    `Generated: ${generatedAt}`,
    "",
    "## Overlap prevention",
    "",
    report.overlapPrevention.mechanism,
    "",
    "## Max durations (ms)",
    "",
    "```json",
    JSON.stringify(report.maxDurationsMs, null, 2),
    "```",
    "",
    "## Currently running rows",
    "",
    "```json",
    JSON.stringify(report.currentlyRunningRuns, null, 2),
    "```",
    "",
    "## Stale running rows",
    "",
    "```json",
    JSON.stringify(report.staleRunningRuns, null, 2),
    "```",
    "",
    "## Per-job detail (recent runs + lease)",
    "",
    "```json",
    JSON.stringify(report.byJob, null, 2),
    "```",
    "",
  ].join("\n");

  await fs.writeFile(path.join(DUMP_DIR, "scheduled-job-health-report.json"), JSON.stringify(report, null, 2));
  await fs.writeFile(path.join(DUMP_DIR, "scheduled-job-health-report.md"), md);
  console.log("Wrote dump/scheduled-job-health-report.{json,md}");
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

