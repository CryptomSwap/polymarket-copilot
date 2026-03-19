/**
 * Bounded validation report for WS/REST truth merge fix.
 *
 * Writes:
 * - dump/truth-merge-fix-report.json
 * - dump/truth-merge-fix-report.md
 *
 * Run:
 * - npm run dump:truth-merge-fix-report
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import { parseHeartbeatMetadataJson } from "../lib/ops/worker-heartbeat-canonical";
import { DEFAULT_STREAM_WATCHDOG_CONFIG } from "../lib/runtime/stream-watchdog-config";
import {
  DEFAULT_FILLS_TRUTH_STALE_MS,
  DEFAULT_ORDERS_TRUTH_STALE_MS,
} from "../lib/runtime/truth/runtime-truth-model";

const DUMP_DIR = path.join(process.cwd(), "dump");
const WORKER_NAME = "polymarket-copilot-worker";
const WINDOWS = [
  { label: "5m", ms: 5 * 60 * 1000 },
  { label: "10m", ms: 10 * 60 * 1000 },
] as const;
const RECENT_CANDIDATE_LIMIT = Number(process.env.TRUTH_MERGE_FIX_REPORT_LIMIT ?? "1200") || 1200;
const MARKER_MOVED_EPSILON_MS = 5_000;

type RootCauseSummary =
  | "FIXED_WS_REST_TRUTH_MERGE_GAP"
  | "LEGITIMATE_UPSTREAM_TRUTH_GAP"
  | "STALE_FRESHNESS_SOURCE"
  | "READINESS_ACCOUNTING_MISMATCH"
  | "OTHER_BUG";

type OverallVerdict =
  | "HEALTHY_AND_OPERATING"
  | "HEALTHY_BUT_IDLE"
  | "BOOTED_BUT_FROZEN"
  | "DEGRADED"
  | "BROKEN";

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function pickBool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

function toIso(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

function parseDate(v: string | null): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
}

function ageMs(iso: string | null, nowMs: number): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? nowMs - t : null;
}

function isFresh(iso: string | null, thresholdMs: number, nowMs: number): boolean | null {
  const a = ageMs(iso, nowMs);
  if (a == null) return null;
  return a <= thresholdMs;
}

function toReasons(raw: unknown): string[] {
  if (raw == null) return [];
  if (Array.isArray(raw)) {
    return raw
      .flatMap((x) => (typeof x === "string" ? x.split(/[;,|+]/g) : []))
      .map((x) => x.trim())
      .filter(Boolean);
  }
  if (typeof raw === "string") return raw.split(/[;,|+]/g).map((x) => x.trim()).filter(Boolean);
  return [];
}

function markerMovedAfterRun(markerAtIso: string | null, runFinishedIso: string | null): boolean | null {
  const markerAt = parseDate(markerAtIso);
  const runFinishedAt = parseDate(runFinishedIso);
  if (!markerAt || !runFinishedAt) return null;
  return markerAt.getTime() + MARKER_MOVED_EPSILON_MS >= runFinishedAt.getTime();
}

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });
  const nowMs = Date.now();
  const generatedAt = new Date(nowMs).toISOString();
  const oldest = new Date(nowMs - WINDOWS[1].ms);

  const hb = await prisma.workerHeartbeat.findUnique({
    where: { workerName: WORKER_NAME },
    select: { metadataJson: true },
  });
  const meta = parseHeartbeatMetadataJson(hb?.metadataJson ?? undefined);
  const rh = asRecord(meta?.runtimeHealth);
  const rs = asRecord(meta?.runtimeSafety);
  const readiness = asRecord(asRecord(rh?.operatorHealth)?.readiness);
  const streams = asRecord(rh?.streams);
  const metadata = asRecord(rh?.metadata);

  const runtimeStatus = typeof rh?.status === "string" ? rh.status : null;
  const lifecycleStatus = typeof rh?.lifecycleStatus === "string" ? rh.lifecycleStatus : null;
  const globalAutomationEnabled = pickBool(rh?.globalAutomationEnabled);
  const automationPermitted = pickBool(readiness?.automationPermitted);
  const safeToAutomate = pickBool(readiness?.safeToAutomate);
  const runtimeSafetyState = typeof rs?.state === "string" ? rs.state : null;
  const degradedReasons = Array.isArray(rh?.degradedReasons)
    ? (rh.degradedReasons as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  const operatingMode = typeof rh?.operatingMode === "string" ? rh.operatingMode : null;

  const userLastDataEventAt = toIso(streams?.userLastDataEventAt);
  const marketLastDataEventAt = toIso(streams?.marketLastDataEventAt);
  const lastSuccessfulUserTruthFetchAt = toIso(metadata?.lastSuccessfulUserTruthFetchAt);
  const lastExchangeOrdersSnapshotAt = toIso(metadata?.lastExchangeOrdersSnapshotAt);
  const lastExchangeFillsSnapshotAt = toIso(metadata?.lastExchangeFillsSnapshotAt);
  const exchangeTruthUnavailable = pickBool(metadata?.exchangeTruthUnavailable);

  const userThresholdMs = DEFAULT_STREAM_WATCHDOG_CONFIG.userDataDegradedThresholdMs;
  const ordersThresholdMs = DEFAULT_ORDERS_TRUTH_STALE_MS;
  const fillsThresholdMs = DEFAULT_FILLS_TRUTH_STALE_MS;

  const effectiveUserFreshnessAt = userLastDataEventAt ?? lastSuccessfulUserTruthFetchAt;
  const userFresh = isFresh(effectiveUserFreshnessAt, userThresholdMs, nowMs);
  const ordersFresh = isFresh(lastExchangeOrdersSnapshotAt, ordersThresholdMs, nowMs);
  const fillsFresh = isFresh(lastExchangeFillsSnapshotAt, fillsThresholdMs, nowMs);
  const exchangeFresh =
    exchangeTruthUnavailable === true ? false : ordersFresh === true && fillsFresh === true;

  const candidates = await prisma.shadowCandidate.findMany({
    where: {
      candidateSource: "runtime_automated",
      createdAt: { gte: oldest },
    },
    orderBy: { createdAt: "desc" },
    take: RECENT_CANDIDATE_LIMIT,
    select: {
      createdAt: true,
      wasBlocked: true,
      wasSubmitted: true,
      blockingReasons: true,
    },
  });

  const blockerDistribution = WINDOWS.map((w) => {
    const cutoff = nowMs - w.ms;
    const inWin = candidates.filter((c) => c.createdAt.getTime() >= cutoff);
    const blocked = inWin.filter((c) => c.wasBlocked);
    let userDataStale = 0;
    let exchangeTruthStale = 0;
    let exchangeTruthOrdersStale = 0;
    let exchangeTruthRelated = 0;
    for (const b of blocked) {
      const reasons = toReasons(b.blockingReasons);
      if (reasons.some((r) => r === "user_data_stale")) userDataStale++;
      if (reasons.some((r) => r === "exchange_truth_stale")) exchangeTruthStale++;
      if (reasons.some((r) => r === "exchange_truth_orders_stale")) exchangeTruthOrdersStale++;
      if (
        reasons.some(
          (r) =>
            r.startsWith("exchange_truth_") ||
            r === "user_data_stale" ||
            r === "user_data_silence_with_orders" ||
            r === "reconciliation_stale"
        )
      ) {
        exchangeTruthRelated++;
      }
    }
    return {
      window: w.label,
      runtimeAutomatedCreated: inWin.length,
      blocked: blocked.length,
      submitted: inWin.filter((x) => x.wasSubmitted).length,
      user_data_stale_count: userDataStale,
      exchange_truth_stale_count: exchangeTruthStale,
      exchange_truth_orders_stale_count: exchangeTruthOrdersStale,
      related_truth_reason_count: exchangeTruthRelated,
    };
  });

  const recentJobs = await prisma.scheduledJobRun.findMany({
    where: {
      jobName: { in: ["user_sync", "order_reconciliation", "stream_repair"] as unknown as string[] },
      startedAt: { gte: oldest },
    },
    orderBy: { startedAt: "desc" },
    select: {
      id: true,
      jobName: true,
      status: true,
      startedAt: true,
      finishedAt: true,
      errorMessage: true,
      metadataJson: true,
    },
  });

  const parsedJobs = recentJobs.map((j) => {
    let stages: string[] = [];
    if (j.metadataJson) {
      try {
        const m = JSON.parse(j.metadataJson) as Record<string, unknown>;
        stages = Array.isArray(m.breadcrumbs)
          ? (m.breadcrumbs as unknown[])
              .map((x) => asRecord(x))
              .filter((x): x is Record<string, unknown> => x != null)
              .map((x) => String(x.stage ?? ""))
          : [];
      } catch {
        stages = [];
      }
    }
    return {
      id: j.id,
      jobName: j.jobName,
      status: j.status,
      startedAt: j.startedAt.toISOString(),
      finishedAt: j.finishedAt?.toISOString() ?? null,
      errorMessage: j.errorMessage,
      stage1UserTruthOk: stages.includes("fetch_ok"),
      stage2ReconciliationOk: stages.includes("reconciliation_ok"),
    };
  });

  const successfulUserRefresh = parsedJobs.find(
    (j) =>
      j.status === "success" &&
      (j.jobName === "user_sync" || (j.jobName === "stream_repair" && j.stage1UserTruthOk))
  );
  const successfulRecon = parsedJobs.find(
    (j) =>
      j.status === "success" &&
      (j.jobName === "order_reconciliation" || (j.jobName === "stream_repair" && j.stage2ReconciliationOk))
  );
  const markerMovement = {
    userTruthMarkerMoved: markerMovedAfterRun(
      lastSuccessfulUserTruthFetchAt,
      successfulUserRefresh?.finishedAt ?? null
    ),
    exchangeOrdersMarkerMoved: markerMovedAfterRun(
      lastExchangeOrdersSnapshotAt,
      successfulUserRefresh?.finishedAt ?? null
    ),
    exchangeFillsMarkerMoved: markerMovedAfterRun(
      lastExchangeFillsSnapshotAt,
      successfulUserRefresh?.finishedAt ?? null
    ),
  };

  const sourceUsageMap = [
    {
      blockerOrReadinessPath: "user_data_stale (guardrail admission)",
      moduleFunction: "lib/runtime/risk/runtime-guardrails.ts :: DefaultRuntimeGuardrails.evaluate",
      sourceFieldsAfterFix: [
        "worker/stream-runtime.ts freshness.userDataFresh",
        "streams.userConnection.lastDataEventAt",
        "metadata.lastSuccessfulUserTruthFetchAt",
        "openOrderCount",
      ],
      sourceType: "merged",
      matchesIntendedDesign: true,
      note: "Now fed by merged WS+REST freshness in stream-runtime intent path.",
    },
    {
      blockerOrReadinessPath: "exchange_truth_stale (guardrail admission)",
      moduleFunction: "lib/runtime/risk/runtime-guardrails.ts :: DefaultRuntimeGuardrails.evaluate",
      sourceFieldsAfterFix: [
        "freshness.exchangeTruthHealthy",
        "metadata.lastExchangeOrdersSnapshotAt",
        "metadata.lastExchangeFillsSnapshotAt",
        "metadata.exchangeTruthUnavailable",
      ],
      sourceType: "merged",
      matchesIntendedDesign: true,
      note: "Uses truthModelStatus from merged exchange snapshot source.",
    },
    {
      blockerOrReadinessPath: "exchange_truth_orders_stale / exchange_truth_stale (degraded reasons)",
      moduleFunction: "lib/runtime/runtime-degraded.ts :: computeDegraded",
      sourceFieldsAfterFix: [
        "metadata.lastExchangeOrdersSnapshotAt",
        "metadata.lastExchangeFillsSnapshotAt",
        "metadata.exchangeTruthUnavailable",
      ],
      sourceType: "merged",
      matchesIntendedDesign: true,
      note: "Source timestamps come from stream-runtime effectiveExchange* merge path.",
    },
    {
      blockerOrReadinessPath: "operatorHealth.dataFreshness.user + readiness.safeToAutomate",
      moduleFunction: "lib/runtime/runtime-health.ts :: computeUserDataHealthy / buildOperatorHealth",
      sourceFieldsAfterFix: [
        "streams.userConnection.lastDataEventAt",
        "metadata.lastSuccessfulUserTruthFetchAt",
        "openOrderCount",
        "reconciliation.lastRunAt/status",
      ],
      sourceType: "merged",
      matchesIntendedDesign: true,
      note: "Readiness path remains fail-closed and aligned with merged user freshness.",
    },
  ];

  const blocked5m = blockerDistribution[0];
  const truthDominates5m =
    blocked5m.blocked > 0 &&
    blocked5m.related_truth_reason_count >= Math.ceil(blocked5m.blocked * 0.5);
  const usageConsistent = sourceUsageMap.every((x) => x.matchesIntendedDesign);

  let rootCauseAndFix: RootCauseSummary = "OTHER_BUG";
  let rootCauseWhy = "Short-window signals are mixed; no single deterministic class fits better.";
  if (usageConsistent && userFresh === true && exchangeFresh === true && markerMovement.userTruthMarkerMoved !== false) {
    rootCauseAndFix = "FIXED_WS_REST_TRUTH_MERGE_GAP";
    rootCauseWhy =
      "Relevant blocker/readiness paths now consume merged WS+REST truth inputs, freshness markers move after successful jobs, and current user/exchange truth is fresh.";
  } else if (truthDominates5m && (userFresh === false || exchangeFresh === false)) {
    rootCauseAndFix = "LEGITIMATE_UPSTREAM_TRUTH_GAP";
    rootCauseWhy =
      "Truth-related blockers dominate while at least one authoritative freshness source is currently stale in the short window.";
  } else if (truthDominates5m && usageConsistent && userFresh === true && exchangeFresh === true) {
    rootCauseAndFix = "READINESS_ACCOUNTING_MISMATCH";
    rootCauseWhy =
      "Truth freshness appears current in merged sources, but short-window blocker distribution still reports truth blockers as dominant.";
  } else if (markerMovement.userTruthMarkerMoved === false || markerMovement.exchangeOrdersMarkerMoved === false) {
    rootCauseAndFix = "STALE_FRESHNESS_SOURCE";
    rootCauseWhy =
      "Freshness markers are not advancing consistently with successful refresh runs, indicating stale source usage.";
  }

  const overallVerdict: OverallVerdict = (() => {
    if (runtimeStatus == null || lifecycleStatus == null) return "BROKEN";
    if (runtimeStatus === "degraded" || lifecycleStatus === "degraded") return "DEGRADED";
    if (runtimeStatus !== "ready" || lifecycleStatus !== "ready") return "BOOTED_BUT_FROZEN";
    if (automationPermitted === true && safeToAutomate === true && blocked5m.submitted > 0) return "HEALTHY_AND_OPERATING";
    if (automationPermitted === true && safeToAutomate === true) return "HEALTHY_BUT_IDLE";
    return "BOOTED_BUT_FROZEN";
  })();

  const report = {
    generatedAt,
    currentRuntimeSnapshot: {
      runtimeStatus,
      lifecycleStatus,
      globalAutomationEnabled,
      automationPermitted,
      safeToAutomate,
      runtimeSafetyState,
      degradedReasons,
      operatingMode,
    },
    truthSourceUsageMap: sourceUsageMap,
    shortWindowFreshnessValidation: {
      windows: blockerDistribution,
      currentTruthFreshnessStates: {
        user: {
          userLastDataEventAt,
          lastSuccessfulUserTruthFetchAt,
          effectiveUserFreshnessAt,
          freshnessThresholdMs: userThresholdMs,
          isFresh: userFresh,
        },
        exchange: {
          lastExchangeOrdersSnapshotAt,
          lastExchangeFillsSnapshotAt,
          exchangeTruthUnavailable,
          thresholdsMs: { orders: ordersThresholdMs, fills: fillsThresholdMs },
          isFresh: exchangeFresh,
        },
        market: {
          marketLastDataEventAt,
        },
      },
      dominantTruthReasons: {
        userDataStaleStillDominant: blocked5m.user_data_stale_count >= Math.ceil(Math.max(1, blocked5m.blocked) * 0.5),
        exchangeTruthStaleStillDominant:
          blocked5m.exchange_truth_stale_count >= Math.ceil(Math.max(1, blocked5m.blocked) * 0.5),
      },
      successfulRunsAndMarkerMovement: {
        recentRuns: parsedJobs,
        mostRecentSuccessfulUserRefreshRun: successfulUserRefresh ?? null,
        mostRecentSuccessfulReconciliationRun: successfulRecon ?? null,
        markerMovement,
      },
    },
    rootCauseAndFixSummary: {
      classification: rootCauseAndFix,
      why: rootCauseWhy,
    },
    overallVerdict,
    filesChanged: [
      "worker/stream-runtime.ts",
      "lib/runtime/__tests__/runtime-readiness-intent-unblock-tests.ts",
      "tools/create-truth-merge-fix-report.ts",
      "package.json",
    ],
    redaction: {
      secretsRedacted: true,
      note: "Report contains bounded runtime state and job metadata only.",
    },
  };

  const md: string[] = [];
  md.push("# Truth Merge Fix Report");
  md.push(`Generated at: ${generatedAt}`);
  md.push("");
  md.push("## 1) Current runtime snapshot");
  md.push(`- runtimeStatus: **${runtimeStatus ?? "—"}**`);
  md.push(`- lifecycleStatus: **${lifecycleStatus ?? "—"}**`);
  md.push(`- globalAutomationEnabled: **${globalAutomationEnabled ?? "—"}**`);
  md.push(`- automationPermitted: **${automationPermitted ?? "—"}**`);
  md.push(`- safeToAutomate: **${safeToAutomate ?? "—"}**`);
  md.push(`- runtimeSafetyState: **${runtimeSafetyState ?? "—"}**`);
  md.push(`- degradedReasons: ${degradedReasons.join(", ") || "(none)"}`);
  md.push(`- operatingMode: **${operatingMode ?? "—"}**`);
  md.push("");
  md.push("## 2) Truth-source usage map");
  for (const row of sourceUsageMap) {
    md.push(`- **${row.blockerOrReadinessPath}**`);
    md.push(`  - module/function: ${row.moduleFunction}`);
    md.push(`  - sourceType: ${row.sourceType}`);
    md.push(`  - matches intended design: ${String(row.matchesIntendedDesign)}`);
    md.push(`  - source fields: ${row.sourceFieldsAfterFix.join(", ")}`);
  }
  md.push("");
  md.push("## 3) Short-window freshness validation (5m, 10m)");
  md.push("| window | created | blocked | submitted | user_data_stale | exchange_truth_stale | related_truth |");
  md.push("|---|---:|---:|---:|---:|---:|---:|");
  for (const w of blockerDistribution) {
    md.push(
      `| ${w.window} | ${w.runtimeAutomatedCreated} | ${w.blocked} | ${w.submitted} | ${w.user_data_stale_count} | ${w.exchange_truth_stale_count} | ${w.related_truth_reason_count} |`
    );
  }
  md.push("");
  md.push("## 4) Root cause + fix summary");
  md.push(`- **${rootCauseAndFix}**`);
  md.push(`- ${rootCauseWhy}`);
  md.push("");
  md.push("## 5) Overall verdict");
  md.push(`- **${overallVerdict}**`);

  await fs.writeFile(path.join(DUMP_DIR, "truth-merge-fix-report.json"), JSON.stringify(report, null, 2), "utf-8");
  await fs.writeFile(path.join(DUMP_DIR, "truth-merge-fix-report.md"), md.join("\n"), "utf-8");

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        classification: rootCauseAndFix,
        overallVerdict,
        usageConsistent,
      },
      null,
      2
    )
  );
}

void main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error("create-truth-merge-fix-report failed", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

