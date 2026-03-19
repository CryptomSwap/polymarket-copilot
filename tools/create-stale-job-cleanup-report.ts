/**
 * Stale job cleanup report (zombie running ScheduledJobRun rows).
 *
 * Writes:
 * - dump/stale-job-cleanup-report.json
 * - dump/stale-job-cleanup-report.md
 *
 * This is a read-only diagnostic tool used before running cleanup-stale-job-runs.
 */

import "dotenv/config";
import * as fs from "fs/promises";
import * as path from "path";
import { prisma } from "../lib/db";
import { JOB_MAX_DURATION_MS } from "../lib/ops/scheduled-jobs";

const DUMP_DIR = path.join(process.cwd(), "dump");
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
  await fs.mkdir(DUMP_DIR, { recursive: true });
  const generatedAt = new Date().toISOString();
  const now = Date.now();

  const running = await prisma.scheduledJobRun.findMany({
    where: { status: "running" },
    select: { id: true, jobName: true, startedAt: true, metadataJson: true },
    orderBy: { startedAt: "asc" },
    take: 2000,
  });

  const candidates: Array<{
    id: string;
    jobName: string;
    ageMs: number;
    maxDurationMs: number;
    staleThresholdMs: number;
    hasMetadataJson: boolean;
    leaseIdFromMetadata: string | null;
  }> = [];

  for (const r of running) {
    const ageMs = now - r.startedAt.getTime();
    const maxDurationMs = getMaxDurationMsForJob(r.jobName);
    const staleThresholdMs = Math.floor(maxDurationMs * STALE_MULTIPLIER + STALE_MIN_GRACE_MS);
    if (ageMs <= staleThresholdMs) continue;
    const meta = safeJsonParse(r.metadataJson) ?? {};
    const leaseIdFromMetadata = typeof meta.leaseId === "string" ? (meta.leaseId as string) : null;
    candidates.push({
      id: r.id,
      jobName: r.jobName,
      ageMs,
      maxDurationMs,
      staleThresholdMs,
      hasMetadataJson: !!r.metadataJson,
      leaseIdFromMetadata,
    });
  }

  const candidateJobs = Array.from(new Set(candidates.map((c) => c.jobName)));
  const leases = await prisma.scheduledJobLease.findMany({
    where: { jobName: { in: candidateJobs } },
    select: { jobName: true, leaseId: true, leaseExpiresAt: true, lastHeartbeatAt: true },
  });
  const leaseByJob = new Map<string, { leaseId: string; leaseExpiresAt: Date; lastHeartbeatAt: Date | null }>();
  for (const l of leases) leaseByJob.set(l.jobName, { leaseId: l.leaseId, leaseExpiresAt: l.leaseExpiresAt, lastHeartbeatAt: l.lastHeartbeatAt as Date | null });

  const report = {
    generatedAt,
    thresholds: {
      staleMultiplier: STALE_MULTIPLIER,
      staleMinGraceMs: STALE_MIN_GRACE_MS,
    },
    candidatesCount: candidates.length,
    candidatesByJob: candidateJobs.map((jobName) => {
      const inJob = candidates.filter((c) => c.jobName === jobName);
      const lease = leaseByJob.get(jobName) ?? null;
      return {
        jobName,
        staleRunningCount: inJob.length,
        agesMs: inJob.map((c) => c.ageMs),
        hasLease: lease != null,
        lease,
        recommendedCleanup: inJob.map((c) => ({
          id: c.id,
          ageMs: c.ageMs,
          maxDurationMs: c.maxDurationMs,
          staleThresholdMs: c.staleThresholdMs,
          leaseIdFromMetadata: c.leaseIdFromMetadata,
          hasMetadataJson: c.hasMetadataJson,
        })),
      };
    }),
    allCandidates: candidates.slice(0, 200).map((c) => ({
      id: c.id,
      jobName: c.jobName,
      ageMs: c.ageMs,
      maxDurationMs: c.maxDurationMs,
      staleThresholdMs: c.staleThresholdMs,
      hasMetadataJson: c.hasMetadataJson,
      leaseIdFromMetadata: c.leaseIdFromMetadata,
    })),
  };

  const md = [
    "# Stale Job Cleanup Report",
    "",
    `Generated: ${generatedAt}`,
    "",
    "## Summary",
    "",
    `candidatesCount=${report.candidatesCount}`,
    "",
    "## candidatesByJob",
    "",
    "```json",
    JSON.stringify(report.candidatesByJob, null, 2),
    "```",
    "",
  ].join("\n");

  await fs.writeFile(path.join(DUMP_DIR, "stale-job-cleanup-report.json"), JSON.stringify(report, null, 2));
  await fs.writeFile(path.join(DUMP_DIR, "stale-job-cleanup-report.md"), md);
  console.log("Wrote dump/stale-job-cleanup-report.{json,md}");
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

