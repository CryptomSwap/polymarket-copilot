/**
 * Reconciliation alignment readiness report (liveReadiness.reconciliationAlignmentReady).
 *
 * Writes:
 * - dump/reconciliation-alignment-readiness-report.json
 * - dump/reconciliation-alignment-readiness-report.md
 *
 * npm run dump:reconciliation-alignment-readiness-report
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import {
  extractCanonicalWorkerRuntime,
  heartbeatIsFresh,
  parseHeartbeatMetadataJson,
} from "../lib/ops/worker-heartbeat-canonical";

const DUMP_DIR = path.join(process.cwd(), "dump");
const WORKER_NAME = "polymarket-copilot-worker";

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });
  const generatedAt = new Date().toISOString();

  const hb = await prisma.workerHeartbeat.findUnique({
    where: { workerName: WORKER_NAME },
    select: { lastSeenAt: true, metadataJson: true },
  });
  const meta = parseHeartbeatMetadataJson(hb?.metadataJson ?? null);
  const canonical = extractCanonicalWorkerRuntime(meta);
  const hbFresh = heartbeatIsFresh(hb?.lastSeenAt ?? null, Date.now(), 120_000);
  const runtimeHealth = (meta?.runtimeHealth ?? null) as Record<string, unknown> | null;
  const liveReadiness = (meta?.liveReadiness ?? null) as Record<string, unknown> | null;
  const reconciliation = (runtimeHealth?.reconciliation ?? null) as Record<string, unknown> | null;
  const diagnostics = (runtimeHealth?.diagnostics ?? null) as Record<string, unknown> | null;
  const rhMeta = (runtimeHealth?.metadata ?? null) as Record<string, unknown> | null;

  const lastOrderReconJobs = await prisma.scheduledJobRun.findMany({
    where: { jobName: { in: ["order_reconciliation"] } },
    orderBy: { startedAt: "desc" },
    take: 8,
  });

  const report = {
    generatedAt,
    workerName: WORKER_NAME,
    heartbeatAt: hb?.lastSeenAt?.toISOString() ?? null,
    heartbeatFreshUnder120s: hbFresh,
    canonicalWorkerRuntimeTruth: {
      ...canonical,
      note: "Same extraction as paper-pipeline-wakeup-report / runtime-safety-block-report (lib/ops/worker-heartbeat-canonical).",
    },
    liveReadinessBlockingReasons: Array.isArray(liveReadiness?.blockingReasons)
      ? (liveReadiness?.blockingReasons as string[])
      : [],
    reconciliationFromHealth: {
      status: typeof reconciliation?.status === "string" ? reconciliation.status : null,
      lastAt: typeof reconciliation?.lastAt === "string" ? reconciliation.lastAt : null,
      freshness: typeof reconciliation?.freshness === "string" ? reconciliation.freshness : null,
      driftDetected:
        typeof reconciliation?.driftDetected === "boolean"
          ? reconciliation.driftDetected
          : typeof reconciliation?.driftDetected === "string"
            ? reconciliation.driftDetected === "true"
            : null,
    },
    reconciliationDiagnostics: {
      lastRuntimeReconciliationAt: typeof diagnostics?.lastRuntimeReconciliationAt === "string" ? diagnostics.lastRuntimeReconciliationAt : null,
      lastRuntimeReconciliationStatus: typeof diagnostics?.lastRuntimeReconciliationStatus === "string" ? diagnostics.lastRuntimeReconciliationStatus : null,
      runtimeReconciliationRuns: typeof diagnostics?.runtimeReconciliationRuns === "number" ? diagnostics.runtimeReconciliationRuns : null,
      runtimeReconciliationFailures: typeof diagnostics?.runtimeReconciliationFailures === "number" ? diagnostics.runtimeReconciliationFailures : null,
      driftDetectionsCount: typeof diagnostics?.driftDetectionsCount === "number" ? diagnostics.driftDetectionsCount : null,
      repairsAppliedCount: typeof diagnostics?.repairsAppliedCount === "number" ? diagnostics.repairsAppliedCount : null,
    },
    alignmentReadySource: {
      runtimeHealthMetadata_reconciliationAlignmentReady: rhMeta?.reconciliationAlignmentReady ?? null,
      note:
        "Worker now prefers runtimeHealth.metadata.reconciliationAlignmentReady (fresh + drift=false) and falls back to reconciliation.status==='ok' && lastAt!=null.",
    },
    recentScheduledOrderReconciliationJobs: lastOrderReconJobs.map((r) => ({
      status: r.status,
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
      durationMs: r.durationMs ?? null,
      errorMessage: r.errorMessage ?? null,
    })),
    interpretation: {
      whyMissingOrFailed:
        "liveReadiness adds missing_or_failed:reconciliationAlignmentReady when reconciliationOk is false. That can be due to reconciliation never succeeding recently, or drift remaining true (alignment not achieved).",
      fixDirection:
        "If reconciliation shows ok+fresh but readiness still fails, wiring/heartbeat fields are stale. If reconciliation shows failure, address exchange truth availability/auth. If drift remains true, see dump:reconciliation-drift-debug-report for missingLocal/missingExchange/missingFills breakdown.",
    },
  };

  const md = [
    "# Reconciliation alignment readiness report",
    "",
    `Generated: ${generatedAt}`,
    "",
    "## Canonical runtime truth (aligned with paper-pipeline-wakeup-report)",
    "",
    "```json",
    JSON.stringify(report.canonicalWorkerRuntimeTruth, null, 2),
    "```",
    "",
    "## liveReadiness.blockingReasons",
    "",
    "```json",
    JSON.stringify(report.liveReadinessBlockingReasons, null, 2),
    "```",
    "",
    "## Reconciliation from runtimeHealth",
    "",
    "```json",
    JSON.stringify(report.reconciliationFromHealth, null, 2),
    "```",
    "",
    "## Diagnostics counters",
    "",
    "```json",
    JSON.stringify(report.reconciliationDiagnostics, null, 2),
    "```",
    "",
    "## Alignment-ready source",
    "",
    "```json",
    JSON.stringify(report.alignmentReadySource, null, 2),
    "```",
    "",
    "## Recent order_reconciliation scheduled jobs",
    "",
    "```json",
    JSON.stringify(report.recentScheduledOrderReconciliationJobs, null, 2),
    "```",
    "",
  ].join("\n");

  await fs.writeFile(
    path.join(DUMP_DIR, "reconciliation-alignment-readiness-report.json"),
    JSON.stringify(report, null, 2)
  );
  await fs.writeFile(path.join(DUMP_DIR, "reconciliation-alignment-readiness-report.md"), md);
  console.log("Wrote dump/reconciliation-alignment-readiness-report.{json,md}");
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

