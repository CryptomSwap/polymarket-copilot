/**
 * Reconciliation drift forensics report.
 *
 * Primary source of truth:
 * - latest worker heartbeat metadataJson (StreamRuntime reconciliationDetail samples + counts)
 *
 * Secondary evidence:
 * - recent OrderLifecycleJournalEntry rows for repair_applied / repair_recommended events
 *
 * Writes:
 * - dump/reconciliation-drift-forensics-report.json
 * - dump/reconciliation-drift-forensics-report.md
 *
 * npm run dump:reconciliation-drift-forensics-report
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import { ORDER_LIFECYCLE_EVENT_TYPES } from "../lib/runtime/journal/order-lifecycle-journal";

const DUMP_DIR = path.join(process.cwd(), "dump");
const WORKER_NAME = "polymarket-copilot-worker";

type Json = Record<string, unknown>;

function safeJsonParse(s: string | null | undefined): Json | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as Json;
  } catch {
    return null;
  }
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function groupByAssetMarket<T extends { assetId?: string; marketId?: string }>(rows: T[]): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const r of rows) {
    const assetId = typeof r.assetId === "string" ? r.assetId : "unknownAsset";
    const marketId = typeof r.marketId === "string" ? r.marketId : "unknownMarket";
    const k = `${assetId}::${marketId}`;
    (out[k] ||= []).push(r);
  }
  return out;
}

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });
  const generatedAt = new Date().toISOString();

  const hb = await prisma.workerHeartbeat.findUnique({
    where: { workerName: WORKER_NAME },
    select: { lastSeenAt: true, metadataJson: true },
  });

  const meta = safeJsonParse(hb?.metadataJson ?? null);
  const runtimeHealth = meta?.runtimeHealth as Json | undefined | null;
  const runtimeSafety = meta?.runtimeSafety as Json | undefined | null;
  const liveReadiness = meta?.liveReadiness as Json | undefined | null;

  const rhMeta = (runtimeHealth?.metadata as Json | undefined | null) ?? null;
  const reconciliation = runtimeHealth?.reconciliation as Json | undefined | null;
  const reconciliationDetail = rhMeta?.reconciliationDetail as Json | undefined | null;

  const missingLocalOrdersCount = (reconciliationDetail?.missingLocalOrdersCount as number | undefined | null) ?? 0;
  const missingExchangeOrdersCount = (reconciliationDetail?.missingExchangeOrdersCount as number | undefined | null) ?? 0;
  const missingFillsCount = (reconciliationDetail?.missingFillsCount as number | undefined | null) ?? 0;
  const repairedOrdersCount = (reconciliationDetail?.repairedOrdersCount as number | undefined | null) ?? 0;

  const missingExchangeOrdersSample = Array.isArray(reconciliationDetail?.missingExchangeOrdersSample)
    ? (reconciliationDetail?.missingExchangeOrdersSample as unknown[])
    : [];
  const missingFillsSample = Array.isArray(reconciliationDetail?.missingFillsSample)
    ? (reconciliationDetail?.missingFillsSample as unknown[])
    : [];
  const repairedOrdersSample = Array.isArray(reconciliationDetail?.repairedOrdersSample)
    ? (reconciliationDetail?.repairedOrdersSample as unknown[])
    : [];

  const latestDriftReasons: string[] = [];
  if (missingLocalOrdersCount > 0) latestDriftReasons.push("missingLocalOrders");
  if (missingExchangeOrdersCount > 0) latestDriftReasons.push("missingExchangeOrders");
  if (missingFillsCount > 0) latestDriftReasons.push("missingFills");
  if (latestDriftReasons.length === 0) latestDriftReasons.push("unknown_no_sample_counts");

  const driftDetected = reconciliation?.driftDetected === true;
  const reconciliationStatus = asString(reconciliation?.status) ?? null;
  const reconciliationFreshness = asString(reconciliation?.freshness) ?? null;
  const firstDetectedAt = asString(rhMeta?.reconciliationDriftFirstDetectedAt) ?? null;

  // Overlap analysis: if repairedOrders were applied to the same clientOrderIds that still appear as missingExchangeOrders,
  // then driftDetected is likely being computed against a stale mismatch set (pre-fix behavior).
  const repairedSet = new Set(repairedOrdersSample.filter((x) => typeof x === "string") as string[]);
  const missingExchangeClientOrderIds = missingExchangeOrdersSample
    .map((o) => (o && typeof o === "object" ? (o as Record<string, unknown>).clientOrderId : null))
    .filter((x): x is string => typeof x === "string" && x.length > 0);
  const overlap = missingExchangeClientOrderIds.filter((id) => repairedSet.has(id));

  // Recent repair journal entries (durable trace).
  const sinceMs = Number(process.env.RECONCILIATION_DRIFT_FORENSICS_SINCE_MS ?? String(2 * 60 * 60 * 1000)); // default 2h
  const since = new Date(Date.now() - sinceMs);
  const repairEvents = await prisma.orderLifecycleJournalEntry.findMany({
    where: {
      occurredAt: { gte: since },
      eventType: { in: [ORDER_LIFECYCLE_EVENT_TYPES.REPAIR_APPLIED, ORDER_LIFECYCLE_EVENT_TYPES.REPAIR_RECOMMENDED] },
    },
    orderBy: { occurredAt: "desc" },
    take: 200,
    select: {
      id: true,
      eventType: true,
      occurredAt: true,
      clientOrderId: true,
      exchangeOrderId: true,
      assetId: true,
      marketId: true,
      side: true,
      payloadJson: true,
    },
  });

  const repairEventsByType = {
    repair_applied: repairEvents.filter((e) => e.eventType === ORDER_LIFECYCLE_EVENT_TYPES.REPAIR_APPLIED),
    repair_recommended: repairEvents.filter((e) => e.eventType === ORDER_LIFECYCLE_EVENT_TYPES.REPAIR_RECOMMENDED),
  };

  const repairAppliedRows = repairEventsByType.repair_applied;
  const repairAppliedByAssetMarket = groupByAssetMarket(repairAppliedRows);

  const driftIsOrderVsFill: {
    orderMismatch: boolean;
    fillMismatch: boolean;
    exchangeMissingOrders: boolean;
  } = {
    orderMismatch: missingLocalOrdersCount > 0 || missingExchangeOrdersCount > 0,
    fillMismatch: missingFillsCount > 0,
    exchangeMissingOrders: missingExchangeOrdersCount > 0,
  };

  const report = {
    generatedAt,
    workerHeartbeatAt: hb?.lastSeenAt?.toISOString() ?? null,
    runtimeSafetyState: runtimeSafety?.state ?? null,
    liveReadinessBlockingReasons: Array.isArray(liveReadiness?.blockingReasons)
      ? (liveReadiness?.blockingReasons as string[])
      : null,
    reconciliation: {
      driftDetected,
      status: reconciliationStatus,
      freshness: reconciliationFreshness,
      firstDetectedAt,
      counts: {
        missingLocalOrdersCount,
        missingExchangeOrdersCount,
        missingFillsCount,
        repairedOrdersCount,
      },
      latestDriftReasons,
      overlap: {
        repairedSetSize: repairedSet.size,
        missingExchangeClientOrderIdsCount: missingExchangeClientOrderIds.length,
        overlapClientOrderIds: overlap.slice(0, 25),
      },
    },
    mismatchSamples: {
      missingExchangeOrdersSample: missingExchangeOrdersSample.slice(0, 10),
      missingFillsSample: missingFillsSample.slice(0, 10),
      repairedOrdersSample: repairedOrdersSample.slice(0, 10),
    },
    perAssetMarketMismatch: {
      missingExchangeOrdersByAssetMarket: groupByAssetMarket(
        missingExchangeOrdersSample.filter((o) => o && typeof o === "object") as Array<{ assetId?: string; marketId?: string }>
      ),
      missingFillsByAssetMarket: groupByAssetMarket(
        missingFillsSample.filter((o) => o && typeof o === "object") as Array<{ assetId?: string; marketId?: string }>
      ),
    },
    repairEvidence: {
      sinceIso: since.toISOString(),
      totalEvents: repairEvents.length,
      countsByType: {
        repair_applied: repairEventsByType.repair_applied.length,
        repair_recommended: repairEventsByType.repair_recommended.length,
      },
      repairAppliedByAssetMarketCounts: Object.fromEntries(
        Object.entries(repairAppliedByAssetMarket).map(([k, v]) => [k, v.length])
      ),
      latestRepairAppliedEventsSample: repairAppliedRows.slice(0, 10),
    },
    derivedDiagnosis: {
      driftIsOrderVsFill,
      interpretation:
        overlap.length > 0
          ? "Overlap between repairedOrdersSample and missingExchangeOrdersSample suggests driftDetected is being computed against a stale mismatch list that isn't reduced by in-memory repairs."
          : "No overlap in current samples; drift likely persists because repairs are incomplete for the remaining mismatch type(s).",
    },
  };

  const md = [
    "# Reconciliation Drift Forensics Report",
    "",
    `Generated: ${generatedAt}`,
    "",
    "## Current reconciliation drift",
    "",
    `- driftDetected: ${String(report.reconciliation.driftDetected)}`,
    `- status: ${report.reconciliation.status ?? "n/a"}`,
    `- freshness: ${report.reconciliation.freshness ?? "n/a"}`,
    `- firstDetectedAt: ${report.reconciliation.firstDetectedAt ?? "n/a"}`,
    "",
    "### Drift reason counts",
    "",
    "```json",
    JSON.stringify(report.reconciliation.counts, null, 2),
    "```",
    "",
    "## Drift overlap evidence (repaired vs still-missing)",
    "",
    "```json",
    JSON.stringify(report.reconciliation.overlap, null, 2),
    "```",
    "",
    "## Mismatch samples",
    "",
    "### missingExchangeOrdersSample",
    "",
    "```json",
    JSON.stringify(report.mismatchSamples.missingExchangeOrdersSample, null, 2),
    "```",
    "",
    "### missingFillsSample",
    "",
    "```json",
    JSON.stringify(report.mismatchSamples.missingFillsSample, null, 2),
    "```",
    "",
    "## Recent repair evidence (durable journal)",
    "",
    "```json",
    JSON.stringify(report.repairEvidence.countsByType, null, 2),
    "```",
    "",
    "```json",
    JSON.stringify(report.repairEvidence.repairAppliedByAssetMarketCounts, null, 2),
    "```",
    "",
    "## Interpretation",
    "",
    report.derivedDiagnosis.interpretation,
  ].join("\n");

  await fs.writeFile(path.join(DUMP_DIR, "reconciliation-drift-forensics-report.json"), JSON.stringify(report, null, 2));
  await fs.writeFile(path.join(DUMP_DIR, "reconciliation-drift-forensics-report.md"), md);
  console.log("Wrote dump/reconciliation-drift-forensics-report.{json,md}");

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

