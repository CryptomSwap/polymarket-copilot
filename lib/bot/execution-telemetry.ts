/**
 * Execution telemetry: aggregate BotQueueExecutionLog for observability and tuning.
 * No automation; read-only analytics for operator and guardrail tuning.
 */

import { prisma } from "@/lib/db";

const DEFAULT_RECENT_LIMIT = 20;
const DEFAULT_TOP_FAILURES = 10;

export interface ExecutionTelemetryResult {
  totalAttempts: number;
  successCount: number;
  failedCount: number;
  successRatePct: number | null;
  lastExecutionAt: string | null;
  topFailureReasons: Array<{ reason: string; count: number }>;
  recentAttempts: Array<{
    id: string;
    queueEntryId: string;
    resultStatus: string;
    errorMessage: string | null;
    orderIntentId: string | null;
    createdAt: string;
  }>;
}

/**
 * Compute execution telemetry for a funder from BotQueueExecutionLog.
 */
export async function getExecutionTelemetry(
  funderAddress: string,
  options?: {
    recentLimit?: number;
    topFailureLimit?: number;
  }
): Promise<ExecutionTelemetryResult> {
  const funder = funderAddress.toLowerCase().trim();
  const recentLimit = options?.recentLimit ?? DEFAULT_RECENT_LIMIT;
  const topFailureLimit = options?.topFailureLimit ?? DEFAULT_TOP_FAILURES;

  const [totalAttempts, byStatus, lastLog, recentLogs, failedLogs] = await Promise.all([
    prisma.botQueueExecutionLog.count({ where: { funderAddress: funder } }),
    prisma.botQueueExecutionLog.groupBy({
      by: ["resultStatus"],
      where: { funderAddress: funder },
      _count: { id: true },
    }),
    prisma.botQueueExecutionLog.findFirst({
      where: { funderAddress: funder },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
    prisma.botQueueExecutionLog.findMany({
      where: { funderAddress: funder },
      orderBy: { createdAt: "desc" },
      take: recentLimit,
    }),
    prisma.botQueueExecutionLog.findMany({
      where: { funderAddress: funder, resultStatus: "FAILED" },
      select: { errorMessage: true },
      take: 2000,
    }),
  ]);

  const successCount = byStatus.find((s) => s.resultStatus === "SUCCESS")?._count?.id ?? 0;
  const failedCount = byStatus.find((s) => s.resultStatus === "FAILED")?._count?.id ?? 0;
  const successRatePct =
    totalAttempts > 0 ? (successCount / totalAttempts) * 100 : null;
  const lastExecutionAt = lastLog?.createdAt?.toISOString() ?? null;

  const failureReasons = new Map<string, number>();
  for (const log of failedLogs) {
    if (!log.errorMessage) continue;
    const key = log.errorMessage.trim().slice(0, 200);
    failureReasons.set(key, (failureReasons.get(key) ?? 0) + 1);
  }
  const topFailureReasons = Array.from(failureReasons.entries())
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, topFailureLimit);

  const recentAttempts = recentLogs.map((l) => ({
    id: l.id,
    queueEntryId: l.queueEntryId,
    resultStatus: l.resultStatus,
    errorMessage: l.errorMessage,
    orderIntentId: l.orderIntentId,
    createdAt: l.createdAt.toISOString(),
  }));

  return {
    totalAttempts,
    successCount,
    failedCount,
    successRatePct,
    lastExecutionAt,
    topFailureReasons,
    recentAttempts,
  };
}
