/**
 * Reconciliation drift debug report.
 *
 * Writes:
 * - dump/reconciliation-drift-debug-report.json
 * - dump/reconciliation-drift-debug-report.md
 *
 * npm run dump:reconciliation-drift-debug-report
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import { getStoredCredentials } from "../lib/polymarket/auth";
import { fetchOpenOrdersL2 } from "../lib/polymarket/l2-readonly";

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

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });
  const generatedAt = new Date().toISOString();

  const hb = await prisma.workerHeartbeat.findUnique({
    where: { workerName: WORKER_NAME },
    select: { lastSeenAt: true, metadataJson: true },
  });
  const meta = safeJsonParse(hb?.metadataJson ?? null);
  const runtimeHealth = (meta?.runtimeHealth ?? null) as Record<string, unknown> | null;
  const runtimeSafety = (meta?.runtimeSafety ?? null) as Record<string, unknown> | null;
  const liveReadiness = (meta?.liveReadiness ?? null) as Record<string, unknown> | null;

  const rhMeta = (runtimeHealth?.metadata ?? null) as Record<string, unknown> | null;
  const reconciliation = (runtimeHealth?.reconciliation ?? null) as Record<string, unknown> | null;
  const diagnostics = (runtimeHealth?.diagnostics ?? null) as Record<string, unknown> | null;

  const detail = (rhMeta?.reconciliationDetail ?? null) as Record<string, unknown> | null;
  const firstDetectedAt = (rhMeta?.reconciliationDriftFirstDetectedAt ?? null) as string | null;

  // Live exchange snapshot for comparison context.
  let exchangeOrdersCount: number | null = null;
  let exchangeOrderIdsSample: string[] = [];
  let exchangeFetchError: string | null = null;
  try {
    const { credential } = await getStoredCredentials();
    if (credential) {
      const raw = await fetchOpenOrdersL2({
        apiKey: credential.apiKey,
        secret: credential.secret,
        passphrase: credential.passphrase,
        funderAddress: credential.funderAddress,
        polyAddress: credential.polyAddress,
      });
      const arr = Array.isArray(raw) ? raw : [];
      exchangeOrdersCount = arr.length;
      exchangeOrderIdsSample = arr
        .map((o) => (o && typeof o === "object" ? (o as Record<string, unknown>).id : null))
        .filter((x): x is string => typeof x === "string" && x.length > 0)
        .slice(0, 15);
    } else {
      exchangeFetchError = "no_stored_credentials";
    }
  } catch (e) {
    exchangeFetchError = e instanceof Error ? e.message : String(e);
  }

  const report = {
    generatedAt,
    workerName: WORKER_NAME,
    workerHeartbeatAt: hb?.lastSeenAt?.toISOString() ?? null,
    runtimeSafetyState: typeof runtimeSafety?.state === "string" ? runtimeSafety.state : null,
    runtimeSafetyBlockingReasons: Array.isArray(runtimeSafety?.blockingReasons)
      ? (runtimeSafety?.blockingReasons as string[])
      : [],
    liveReadinessBlockingReasons: Array.isArray(liveReadiness?.blockingReasons)
      ? (liveReadiness?.blockingReasons as string[])
      : [],
    reconciliation: {
      status: typeof reconciliation?.status === "string" ? reconciliation.status : null,
      lastAt: typeof reconciliation?.lastAt === "string" ? reconciliation.lastAt : null,
      freshness: typeof reconciliation?.freshness === "string" ? reconciliation.freshness : null,
      driftDetected: typeof reconciliation?.driftDetected === "boolean" ? reconciliation.driftDetected : null,
      reconcileDurationMs:
        typeof reconciliation?.reconcileDurationMs === "number" ? reconciliation.reconcileDurationMs : null,
      firstDetectedAt,
      detail,
    },
    diagnostics: {
      lastRuntimeReconciliationAt: typeof diagnostics?.lastRuntimeReconciliationAt === "string" ? diagnostics.lastRuntimeReconciliationAt : null,
      lastRuntimeReconciliationStatus:
        typeof diagnostics?.lastRuntimeReconciliationStatus === "string" ? diagnostics.lastRuntimeReconciliationStatus : null,
      runtimeReconciliationRuns: typeof diagnostics?.runtimeReconciliationRuns === "number" ? diagnostics.runtimeReconciliationRuns : null,
      runtimeReconciliationFailures:
        typeof diagnostics?.runtimeReconciliationFailures === "number" ? diagnostics.runtimeReconciliationFailures : null,
      driftDetectionsCount: typeof diagnostics?.driftDetectionsCount === "number" ? diagnostics.driftDetectionsCount : null,
      repairsAppliedCount: typeof diagnostics?.repairsAppliedCount === "number" ? diagnostics.repairsAppliedCount : null,
    },
    exchangeSnapshotNow: {
      openOrdersCount: exchangeOrdersCount,
      orderIdsSample: exchangeOrderIdsSample,
      error: exchangeFetchError,
    },
    interpretation: {
      likelyCause:
        "reconciliation_drift is set when runtime reconciliation driftDetected is true (missingLocalOrders, missingExchangeOrders, or missingFills). Use detail.* counts + samples to see which type of drift it is.",
      fixDirection:
        "If missingLocalOrders dominates, runtime was missing exchange orders (often after restart or credentials becoming available later). If missingExchangeOrders dominates, runtime has stale working orders absent on exchange. If missingFills dominates, runtime filledSize mismatches exchange size_matched (lagging WS/user truth).",
    },
  };

  const md = [
    "# Reconciliation drift debug report",
    "",
    `Generated: ${generatedAt}`,
    "",
    "## Current safety / readiness",
    "",
    `- **runtimeSafety.state:** ${report.runtimeSafetyState ?? "n/a"}`,
    `- **runtimeSafety.blockingReasons:** ${(report.runtimeSafetyBlockingReasons ?? []).join(", ") || "(none)"}`,
    `- **liveReadiness.blockingReasons:** ${(report.liveReadinessBlockingReasons ?? []).join(", ") || "(none)"}`,
    "",
    "## Reconciliation status",
    "",
    `- **status:** ${report.reconciliation.status ?? "n/a"}`,
    `- **lastAt:** ${report.reconciliation.lastAt ?? "n/a"}`,
    `- **freshness:** ${report.reconciliation.freshness ?? "n/a"}`,
    `- **driftDetected:** ${String(report.reconciliation.driftDetected)}`,
    `- **firstDetectedAt:** ${report.reconciliation.firstDetectedAt ?? "n/a"}`,
    "",
    "## Drift detail (from worker heartbeat)",
    "",
    "```json",
    JSON.stringify(report.reconciliation.detail ?? {}, null, 2),
    "```",
    "",
    "## Exchange snapshot (now)",
    "",
    `- **openOrdersCount:** ${report.exchangeSnapshotNow.openOrdersCount ?? "n/a"}`,
    `- **orderIdsSample:** ${(report.exchangeSnapshotNow.orderIdsSample ?? []).join(", ") || "(none)"}`,
    report.exchangeSnapshotNow.error ? `- **error:** ${report.exchangeSnapshotNow.error}` : "",
    "",
  ]
    .filter((x) => x !== "")
    .join("\n");

  await fs.writeFile(
    path.join(DUMP_DIR, "reconciliation-drift-debug-report.json"),
    JSON.stringify(report, null, 2)
  );
  await fs.writeFile(path.join(DUMP_DIR, "reconciliation-drift-debug-report.md"), md);
  console.log("Wrote dump/reconciliation-drift-debug-report.{json,md}");
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

