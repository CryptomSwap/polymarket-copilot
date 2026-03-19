/**
 * Sustained freshness forensic report:
 * - captures last advancement times for reconciliation, exchange truth, user truth, heartbeat
 * - checks whether those loops look fresh (still firing) vs stale (regressed)
 * - inspects recent scheduled jobs + leases that maintain user truth
 *
 * Writes:
 * - dump/sustained-freshness-report.json
 * - dump/sustained-freshness-report.md
 *
 * Run:
 * - npm run dump:sustained-freshness-report
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import { parseHeartbeatMetadataJson } from "../lib/ops/worker-heartbeat-canonical";

const DUMP = path.join(process.cwd(), "dump");
const WORKER_NAME = "polymarket-copilot-worker";

const RECONCILE_FRESHNESS_MS = 120_000;
const ORDERS_STALE_MS = 120_000;
const FILLS_STALE_MS = 180_000;
const HEARTBEAT_STALE_MS = 120_000;

type WindowStatus = {
  ageMs: number | null;
  isFresh: boolean | null;
  staleThresholdMs: number;
};

function parseIsoMaybe(v: unknown): string | null {
  if (typeof v !== "string") return null;
  return v;
}

function ageMsFromIso(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return now - t;
}

function summarizeWindow(ageMs: number | null, staleThresholdMs: number): WindowStatus {
  if (ageMs == null) {
    return { ageMs: null, isFresh: null, staleThresholdMs };
  }
  return { ageMs, isFresh: ageMs <= staleThresholdMs, staleThresholdMs };
}

function toReasonList(x: unknown): string[] {
  if (!Array.isArray(x)) return [];
  return x.filter((s): s is string => typeof s === "string");
}

async function main(): Promise<void> {
  await fs.mkdir(DUMP, { recursive: true });
  const now = Date.now();

  const hb = await prisma.workerHeartbeat.findUnique({
    where: { workerName: WORKER_NAME },
    select: { lastSeenAt: true, metadataJson: true },
  });

  const metadata = parseHeartbeatMetadataJson(hb?.metadataJson ?? null) ?? null;
  const runtimeSafety = metadata?.runtimeSafety as Record<string, unknown> | null | undefined;
  const runtimeHealth = metadata?.runtimeHealth as Record<string, unknown> | null | undefined;
  const diagnostics = runtimeHealth?.diagnostics as Record<string, unknown> | null | undefined;
  const rhMetadata = runtimeHealth?.metadata as Record<string, unknown> | null | undefined;
  const streams = runtimeHealth?.streams as Record<string, unknown> | null | undefined;
  const userTruthMaintenance = metadata?.userTruthMaintenance as Record<string, unknown> | null | undefined;

  const heartbeatLastSeenAt = hb?.lastSeenAt ? hb.lastSeenAt.toISOString() : null;
  const heartbeatAgeMs = hb?.lastSeenAt ? now - hb.lastSeenAt.getTime() : null;
  const heartbeatWindow = summarizeWindow(heartbeatAgeMs, HEARTBEAT_STALE_MS);

  const runtimeSafetyState =
    runtimeSafety && typeof runtimeSafety.state === "string" ? (runtimeSafety.state as string) : null;
  const runtimeSafetyBlockingReasons = runtimeSafety ? toReasonList(runtimeSafety.blockingReasons) : [];

  const lastRuntimeReconciliationAt = diagnostics?.lastRuntimeReconciliationAt
    ? (parseIsoMaybe(diagnostics.lastRuntimeReconciliationAt) ?? String(diagnostics.lastRuntimeReconciliationAt))
    : null;
  const lastRuntimeReconciliationStatus =
    typeof diagnostics?.lastRuntimeReconciliationStatus === "string"
      ? (diagnostics.lastRuntimeReconciliationStatus as string)
      : null;

  const reconAgeMs = ageMsFromIso(lastRuntimeReconciliationAt, now);
  const reconWindow = summarizeWindow(reconAgeMs, RECONCILE_FRESHNESS_MS);

  const runtimeReconciliationRuns =
    typeof diagnostics?.runtimeReconciliationRuns === "number" ? (diagnostics.runtimeReconciliationRuns as number) : null;
  const runtimeReconciliationFailures =
    typeof diagnostics?.runtimeReconciliationFailures === "number"
      ? (diagnostics.runtimeReconciliationFailures as number)
      : null;

  const lastExchangeOrdersSnapshotAt =
    typeof rhMetadata?.lastExchangeOrdersSnapshotAt === "string" ? (rhMetadata.lastExchangeOrdersSnapshotAt as string) : null;
  const lastExchangeFillsSnapshotAt =
    typeof rhMetadata?.lastExchangeFillsSnapshotAt === "string" ? (rhMetadata.lastExchangeFillsSnapshotAt as string) : null;

  const exchangeTruthUnavailable =
    typeof rhMetadata?.exchangeTruthUnavailable === "boolean" ? (rhMetadata.exchangeTruthUnavailable as boolean) : null;

  const ordersAgeMs = ageMsFromIso(lastExchangeOrdersSnapshotAt, now);
  const fillsAgeMs = ageMsFromIso(lastExchangeFillsSnapshotAt, now);
  const ordersWindow = summarizeWindow(ordersAgeMs, ORDERS_STALE_MS);
  const fillsWindow = summarizeWindow(fillsAgeMs, FILLS_STALE_MS);

  const userLastDataEventAt =
    typeof streams?.userLastDataEventAt === "string" ? (streams.userLastDataEventAt as string) : null;
  const marketLastDataEventAt =
    typeof streams?.marketLastDataEventAt === "string" ? (streams.marketLastDataEventAt as string) : null;

  const wsUserAgeMs = ageMsFromIso(userLastDataEventAt, now);
  const wsMarketAgeMs = ageMsFromIso(marketLastDataEventAt, now);

  const lastSuccessfulUserTruthFetchAt =
    typeof rhMetadata?.lastSuccessfulUserTruthFetchAt === "string" ? (rhMetadata.lastSuccessfulUserTruthFetchAt as string) : null;
  const targetFreshMs =
    typeof userTruthMaintenance?.targetFreshMs === "number" ? (userTruthMaintenance.targetFreshMs as number) : 60_000;
  const userTruthAgeMs = ageMsFromIso(lastSuccessfulUserTruthFetchAt, now);
  const userTruthWindow = summarizeWindow(userTruthAgeMs, targetFreshMs);

  const recentUserSyncJobs = await prisma.scheduledJobRun.findMany({
    where: { jobName: { in: ["user_sync", "stream_repair"] as unknown as string[] } },
    orderBy: { startedAt: "desc" },
    take: 8,
    select: { id: true, jobName: true, status: true, startedAt: true, finishedAt: true, durationMs: true, errorMessage: true },
  });

  const leases = await prisma.scheduledJobLease.findMany({
    where: { jobName: { in: ["user_sync", "stream_repair"] as unknown as string[] } },
    select: { jobName: true, leaseId: true, leasedAt: true, leaseExpiresAt: true, lastHeartbeatAt: true, lastRunId: true, lastRecoveredAt: true, updatedAt: true },
  });

  // Predict which freshness inputs are likely blocking guardrails (based on StreamRuntime logic for paper mode).
  const likelyReconciliationFresh = lastRuntimeReconciliationAt != null && reconAgeMs != null && reconAgeMs <= RECONCILE_FRESHNESS_MS;
  const likelyExchangeHealthy = !exchangeTruthUnavailable && ordersAgeMs != null && fillsAgeMs != null && ordersAgeMs <= ORDERS_STALE_MS && fillsAgeMs <= FILLS_STALE_MS;

  const likelyWorkingOrdersBreach =
    // StreamRuntime passes blockOnStaleExchangeTruthWithWorkingOrders=true and uses openOrderCount + exchangeTruthHealthy.
    // We can't compute openOrderCount here reliably from heartbeat metadata, but exchangeTruthHealthy=false implies it can trigger when there are working orders.
    !likelyExchangeHealthy;

  const currentDerivedFreshnessBlockPredicates = {
    reconciliationFresh: likelyReconciliationFresh,
    exchangeTruthHealthy: likelyExchangeHealthy,
    workingOrdersBreachLikely: likelyWorkingOrdersBreach,
    userTruthFreshLikely: userTruthWindow.isFresh,
  };

  const report = {
    generatedAt: new Date().toISOString(),
    worker: { workerName: WORKER_NAME },
    heartbeat: {
      lastSeenAt: heartbeatLastSeenAt,
      ageMs: heartbeatAgeMs,
      staleThresholdMs: HEARTBEAT_STALE_MS,
      isFresh: heartbeatWindow.isFresh,
    },
    runtimeSafety: {
      state: runtimeSafetyState,
      blockingReasons: runtimeSafetyBlockingReasons,
    },
    reconciliationLoop: {
      lastRuntimeReconciliationAt,
      ageMs: reconAgeMs,
      thresholdMs: RECONCILE_FRESHNESS_MS,
      isFresh: reconWindow.isFresh,
      lastRuntimeReconciliationStatus,
      runtimeReconciliationRuns,
      runtimeReconciliationFailures,
    },
    exchangeTruth: {
      exchangeTruthUnavailable,
      lastExchangeOrdersSnapshotAt,
      ordersAgeMs,
      ordersStaleThresholdMs: ORDERS_STALE_MS,
      ordersIsFresh: ordersWindow.isFresh,
      lastExchangeFillsSnapshotAt,
      fillsAgeMs,
      fillsStaleThresholdMs: FILLS_STALE_MS,
      fillsIsFresh: fillsWindow.isFresh,
      exchangeTruthHealthyLikely: likelyExchangeHealthy,
    },
    userTruth: {
      lastSuccessfulUserTruthFetchAt,
      userTruthAgeMs,
      targetFreshMs,
      userTruthIsFreshLikely: userTruthWindow.isFresh,
      wsUserLastDataEventAt: userLastDataEventAt,
      wsUserAgeMs,
    },
    feeds: {
      wsMarketLastDataEventAt: marketLastDataEventAt,
      wsMarketAgeMs,
    },
    loopsLookLikeStillFiring: {
      heartbeat: heartbeatWindow.isFresh,
      reconciliation: reconWindow.isFresh,
      exchangeTruth: likelyExchangeHealthy,
      userTruth: userTruthWindow.isFresh,
    },
    scheduledJobs: {
      recent: recentUserSyncJobs,
      leases,
    },
    likelyGuardrailFreshnessPredicateSummary: currentDerivedFreshnessBlockPredicates,
  };

  const jsonPath = path.join(DUMP, "sustained-freshness-report.json");
  const mdPath = path.join(DUMP, "sustained-freshness-report.md");
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");

  const md = [
    "# Sustained freshness report",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "## Heartbeat",
    "",
    `- lastSeenAt: ${report.heartbeat.lastSeenAt ?? "—"}`,
    `- ageMs: ${report.heartbeat.ageMs ?? "—"} (fresh<=${report.heartbeat.staleThresholdMs}ms)`,
    `- fresh: ${String(report.heartbeat.isFresh)}`,
    "",
    "## Runtime safety",
    "",
    `- state: ${report.runtimeSafety.state ?? "—"}`,
    `- blockingReasons: ${JSON.stringify(report.runtimeSafety.blockingReasons)}`,
    "",
    "## Reconciliation loop freshness",
    "",
    `- lastRuntimeReconciliationAt: ${report.reconciliationLoop.lastRuntimeReconciliationAt ?? "—"}`,
    `- ageMs: ${report.reconciliationLoop.ageMs ?? "—"} (fresh<=${report.reconciliationLoop.thresholdMs}ms)`,
    `- fresh: ${String(report.reconciliationLoop.isFresh)}`,
    `- lastStatus: ${report.reconciliationLoop.lastRuntimeReconciliationStatus ?? "—"}`,
    `- runs/failures (since process start): ${report.reconciliationLoop.runtimeReconciliationRuns ?? "—"} / ${report.reconciliationLoop.runtimeReconciliationFailures ?? "—"}`,
    "",
    "## Exchange truth freshness",
    "",
    `- exchangeTruthUnavailable: ${String(report.exchangeTruth.exchangeTruthUnavailable)}`,
    `- orders snapshot at: ${report.exchangeTruth.lastExchangeOrdersSnapshotAt ?? "—"}`,
    `- orders ageMs: ${report.exchangeTruth.ordersAgeMs ?? "—"} (fresh<=${report.exchangeTruth.ordersStaleThresholdMs}ms)`,
    `- orders fresh: ${String(report.exchangeTruth.ordersIsFresh)}`,
    `- fills snapshot at: ${report.exchangeTruth.lastExchangeFillsSnapshotAt ?? "—"}`,
    `- fills ageMs: ${report.exchangeTruth.fillsAgeMs ?? "—"} (fresh<=${report.exchangeTruth.fillsStaleThresholdMs}ms)`,
    `- fills fresh: ${String(report.exchangeTruth.fillsIsFresh)}`,
    `- exchangeTruthHealthyLikely: ${String(report.exchangeTruth.exchangeTruthHealthyLikely)}`,
    "",
    "## User truth freshness",
    "",
    `- lastSuccessfulUserTruthFetchAt: ${report.userTruth.lastSuccessfulUserTruthFetchAt ?? "—"}`,
    `- userTruthAgeMs: ${report.userTruth.userTruthAgeMs ?? "—"} (fresh<=targetFreshMs ${report.userTruth.targetFreshMs}ms)`,
    `- userTruth fresh likely: ${String(report.userTruth.userTruthIsFreshLikely)}`,
    `- ws userLastDataEventAt: ${report.userTruth.wsUserLastDataEventAt ?? "—"}`,
    `- ws user ageMs: ${report.userTruth.wsUserAgeMs ?? "—"}`,
    "",
    "## Loops firing look (freshness-based)",
    "",
    `- heartbeat: ${String(report.loopsLookLikeStillFiring.heartbeat)}`,
    `- reconciliation: ${String(report.loopsLookLikeStillFiring.reconciliation)}`,
    `- exchangeTruth: ${String(report.loopsLookLikeStillFiring.exchangeTruth)}`,
    `- userTruth: ${String(report.loopsLookLikeStillFiring.userTruth)}`,
    "",
    "## Likely current guardrail freshness predicates",
    "",
    `- reconciliationFresh: ${String(report.likelyGuardrailFreshnessPredicateSummary.reconciliationFresh)}`,
    `- exchangeTruthHealthy: ${String(report.likelyGuardrailFreshnessPredicateSummary.exchangeTruthHealthy)}`,
    `- workingOrdersBreachLikely (exchange healthy=false): ${String(report.likelyGuardrailFreshnessPredicateSummary.workingOrdersBreachLikely)}`,
    `- userTruthFreshLikely: ${String(report.likelyGuardrailFreshnessPredicateSummary.userTruthFreshLikely)}`,
    "",
    "## Scheduled jobs & leases (user truth maintenance)",
    "",
    "### Recent runs",
    "",
    ...report.scheduledJobs.recent.map(
      (r: any) =>
        `- ${r.jobName} ${r.status} startedAt=${r.startedAt.toISOString()} finishedAt=${r.finishedAt ? r.finishedAt.toISOString() : "—"} error=${r.errorMessage ?? "—"} durationMs=${r.durationMs ?? "—"}`
    ),
    "",
    "### Current leases",
    "",
    ...report.scheduledJobs.leases.map(
      (l: any) =>
        `- ${l.jobName} leaseId=${l.leaseId} expiresAt=${l.leaseExpiresAt.toISOString()} lastHeartbeatAt=${l.lastHeartbeatAt ? l.lastHeartbeatAt.toISOString() : "—"} lastRunId=${l.lastRunId ?? "—"}`
    ),
    "",
    "## Commands",
    "",
    "```bash",
    "npm run dump:sustained-freshness-report",
    "npm run dump:paper-pipeline-wakeup-report",
    "npm run dump:runtime-safety-forensics-report",
    "```",
  ];

  await fs.writeFile(mdPath, md.join("\n"), "utf8");
  console.log("Wrote " + jsonPath);
  console.log("Wrote " + mdPath);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

