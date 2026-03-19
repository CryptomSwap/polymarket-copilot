/**
 * User truth availability + freshness report (user_feed_extremely_stale).
 *
 * Writes:
 * - dump/user-truth-availability-report.json
 * - dump/user-truth-availability-report.md
 *
 * npm run dump:user-truth-availability-report
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import { DEFAULT_STREAM_WATCHDOG_CONFIG } from "../lib/runtime/stream-watchdog-config";

const DUMP_DIR = path.join(process.cwd(), "dump");
const WORKER_NAME = "polymarket-copilot-worker";

function safeJsonParse(s: string | null | undefined): Record<string, unknown> | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function ageMs(iso: string | null): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Date.now() - t;
}

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });
  const generatedAt = new Date().toISOString();

  const hb = await prisma.workerHeartbeat.findUnique({
    where: { workerName: WORKER_NAME },
    select: { lastSeenAt: true, metadataJson: true },
  });
  const meta = safeJsonParse(hb?.metadataJson ?? null);
  const runtimeHealth = (meta?.runtimeHealth ?? null) as Record<string, unknown> | null;
  const streams = (runtimeHealth?.streams ?? null) as Record<string, unknown> | null;
  const userConn = (streams?.userConnection ?? null) as Record<string, unknown> | null;
  const rhMeta = (runtimeHealth?.metadata ?? null) as Record<string, unknown> | null;
  const userTruthMaintenance = (meta?.userTruthMaintenance ?? null) as Record<string, unknown> | null;

  const lastSuccessfulUserTruthFetchAt = (rhMeta?.lastSuccessfulUserTruthFetchAt ?? null) as string | null;

  const scheduled = await prisma.scheduledJobRun.findMany({
    where: { jobName: { in: ["user_sync", "stream_repair"] } },
    orderBy: { startedAt: "desc" },
    take: 10,
  });

  const latestUserOrder = await prisma.userOrder.findFirst({
    orderBy: { syncedAt: "desc" },
    select: { syncedAt: true },
  });
  const latestUserFill = await prisma.userFill.findFirst({
    orderBy: { syncedAt: "desc" },
    select: { syncedAt: true },
  });

  const report = {
    generatedAt,
    workerName: WORKER_NAME,
    heartbeatAt: hb?.lastSeenAt?.toISOString() ?? null,
    thresholds: {
      watchdogUserDegradedMs: DEFAULT_STREAM_WATCHDOG_CONFIG.userDataDegradedThresholdMs,
      watchdogUserKillSwitchWithOrdersMs: DEFAULT_STREAM_WATCHDOG_CONFIG.userDataKillSwitchWithOrdersThresholdMs,
      runtimeSafetyDefaultUserBlockMs: 300_000,
    },
    userTruthMaintenance: {
      targetFreshMs:
        typeof userTruthMaintenance?.targetFreshMs === "number" ? (userTruthMaintenance?.targetFreshMs as number) : null,
      eagerTriggerMs:
        typeof userTruthMaintenance?.eagerTriggerMs === "number" ? (userTruthMaintenance?.eagerTriggerMs as number) : null,
      eagerTriggerMinGapMs:
        typeof userTruthMaintenance?.eagerTriggerMinGapMs === "number"
          ? (userTruthMaintenance?.eagerTriggerMinGapMs as number)
          : null,
      userSyncIntervalMs:
        typeof userTruthMaintenance?.userSyncIntervalMs === "number"
          ? (userTruthMaintenance?.userSyncIntervalMs as number)
          : null,
      lastScheduledUserSyncStartAt:
        typeof userTruthMaintenance?.lastScheduledUserSyncStartAt === "string"
          ? (userTruthMaintenance?.lastScheduledUserSyncStartAt as string)
          : null,
      lastEagerUserSyncRequestedAt:
        typeof userTruthMaintenance?.lastEagerUserSyncRequestedAt === "string"
          ? (userTruthMaintenance?.lastEagerUserSyncRequestedAt as string)
          : null,
      lastEagerUserSyncRequestedReason:
        typeof userTruthMaintenance?.lastEagerUserSyncRequestedReason === "string"
          ? (userTruthMaintenance?.lastEagerUserSyncRequestedReason as string)
          : null,
      earlySyncRequestedRecently:
        typeof userTruthMaintenance?.earlySyncRequestedRecently === "boolean"
          ? (userTruthMaintenance?.earlySyncRequestedRecently as boolean)
          : null,
      nextScheduledUserSyncAtApprox:
        typeof userTruthMaintenance?.nextScheduledUserSyncAtApprox === "string"
          ? (userTruthMaintenance?.nextScheduledUserSyncAtApprox as string)
          : null,
    },
    userWsInMemory: {
      status: typeof userConn?.status === "string" ? userConn.status : null,
      lastHeartbeatAt: (typeof userConn?.lastHeartbeatAt === "string" ? userConn.lastHeartbeatAt : null) as string | null,
      lastMessageAt: (typeof userConn?.lastMessageAt === "string" ? userConn.lastMessageAt : null) as string | null,
      lastDataEventAt: (typeof userConn?.lastDataEventAt === "string" ? userConn.lastDataEventAt : null) as string | null,
      agesMs: {
        heartbeat: ageMs(typeof userConn?.lastHeartbeatAt === "string" ? (userConn.lastHeartbeatAt as string) : null),
        message: ageMs(typeof userConn?.lastMessageAt === "string" ? (userConn.lastMessageAt as string) : null),
        data: ageMs(typeof userConn?.lastDataEventAt === "string" ? (userConn.lastDataEventAt as string) : null),
      },
    },
    userTruthFetch: {
      lastSuccessfulUserTruthFetchAt,
      ageMs: ageMs(lastSuccessfulUserTruthFetchAt),
      note:
        "Worker runtime safety uses ws lastDataEventAt OR lastSuccessfulUserTruthFetchAt (min age). lastSuccessfulUserTruthFetchAt is now stored on globalThis to avoid module-duplication issues.",
    },
    scheduledJobs: scheduled.map((r) => ({
      jobName: r.jobName,
      status: r.status,
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
      durationMs: r.durationMs ?? null,
      errorMessage: r.errorMessage ?? null,
    })),
    dbActivityProxies: {
      latestUserOrderSyncedAt: latestUserOrder?.syncedAt?.toISOString() ?? null,
      latestUserFillSyncedAt: latestUserFill?.syncedAt?.toISOString() ?? null,
    },
    diagnosis: {
      staleIfNoTruthFetch:
        lastSuccessfulUserTruthFetchAt == null
          ? "user_sync/stream_repair may be failing or the in-process truth timestamp is not being updated."
          : null,
      wsQuietButTruthFresh:
        typeof userConn?.status === "string" &&
        userConn.status === "open" &&
        (ageMs(lastSuccessfulUserTruthFetchAt) ?? Infinity) < 120_000 &&
        (ageMs(typeof userConn?.lastDataEventAt === "string" ? (userConn.lastDataEventAt as string) : null) ?? Infinity) > 300_000
          ? "WS has no business events, but REST truth is fresh; safety should not classify extremely stale."
          : null,
    },
  };

  const md = [
    "# User truth availability report",
    "",
    `Generated: ${generatedAt}`,
    "",
    "## In-memory user WS state (heartbeat)",
    "",
    "```json",
    JSON.stringify(report.userWsInMemory, null, 2),
    "```",
    "",
    "## User truth maintenance (cadence + eager trigger)",
    "",
    "```json",
    JSON.stringify(report.userTruthMaintenance, null, 2),
    "```",
    "",
    "## User truth fetch freshness (REST polling)",
    "",
    "```json",
    JSON.stringify(report.userTruthFetch, null, 2),
    "```",
    "",
    "## Scheduled jobs (user_sync / stream_repair)",
    "",
    "```json",
    JSON.stringify(report.scheduledJobs, null, 2),
    "```",
    "",
    "## DB activity proxies",
    "",
    "```json",
    JSON.stringify(report.dbActivityProxies, null, 2),
    "```",
    "",
    "## Diagnosis",
    "",
    "```json",
    JSON.stringify(report.diagnosis, null, 2),
    "```",
    "",
  ].join("\n");

  await fs.writeFile(path.join(DUMP_DIR, "user-truth-availability-report.json"), JSON.stringify(report, null, 2));
  await fs.writeFile(path.join(DUMP_DIR, "user-truth-availability-report.md"), md);
  console.log("Wrote dump/user-truth-availability-report.{json,md}");
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

