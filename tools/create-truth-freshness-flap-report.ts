/**
 * Bounded short-window truth freshness stability audit.
 *
 * Writes:
 * - dump/truth-freshness-flap-report.json
 * - dump/truth-freshness-flap-report.md
 *
 * Run:
 * - npm run dump:truth-freshness-flap-report
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
const RECONCILE_FRESHNESS_MS = 120_000;
const WINDOWS = [
  { label: "5m", ms: 5 * 60 * 1000 },
  { label: "10m", ms: 10 * 60 * 1000 },
  { label: "30m", ms: 30 * 60 * 1000 },
] as const;
const RECENT_CANDIDATE_LIMIT = Number(process.env.TRUTH_FRESHNESS_FLAP_RECENT_LIMIT ?? "1200") || 1200;
const MARKER_MOVED_EPSILON_MS = 5_000;

type RootCause =
  | "LEGITIMATE_UPSTREAM_DATA_GAP"
  | "MISSING_FRESHNESS_TIMESTAMP_UPDATE"
  | "STALE_FRESHNESS_SOURCE"
  | "READINESS_ACCOUNTING_MISMATCH"
  | "WS_REST_TRUTH_MERGE_GAP"
  | "LATCHING_OR_CLEARING_BUG"
  | "OTHER_BUG";

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function pickBool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
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

function toIso(v: unknown): string | null {
  if (typeof v === "string" && v.trim().length > 0) return v;
  return null;
}

function parseDate(v: unknown): Date | null {
  const s = toIso(v);
  if (!s) return null;
  const t = new Date(s);
  return Number.isFinite(t.getTime()) ? t : null;
}

function ageMs(iso: string | null, nowMs: number): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? nowMs - t : null;
}

function isFresh(iso: string | null, thresholdMs: number, nowMs: number): boolean | null {
  const age = ageMs(iso, nowMs);
  if (age == null) return null;
  return age <= thresholdMs;
}

function signalState(iso: string | null, thresholdMs: number, nowMs: number): "current" | "stale" | "missing" {
  if (!iso) return "missing";
  const age = ageMs(iso, nowMs);
  if (age == null) return "missing";
  return age <= thresholdMs ? "current" : "stale";
}

function markerMovedAfterRun(markerAt: Date | null, runFinishedAt: Date | null): boolean | null {
  if (!markerAt || !runFinishedAt) return null;
  return markerAt.getTime() + MARKER_MOVED_EPSILON_MS >= runFinishedAt.getTime();
}

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });
  const nowMs = Date.now();
  const generatedAt = new Date(nowMs).toISOString();
  const oldest30m = new Date(nowMs - WINDOWS[2].ms);

  const hb = await prisma.workerHeartbeat.findUnique({
    where: { workerName: WORKER_NAME },
    select: { lastSeenAt: true, metadataJson: true },
  });
  const meta = parseHeartbeatMetadataJson(hb?.metadataJson ?? undefined);
  const rh = asRecord(meta?.runtimeHealth);
  const rs = asRecord(meta?.runtimeSafety);
  const readiness = asRecord(asRecord(rh?.operatorHealth)?.readiness);
  const streams = asRecord(rh?.streams);
  const metadata = asRecord(rh?.metadata);
  const diagnostics = asRecord(rh?.diagnostics);
  const truthModelStatus = asRecord(rh?.truthModelStatus);

  const runtimeStatus = typeof rh?.status === "string" ? rh.status : null;
  const lifecycleStatus = typeof rh?.lifecycleStatus === "string" ? rh.lifecycleStatus : null;
  const runtimeMarkedReady = runtimeStatus === "ready" || lifecycleStatus === "ready";
  const globalAutomationEnabled = pickBool(rh?.globalAutomationEnabled);
  const automationPermitted = pickBool(readiness?.automationPermitted);
  const safeToAutomate = pickBool(readiness?.safeToAutomate);
  const runtimeSafetyState = typeof rs?.state === "string" ? rs.state : null;
  const degradedReasons = Array.isArray(rh?.degradedReasons)
    ? (rh?.degradedReasons as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  const operatingMode = typeof rh?.operatingMode === "string" ? rh.operatingMode : null;

  const marketLastDataEventAt = toIso(streams?.marketLastDataEventAt);
  const userLastDataEventAt = toIso(streams?.userLastDataEventAt);
  const userWsStatus = typeof asRecord(streams?.userConnection)?.status === "string"
    ? (asRecord(streams?.userConnection)?.status as string)
    : null;

  const lastSuccessfulUserTruthFetchAt = toIso(metadata?.lastSuccessfulUserTruthFetchAt);
  const lastExchangeOrdersSnapshotAt = toIso(metadata?.lastExchangeOrdersSnapshotAt);
  const lastExchangeFillsSnapshotAt = toIso(metadata?.lastExchangeFillsSnapshotAt);
  const exchangeTruthUnavailable = pickBool(metadata?.exchangeTruthUnavailable);
  const exchangeTruthTransientGraceApplied = pickBool(metadata?.exchangeTruthTransientGraceApplied);
  const exchangeTruthTransientGraceReason =
    typeof metadata?.exchangeTruthTransientGraceReason === "string"
      ? (metadata.exchangeTruthTransientGraceReason as string)
      : null;

  const lastRuntimeReconciliationAt = toIso(diagnostics?.lastRuntimeReconciliationAt);
  const lastRuntimeReconciliationStatus =
    typeof diagnostics?.lastRuntimeReconciliationStatus === "string"
      ? (diagnostics.lastRuntimeReconciliationStatus as string)
      : null;
  const runtimeReconciliationRuns =
    typeof diagnostics?.runtimeReconciliationRuns === "number"
      ? (diagnostics.runtimeReconciliationRuns as number)
      : null;
  const runtimeReconciliationFailures =
    typeof diagnostics?.runtimeReconciliationFailures === "number"
      ? (diagnostics.runtimeReconciliationFailures as number)
      : null;

  const userThresholdMs = DEFAULT_STREAM_WATCHDOG_CONFIG.userDataDegradedThresholdMs;
  const exchangeOrdersThresholdMs = DEFAULT_ORDERS_TRUTH_STALE_MS;
  const exchangeFillsThresholdMs = DEFAULT_FILLS_TRUTH_STALE_MS;

  const userCurrentIso = userLastDataEventAt ?? lastSuccessfulUserTruthFetchAt;
  const userCurrentSource = userLastDataEventAt
    ? "worker/stream-runtime.ts: stream userConnection.lastDataEventAt (WS data)"
    : lastSuccessfulUserTruthFetchAt
      ? "lib/live/user-truth-freshness.ts via user_sync/stream_repair (REST truth)"
      : "none";
  const userCurrentAgeMs = ageMs(userCurrentIso, nowMs);
  const userCurrentIsFresh = isFresh(userCurrentIso, userThresholdMs, nowMs);
  const userSignalState = signalState(userCurrentIso, userThresholdMs, nowMs);

  const ordersFresh = isFresh(lastExchangeOrdersSnapshotAt, exchangeOrdersThresholdMs, nowMs);
  const fillsFresh = isFresh(lastExchangeFillsSnapshotAt, exchangeFillsThresholdMs, nowMs);
  const exchangeCurrentFresh =
    exchangeTruthUnavailable === true
      ? false
      : ordersFresh === true && fillsFresh === true;
  const exchangeSignalState =
    exchangeTruthUnavailable === true
      ? "stale"
      : (signalState(lastExchangeOrdersSnapshotAt, exchangeOrdersThresholdMs, nowMs) === "current" &&
          signalState(lastExchangeFillsSnapshotAt, exchangeFillsThresholdMs, nowMs) === "current")
        ? "current"
        : (lastExchangeOrdersSnapshotAt == null || lastExchangeFillsSnapshotAt == null)
          ? "missing"
          : "stale";

  const candidates = await prisma.shadowCandidate.findMany({
    where: {
      candidateSource: "runtime_automated",
      createdAt: { gte: oldest30m },
    },
    orderBy: { createdAt: "desc" },
    take: RECENT_CANDIDATE_LIMIT,
    select: {
      id: true,
      createdAt: true,
      wasBlocked: true,
      wasSubmitted: true,
      blockingReasons: true,
    },
  });

  const reasonCountersByWindow = WINDOWS.map((w) => {
    const cutoff = nowMs - w.ms;
    const inWin = candidates.filter((c) => c.createdAt.getTime() >= cutoff);
    const blocked = inWin.filter((c) => c.wasBlocked);
    let userDataStale = 0;
    let exchangeTruthStale = 0;
    let relatedFreshnessSignals = 0;
    for (const c of blocked) {
      const rsn = toReasons(c.blockingReasons);
      if (rsn.some((r) => r.includes("user_data_stale"))) userDataStale++;
      if (rsn.some((r) => r.includes("exchange_truth_stale"))) exchangeTruthStale++;
      if (
        rsn.some(
          (r) =>
            r.includes("exchange_truth_orders_stale") ||
            r.includes("exchange_truth_fills_stale") ||
            r.includes("exchange_truth_unavailable") ||
            r.includes("user_data_silence") ||
            r.includes("reconciliation_stale") ||
            r.includes("market_data_stale")
        )
      ) {
        relatedFreshnessSignals++;
      }
    }
    return {
      window: w.label,
      runtimeAutomatedCreated: inWin.length,
      blocked: blocked.length,
      submitted: inWin.filter((c) => c.wasSubmitted).length,
      user_data_stale_count: userDataStale,
      exchange_truth_stale_count: exchangeTruthStale,
      related_freshness_signals_count: relatedFreshnessSignals,
    };
  });

  const recentJobs = await prisma.scheduledJobRun.findMany({
    where: {
      jobName: { in: ["user_sync", "order_reconciliation", "stream_repair"] as unknown as string[] },
      startedAt: { gte: oldest30m },
    },
    orderBy: { startedAt: "desc" },
    select: {
      id: true,
      jobName: true,
      status: true,
      startedAt: true,
      finishedAt: true,
      durationMs: true,
      errorMessage: true,
      metadataJson: true,
    },
  });

  const parsedJobs = recentJobs.map((j) => {
    let metadataJson: Record<string, unknown> | null = null;
    try {
      metadataJson = j.metadataJson ? (JSON.parse(j.metadataJson) as Record<string, unknown>) : null;
    } catch {
      metadataJson = null;
    }
    const breadcrumbs = Array.isArray(metadataJson?.breadcrumbs)
      ? (metadataJson?.breadcrumbs as unknown[])
      : [];
    const stages = breadcrumbs
      .map((b) => asRecord(b))
      .filter((b): b is Record<string, unknown> => b != null)
      .map((b) => String(b.stage ?? ""));
    const hasFetchOk = stages.includes("fetch_ok");
    const hasReconciliationOk = stages.includes("reconciliation_ok");
    const stage1Ok = j.jobName === "stream_repair" ? hasFetchOk : null;
    const stage2Ok = j.jobName === "stream_repair" ? hasReconciliationOk : null;
    return {
      id: j.id,
      jobName: j.jobName,
      status: j.status,
      startedAt: j.startedAt.toISOString(),
      finishedAt: j.finishedAt?.toISOString() ?? null,
      durationMs: j.durationMs,
      errorMessage: j.errorMessage,
      stage1UserTruthOk: stage1Ok,
      stage2ReconciliationOk: stage2Ok,
    };
  });

  const userMarkerDate = parseDate(lastSuccessfulUserTruthFetchAt);
  const exchangeOrdersMarkerDate = parseDate(lastExchangeOrdersSnapshotAt);
  const exchangeFillsMarkerDate = parseDate(lastExchangeFillsSnapshotAt);
  const reconciliationMarkerDate = parseDate(lastRuntimeReconciliationAt);

  const successfulUserRefreshRuns = parsedJobs.filter(
    (j) =>
      j.status === "success" &&
      (j.jobName === "user_sync" || (j.jobName === "stream_repair" && j.stage1UserTruthOk === true))
  );
  const successfulReconRuns = parsedJobs.filter(
    (j) =>
      j.status === "success" &&
      (j.jobName === "order_reconciliation" || (j.jobName === "stream_repair" && j.stage2ReconciliationOk === true))
  );

  const markerMovementEvidence = {
    userTruthMarker: {
      markerAt: lastSuccessfulUserTruthFetchAt,
      movedAfterMostRecentSuccessfulRefreshRun: markerMovedAfterRun(
        userMarkerDate,
        successfulUserRefreshRuns[0]?.finishedAt ? new Date(successfulUserRefreshRuns[0].finishedAt) : null
      ),
      mostRecentSuccessfulRefreshRun: successfulUserRefreshRuns[0] ?? null,
    },
    exchangeOrdersMarker: {
      markerAt: lastExchangeOrdersSnapshotAt,
      movedAfterMostRecentSuccessfulRefreshRun: markerMovedAfterRun(
        exchangeOrdersMarkerDate,
        successfulUserRefreshRuns[0]?.finishedAt ? new Date(successfulUserRefreshRuns[0].finishedAt) : null
      ),
      mostRecentSuccessfulRefreshRun: successfulUserRefreshRuns[0] ?? null,
    },
    exchangeFillsMarker: {
      markerAt: lastExchangeFillsSnapshotAt,
      movedAfterMostRecentSuccessfulRefreshRun: markerMovedAfterRun(
        exchangeFillsMarkerDate,
        successfulUserRefreshRuns[0]?.finishedAt ? new Date(successfulUserRefreshRuns[0].finishedAt) : null
      ),
      mostRecentSuccessfulRefreshRun: successfulUserRefreshRuns[0] ?? null,
    },
    reconciliationMarker: {
      markerAt: lastRuntimeReconciliationAt,
      movedAfterMostRecentSuccessfulReconciliationRun: markerMovedAfterRun(
        reconciliationMarkerDate,
        successfulReconRuns[0]?.finishedAt ? new Date(successfulReconRuns[0].finishedAt) : null
      ),
      mostRecentSuccessfulReconciliationRun: successfulReconRuns[0] ?? null,
    },
  };

  const blocked5m = reasonCountersByWindow.find((w) => w.window === "5m");
  const freshnessDominates5m =
    !!blocked5m &&
    blocked5m.blocked > 0 &&
    blocked5m.user_data_stale_count + blocked5m.exchange_truth_stale_count >= Math.ceil(blocked5m.blocked * 0.5);

  const anySuccessfulUserRefreshIn5m = successfulUserRefreshRuns.some(
    (r) => new Date(r.startedAt).getTime() >= nowMs - WINDOWS[0].ms
  );
  const anySuccessfulReconIn5m = successfulReconRuns.some(
    (r) => new Date(r.startedAt).getTime() >= nowMs - WINDOWS[0].ms
  );
  const failedUserRefresh5m = parsedJobs.filter(
    (j) =>
      (j.jobName === "user_sync" || j.jobName === "stream_repair") &&
      j.status === "failure" &&
      new Date(j.startedAt).getTime() >= nowMs - WINDOWS[0].ms
  );
  const failedUserRefresh10m = parsedJobs.filter(
    (j) =>
      (j.jobName === "user_sync" || j.jobName === "stream_repair") &&
      j.status === "failure" &&
      new Date(j.startedAt).getTime() >= nowMs - WINDOWS[1].ms
  );
  const hasPoolTimeoutFailures =
    failedUserRefresh10m.some((j) => /connection pool|Timed out fetching a new connection/i.test(j.errorMessage ?? ""));

  const userMarkerDidNotMoveAfterSuccess =
    markerMovementEvidence.userTruthMarker.movedAfterMostRecentSuccessfulRefreshRun === false;
  const exchangeMarkerDidNotMoveAfterSuccess =
    markerMovementEvidence.exchangeOrdersMarker.movedAfterMostRecentSuccessfulRefreshRun === false ||
    markerMovementEvidence.exchangeFillsMarker.movedAfterMostRecentSuccessfulRefreshRun === false;
  const staleSignalsWhileReady =
    runtimeMarkedReady &&
    globalAutomationEnabled === true &&
    automationPermitted === true &&
    safeToAutomate === true &&
    (blocked5m?.user_data_stale_count ?? 0) + (blocked5m?.exchange_truth_stale_count ?? 0) > 0;
  const userWsOpenButNoDataYetTruthFresh =
    userWsStatus === "open" &&
    userLastDataEventAt == null &&
    lastSuccessfulUserTruthFetchAt != null &&
    isFresh(lastSuccessfulUserTruthFetchAt, userThresholdMs, nowMs) === true;

  let rootCause: RootCause = "OTHER_BUG";
  let why = "Insufficient deterministic short-window evidence for a narrower classifier.";
  if ((userMarkerDidNotMoveAfterSuccess || exchangeMarkerDidNotMoveAfterSuccess) && freshnessDominates5m) {
    rootCause = "MISSING_FRESHNESS_TIMESTAMP_UPDATE";
    why =
      "Successful short-window refresh jobs are present, but one or more freshness markers did not advance at/after the most recent successful run.";
  } else if (
    userCurrentIsFresh === false &&
    (failedUserRefresh5m.length > 0 || failedUserRefresh10m.length > 0) &&
    markerMovementEvidence.userTruthMarker.movedAfterMostRecentSuccessfulRefreshRun === true
  ) {
    rootCause = "STALE_FRESHNESS_SOURCE";
    why = hasPoolTimeoutFailures
      ? "User freshness marker advances on successful runs, but repeated short-window user_sync/stream_repair failures (including DB connection-pool timeout failures) allow that marker to age out and become stale."
      : "User freshness marker advances on successful runs, but repeated short-window user truth refresh failures allow the active marker source to age out.";
  } else if (staleSignalsWhileReady && userWsOpenButNoDataYetTruthFresh) {
    rootCause = "WS_REST_TRUTH_MERGE_GAP";
    why =
      "Runtime is otherwise ready and user REST truth is fresh, but blocker path still depends on WS-only freshness in this short window.";
  } else if (staleSignalsWhileReady && userCurrentIsFresh === true && exchangeCurrentFresh === true) {
    rootCause = "READINESS_ACCOUNTING_MISMATCH";
    why =
      "Freshness markers are currently fresh while stale blockers still dominate in the short window, indicating accounting mismatch or lagged blocker attribution.";
  } else if (freshnessDominates5m && !anySuccessfulUserRefreshIn5m && !anySuccessfulReconIn5m) {
    rootCause = "LEGITIMATE_UPSTREAM_DATA_GAP";
    why =
      "Freshness blockers dominate and there is no successful short-window refresh/reconciliation evidence to advance the relevant markers.";
  } else if (freshnessDominates5m && exchangeTruthUnavailable === true && exchangeTruthTransientGraceApplied === true) {
    rootCause = "LATCHING_OR_CLEARING_BUG";
    why =
      "exchangeTruthUnavailable remains asserted while transient grace indicates recent truth snapshots should permit temporary continuity.";
  } else if (freshnessDominates5m && (userCurrentIsFresh === false || exchangeCurrentFresh === false)) {
    rootCause = "STALE_FRESHNESS_SOURCE";
    why =
      "Freshness blockers dominate and source timestamps currently used by guardrails are themselves stale in the short window.";
  }

  const nextFixTarget = (() => {
    switch (rootCause) {
      case "MISSING_FRESHNESS_TIMESTAMP_UPDATE":
        return "lib/ops/scheduled-jobs.ts freshness marker updates on successful runs";
      case "STALE_FRESHNESS_SOURCE":
        return "worker/stream-runtime.ts freshness source selection for guardrails";
      case "READINESS_ACCOUNTING_MISMATCH":
        return "worker/stream-runtime.ts blocker attribution vs readiness snapshot consistency";
      case "WS_REST_TRUTH_MERGE_GAP":
        return "worker/stream-runtime.ts user WS + REST truth merge path";
      case "LATCHING_OR_CLEARING_BUG":
        return "worker/stream-runtime.ts exchangeTruthUnavailable latch/clear transitions";
      case "LEGITIMATE_UPSTREAM_DATA_GAP":
        return "upstream user/exchange truth acquisition reliability (no policy changes)";
      default:
        return "short-window freshness telemetry instrumentation in report pipeline";
    }
  })();

  const report = {
    generatedAt,
    boundedWindow: {
      primary: "5m",
      comparison: "10m",
      optional: "30m",
    },
    currentRuntimeSnapshot: {
      runtimeStatus,
      lifecycleStatus,
      runtimeMarkedReady,
      globalAutomationEnabled,
      automationPermitted,
      safeToAutomate,
      runtimeSafetyState,
      degradedReasons,
      operatingMode,
    },
    truthFreshnessBreakdown: {
      userTruth: {
        currentFreshnessState: userCurrentIsFresh === true ? "fresh" : userCurrentIsFresh === false ? "stale" : "unknown",
        timestampsUsed: {
          userLastDataEventAt,
          lastSuccessfulUserTruthFetchAt,
          effectiveUserFreshnessTimestamp: userCurrentIso,
        },
        freshnessThresholdMs: userThresholdMs,
        timestampSourceModules: {
          userLastDataEventAt: "worker/stream-runtime.ts (stream runtime status)",
          lastSuccessfulUserTruthFetchAt: "lib/live/user-truth-freshness.ts (set by scheduled jobs)",
          effectiveUserFreshnessTimestamp: userCurrentSource,
        },
        consideredFresh: userCurrentIsFresh,
        signalState: userSignalState,
        ageMs: userCurrentAgeMs,
      },
      exchangeTruth: {
        currentFreshnessState: exchangeCurrentFresh ? "fresh" : "stale",
        timestampsUsed: {
          lastExchangeOrdersSnapshotAt,
          lastExchangeFillsSnapshotAt,
          exchangeTruthUnavailable,
        },
        freshnessThresholdMs: {
          orders: exchangeOrdersThresholdMs,
          fills: exchangeFillsThresholdMs,
        },
        timestampSourceModules: {
          lastExchangeOrdersSnapshotAt:
            "worker/stream-runtime.ts + lib/live/exchange-truth-snapshots.ts (merged in runtime)",
          lastExchangeFillsSnapshotAt:
            "worker/stream-runtime.ts + lib/live/exchange-truth-snapshots.ts (merged in runtime)",
          exchangeTruthUnavailable: "worker/stream-runtime.ts exchange truth pull outcomes",
        },
        consideredFresh: exchangeCurrentFresh,
        signalState: exchangeSignalState,
        agesMs: {
          orders: ageMs(lastExchangeOrdersSnapshotAt, nowMs),
          fills: ageMs(lastExchangeFillsSnapshotAt, nowMs),
        },
        transientGrace: {
          applied: exchangeTruthTransientGraceApplied,
          reason: exchangeTruthTransientGraceReason,
        },
      },
    },
    freshnessSignalProvenance: {
      user_data_stale: {
        producedBy: "lib/runtime/risk/runtime-guardrails.ts :: DefaultRuntimeGuardrails.evaluate",
        inputFields: [
          "freshness.userDataFresh",
          "freshness.openOrderCount",
          "freshness.runtimePhase",
        ],
        upstreamTimestampFields: [
          "streams.userConnection.lastDataEventAt",
          "metadata.lastSuccessfulUserTruthFetchAt (watchdog/degraded path)",
        ],
        timestampUpdatePaths: {
          ws: "user stream updates userConnection.lastDataEventAt",
          restSync: "lib/ops/scheduled-jobs.ts user_sync/stream_repair -> setLastSuccessfulUserTruthFetchAt",
          reconciliation: "not a primary source for user_data_stale",
          snapshotBookkeeping: "worker heartbeat metadata emission in worker/stream-runtime.ts",
        },
        valuesAppearCurrentNow: userCurrentIsFresh,
      },
      exchange_truth_stale: {
        producedBy: [
          "lib/runtime/runtime-degraded.ts :: computeDegraded (exchange_truth_orders_stale/fills_stale -> exchange_truth_stale)",
          "lib/runtime/risk/runtime-guardrails.ts :: DefaultRuntimeGuardrails.evaluate (freshness.exchangeTruthHealthy=false with open orders)",
        ],
        inputFields: [
          "metadata.lastExchangeOrdersSnapshotAt",
          "metadata.lastExchangeFillsSnapshotAt",
          "metadata.exchangeTruthUnavailable",
          "freshness.exchangeTruthHealthy",
          "freshness.openOrderCount",
        ],
        timestampUpdatePaths: {
          ws: "none (exchange truth uses authoritative REST snapshots)",
          restSync:
            "lib/ops/scheduled-jobs.ts user_sync/stream_repair -> recordExchangeOrdersSnapshotSuccess / recordExchangeFillsSnapshotSuccess",
          reconciliation: "worker/stream-runtime.ts in-process reconcile updates local snapshot fields",
          snapshotBookkeeping: "lib/live/exchange-truth-snapshots.ts merged by worker/stream-runtime.ts",
        },
        valuesAppearCurrentNow: exchangeCurrentFresh,
      },
      relatedSignalsSamePath: {
        exchange_truth_orders_stale: {
          source: "lib/runtime/runtime-degraded.ts :: computeDegraded",
          thresholdMs: exchangeOrdersThresholdMs,
          timestamp: lastExchangeOrdersSnapshotAt,
          currentState: signalState(lastExchangeOrdersSnapshotAt, exchangeOrdersThresholdMs, nowMs),
        },
        exchange_truth_fills_stale: {
          source: "lib/runtime/runtime-degraded.ts :: computeDegraded",
          thresholdMs: exchangeFillsThresholdMs,
          timestamp: lastExchangeFillsSnapshotAt,
          currentState: signalState(lastExchangeFillsSnapshotAt, exchangeFillsThresholdMs, nowMs),
        },
      },
    },
    shortWindowBlockerDistribution: reasonCountersByWindow,
    recentSuccessfulSyncAndReconciliationEvidence: {
      windows: WINDOWS.map((w) => {
        const cutoff = nowMs - w.ms;
        const rows = parsedJobs.filter((j) => new Date(j.startedAt).getTime() >= cutoff);
        return {
          window: w.label,
          jobRuns: rows,
          counts: {
            user_sync_success: rows.filter((r) => r.jobName === "user_sync" && r.status === "success").length,
            order_reconciliation_success: rows.filter(
              (r) => r.jobName === "order_reconciliation" && r.status === "success"
            ).length,
            stream_repair_success: rows.filter((r) => r.jobName === "stream_repair" && r.status === "success").length,
          },
        };
      }),
      truthSnapshotUpdateCallsObservable: {
        userSyncAndStreamRepairCallSites:
          "lib/ops/scheduled-jobs.ts executes setLastSuccessfulUserTruthFetchAt + recordExchangeOrdersSnapshotSuccess + recordExchangeFillsSnapshotSuccess after successful user truth sync.",
      },
      markerMovementEvidence,
      failedUserRefreshEvidence: {
        in5m: failedUserRefresh5m,
        in10m: failedUserRefresh10m,
        hasConnectionPoolTimeoutFailures: hasPoolTimeoutFailures,
      },
      shouldHaveRefreshedMarkers: {
        user_sync: "user truth marker + exchange orders/fills markers",
        stream_repair_stage1_success: "user truth marker + exchange orders/fills markers",
        order_reconciliation_success: "runtime reconciliation freshness marker",
      },
    },
    rootCauseAttribution: {
      rootCause,
      why,
      staleFreshnessBlockLegitimacy:
        rootCause === "LEGITIMATE_UPSTREAM_DATA_GAP" || rootCause === "STALE_FRESHNESS_SOURCE"
          ? "appears_legitimate_in_current_short_window"
          : "appears_buggy_or_accounting_related",
    },
    recommendedNextFixTarget: nextFixTarget,
    filesChanged: ["tools/create-truth-freshness-flap-report.ts", "package.json"],
    redaction: {
      secretsRedacted: true,
      note: "No credentials/tokens included; only timestamps, statuses, and bounded job metadata.",
    },
    runtimeRawContext: {
      reconciliation: {
        lastRuntimeReconciliationAt,
        lastRuntimeReconciliationStatus,
        runtimeReconciliationRuns,
        runtimeReconciliationFailures,
        thresholdMs: RECONCILE_FRESHNESS_MS,
      },
      truthModelStatus: {
        exchangeTruthHealthy:
          typeof truthModelStatus?.exchangeTruthHealthy === "boolean"
            ? truthModelStatus.exchangeTruthHealthy
            : null,
        staleReasonCodes: Array.isArray(truthModelStatus?.staleReasonCodes)
          ? truthModelStatus?.staleReasonCodes
          : [],
      },
    },
  };

  const md: string[] = [];
  md.push("# Truth Freshness Flap Report");
  md.push(`Generated at: ${generatedAt}`);
  md.push("");
  md.push("## 1) Current runtime snapshot");
  md.push(`- runtimeStatus: **${runtimeStatus ?? "—"}**`);
  md.push(`- lifecycleStatus: **${lifecycleStatus ?? "—"}**`);
  md.push(`- runtimeMarkedReady: **${runtimeMarkedReady}**`);
  md.push(`- globalAutomationEnabled: **${globalAutomationEnabled ?? "—"}**`);
  md.push(`- automationPermitted: **${automationPermitted ?? "—"}**`);
  md.push(`- safeToAutomate: **${safeToAutomate ?? "—"}**`);
  md.push(`- runtimeSafetyState: **${runtimeSafetyState ?? "—"}**`);
  md.push(`- degradedReasons: ${degradedReasons.join(", ") || "(none)"}`);
  md.push(`- operatingMode: **${operatingMode ?? "—"}**`);
  md.push("");
  md.push("## 2) Truth freshness breakdown");
  md.push("### User truth");
  md.push(`- current freshness state: **${report.truthFreshnessBreakdown.userTruth.currentFreshnessState}**`);
  md.push(`- effective timestamp: ${userCurrentIso ?? "—"} (${userCurrentSource})`);
  md.push(`- thresholdMs: ${userThresholdMs}`);
  md.push(`- considered fresh: ${String(userCurrentIsFresh)}`);
  md.push(`- signal state: ${userSignalState}`);
  md.push("");
  md.push("### Exchange truth");
  md.push(`- current freshness state: **${report.truthFreshnessBreakdown.exchangeTruth.currentFreshnessState}**`);
  md.push(`- orders snapshot: ${lastExchangeOrdersSnapshotAt ?? "—"} (<=${exchangeOrdersThresholdMs}ms)`);
  md.push(`- fills snapshot: ${lastExchangeFillsSnapshotAt ?? "—"} (<=${exchangeFillsThresholdMs}ms)`);
  md.push(`- exchangeTruthUnavailable: ${String(exchangeTruthUnavailable)}`);
  md.push(`- considered fresh: ${String(exchangeCurrentFresh)}`);
  md.push(`- signal state: ${exchangeSignalState}`);
  md.push("");
  md.push("## 3) Freshness signal provenance");
  md.push("- `user_data_stale`: `lib/runtime/risk/runtime-guardrails.ts` :: `DefaultRuntimeGuardrails.evaluate`");
  md.push("- `exchange_truth_stale`: `lib/runtime/runtime-degraded.ts` + `lib/runtime/risk/runtime-guardrails.ts`");
  md.push("- related stale signals: `exchange_truth_orders_stale`, `exchange_truth_fills_stale`, `exchange_truth_unavailable`");
  md.push("");
  md.push("## 4) Recent successful sync/reconciliation evidence");
  md.push("| window | user_sync success | order_reconciliation success | stream_repair success |");
  md.push("|---|---:|---:|---:|");
  for (const w of report.recentSuccessfulSyncAndReconciliationEvidence.windows) {
    md.push(
      `| ${w.window} | ${w.counts.user_sync_success} | ${w.counts.order_reconciliation_success} | ${w.counts.stream_repair_success} |`
    );
  }
  md.push("");
  md.push("### Marker movement evidence");
  md.push("```json");
  md.push(JSON.stringify(markerMovementEvidence, null, 2));
  md.push("```");
  md.push("");
  md.push("## 5) Root cause attribution");
  md.push(`- **${rootCause}**`);
  md.push(`- ${why}`);
  md.push("");
  md.push("## 6) Recommended next fix target");
  md.push(`- ${nextFixTarget}`);
  md.push("");
  md.push("## 7) Short-window blocker distribution");
  md.push("| window | created | blocked | submitted | user_data_stale | exchange_truth_stale | related freshness |");
  md.push("|---|---:|---:|---:|---:|---:|---:|");
  for (const row of reasonCountersByWindow) {
    md.push(
      `| ${row.window} | ${row.runtimeAutomatedCreated} | ${row.blocked} | ${row.submitted} | ${row.user_data_stale_count} | ${row.exchange_truth_stale_count} | ${row.related_freshness_signals_count} |`
    );
  }

  await fs.writeFile(
    path.join(DUMP_DIR, "truth-freshness-flap-report.json"),
    JSON.stringify(report, null, 2),
    "utf-8"
  );
  await fs.writeFile(path.join(DUMP_DIR, "truth-freshness-flap-report.md"), md.join("\n"), "utf-8");

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        rootCause,
        staleFreshnessBlockLegitimacy: report.rootCauseAttribution.staleFreshnessBlockLegitimacy,
        nextFixTarget,
      },
      null,
      2
    )
  );
}

void main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error("create-truth-freshness-flap-report failed", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

