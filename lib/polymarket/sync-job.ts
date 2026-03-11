/**
 * Persist sync job status for market and user sync (health, last success/failure).
 * TODO: Manual execution / cron can record start and finish via these helpers.
 */

import { prisma } from "@/lib/db";

export type SyncJobType = "market_sync" | "user_sync";
export type SyncJobStatusValue = "running" | "success" | "failure";

export async function recordSyncJobStart(jobType: SyncJobType): Promise<string> {
  const job = await prisma.syncJobStatus.create({
    data: {
      jobType,
      status: "running",
    },
  });
  return job.id;
}

export async function recordSyncJobFinish(
  id: string,
  status: "success" | "failure",
  opts?: { errorMessage?: string; metadata?: Record<string, unknown> }
): Promise<void> {
  await prisma.syncJobStatus.update({
    where: { id },
    data: {
      status,
      finishedAt: new Date(),
      errorMessage: opts?.errorMessage ?? undefined,
      metadata: opts?.metadata ? JSON.parse(JSON.stringify(opts.metadata)) : undefined,
      updatedAt: new Date(),
    },
  });
}

export async function getLastSyncJob(
  jobType: SyncJobType
): Promise<{
  status: string;
  startedAt: Date;
  finishedAt: Date | null;
  errorMessage: string | null;
  metadata: unknown;
} | null> {
  const job = await prisma.syncJobStatus.findFirst({
    where: { jobType },
    orderBy: { startedAt: "desc" },
  });
  return job;
}
