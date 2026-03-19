/**
 * scheduler_backlog_high report (bounded, deterministic).
 *
 * Writes:
 * - dump/scheduler-backlog-report.json
 * - dump/scheduler-backlog-report.md
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
import { JOB_INTERVALS_MS, type JobName } from "../lib/ops/scheduled-jobs";

const DUMP_DIR = path.join(process.cwd(), "dump");
const WORKER_NAME = "polymarket-copilot-worker";
const HEARTBEAT_FRESH_MS = Number(process.env.SCHED_BACKLOG_HEARTBEAT_FRESH_MS ?? "90000") || 90_000;
const RUNS_PER_JOB = Number(process.env.SCHED_BACKLOG_RUNS_PER_JOB ?? "5") || 5;
const RUN_WINDOW_MS = Number(process.env.SCHED_BACKLOG_RUN_WINDOW_MS ?? String(24 * 60 * 60 * 1000)) || 24 * 60 * 60 * 1000;

type Verdict = "HEALTHY_AND_OPERATING" | "HEALTHY_BUT_IDLE" | "BOOTED_BUT_FROZEN" | "DEGRADED" | "BROKEN";
type RootCauseCategory =
  | "LEGITIMATE_SCHEDULER_OVERLOAD"
  | "STALE_BACKLOG_SIGNAL"
  | "DUPLICATE_JOB_DISPATCH"
  | "OVERLAP_ACCOUNTING_BUG"
  | "COMPLETION_CLEARING_BUG"
  | "WRONG_HEALTH_SOURCE"
  | "PAPER_MODE_SCHEDULER_MISMATCH"
  | "OTHER_BUG";

const TARGET_JOBS: JobName[] = [
  "user_sync",
  "order_reconciliation",
  "stream_repair",
  "market_sync",
  "paper_trading_tick",
  "policy_refresh_pending",
];

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function toReasonArray(raw: unknown): string[] {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === "string");
  if (typeof raw === "string") return raw.split(/[;,|]/g).map((s) => s.trim()).filter(Boolean);
  return [];
}

function pickBool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

function pickNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return asRecord(parsed);
  } catch {
    return null;
  }
}

function overlapCount(
  runs: Array<{ startedAt: Date; finishedAt: Date | null }>
): number {
  let overlaps = 0;
  for (let i = 0; i < runs.length; i += 1) {
    const a = runs[i];
    if (!a) continue;
    const aEnd = a.finishedAt?.getTime() ?? Date.now();
    const aStart = a.startedAt.getTime();
    for (let j = i + 1; j < runs.length; j += 1) {
      const b = runs[j];
      if (!b) continue;
      const bStart = b.startedAt.getTime();
      const bEnd = b.finishedAt?.getTime() ?? Date.now();
      if (aStart <= bEnd && bStart <= aEnd) overlaps += 1;
    }
  }
  return overlaps;
}

function computeVerdict(input: {
  runtimeStatus: string | null;
  lifecycleStatus: string | null;
  runtimeMarkedReady: boolean;
  automationPermitted: boolean | null;
  runtimeSafetyState: string | null;
}): Verdict {
  if (input.runtimeSafetyState != null && input.runtimeSafetyState !== "normal") return "DEGRADED";
  if (input.runtimeStatus === "degraded" || input.lifecycleStatus === "degraded") return "DEGRADED";
  if (!input.runtimeMarkedReady || input.automationPermitted === false) return "BOOTED_BUT_FROZEN";
  return "HEALTHY_AND_OPERATING";
}

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });
  const nowMs = Date.now();
  const generatedAt = new Date(nowMs).toISOString();

  const hb = await prisma.workerHeartbeat.findUnique({
    where: { workerName: WORKER_NAME },
    select: { lastSeenAt: true, status: true, metadataJson: true },
  });
  const hbFresh = hb ? heartbeatIsFresh(hb.lastSeenAt, nowMs, HEARTBEAT_FRESH_MS) : false;
  const meta = parseHeartbeatMetadataJson(hb?.metadataJson ?? undefined);
  const runtimeHealth = asRecord(meta?.runtimeHealth) ?? null;
  const canonical = extractCanonicalWorkerRuntime(meta);

  const runtimeStatus = typeof runtimeHealth?.status === "string" ? runtimeHealth.status : null;
  const lifecycleStatus = typeof runtimeHealth?.lifecycleStatus === "string" ? runtimeHealth.lifecycleStatus : null;
  const runtimeMarkedReady = runtimeStatus === "ready" || lifecycleStatus === "ready";
  const runtimeSafetyState = canonical.runtimeSafetyState;
  const globalAutomationEnabled = pickBool(runtimeHealth?.globalAutomationEnabled);
  const degradedReasons = Array.isArray(runtimeHealth?.degradedReasons) ? (runtimeHealth!.degradedReasons as string[]) : [];
  const schedulerBacklogHighActive = degradedReasons.includes("scheduler_backlog_high");

  const operatorHealth = asRecord(runtimeHealth?.operatorHealth) ?? null;
  const readiness = asRecord(operatorHealth?.readiness) ?? null;
  const automationPermitted = pickBool(readiness?.automationPermitted);
  const safeToAutomate = pickBool(readiness?.safeToAutomate);

  const counts = asRecord(runtimeHealth?.counts) ?? null;
  const schedulerBacklog = pickNum(counts?.schedulerBacklog);

  const diagnostics = asRecord(runtimeHealth?.diagnostics) ?? null;
  const schedulerQueueHighWaterMark = pickNum(diagnostics?.schedulerQueueHighWaterMark);
  const schedulerDroppedEvents = pickNum(diagnostics?.schedulerDroppedEvents);
  const schedulerCoalescedEvents = pickNum(diagnostics?.schedulerCoalescedEvents);
  const schedulerLastEvaluationLatencyMs = pickNum(diagnostics?.schedulerLastEvaluationLatencyMs);
  const schedulerOverloadPeriodCount = pickNum(diagnostics?.schedulerOverloadPeriodCount);
  const diagnosticsAsOf = typeof diagnostics?.asOf === "string" ? (diagnostics!.asOf as string) : null;
  const schedulerBacklogThreshold = 100; // DEFAULT_SCHEDULER_BACKLOG_THRESHOLD in runtime-degraded.ts

  // ---- Scheduled job run windows (bounded) ----
  const runWindowStart = new Date(nowMs - RUN_WINDOW_MS);
  const runs = await prisma.scheduledJobRun.findMany({
    where: {
      jobName: { in: TARGET_JOBS as string[] },
      startedAt: { gte: runWindowStart },
    },
    orderBy: { startedAt: "desc" },
    take: Math.max(200, TARGET_JOBS.length * RUNS_PER_JOB * 2),
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

  const byJob = new Map<string, typeof runs>();
  for (const r of runs) {
    const arr = byJob.get(r.jobName) ?? [];
    arr.push(r);
    byJob.set(r.jobName, arr);
  }

  const jobSummary = TARGET_JOBS.map((jobName) => {
    const all = (byJob.get(jobName) ?? []).sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
    const sample = all.slice(0, RUNS_PER_JOB);
    const intervalMs = JOB_INTERVALS_MS[jobName];
    const overlapPairs = overlapCount(
      all.map((r) => ({ startedAt: r.startedAt, finishedAt: r.finishedAt }))
    );
    const lateStartEvidence = sample
      .slice(1)
      .some((r, i) => {
        const prev = sample[i];
        if (!prev) return false;
        const gap = prev.startedAt.getTime() - r.startedAt.getTime();
        return gap > intervalMs * 1.7;
      });
    const longRuns = sample.filter((r) => (r.durationMs ?? 0) > intervalMs).length;
    const failedRuns = sample.filter((r) => r.status === "failure").length;
    const runningNow = all.some((r) => r.status === "running");

    const recentRuns = sample.map((r) => {
      const md = parseJsonObject(r.metadataJson);
      const breadcrumbs = Array.isArray(md?.breadcrumbs) ? (md!.breadcrumbs as Array<Record<string, unknown>>) : [];
      const overlapHint = (() => {
        const leaseId = typeof md?.leaseId === "string" ? (md.leaseId as string) : null;
        return leaseId;
      })();
      return {
        id: r.id,
        status: r.status,
        startedAt: r.startedAt.toISOString(),
        finishedAt: r.finishedAt?.toISOString() ?? null,
        durationMs: r.durationMs ?? null,
        errorMessage: r.errorMessage ?? null,
        leaseId: overlapHint,
        stageTrail: breadcrumbs
          .map((b) => (typeof b.stage === "string" ? (b.stage as string) : null))
          .filter((s): s is string => s != null)
          .slice(0, 10),
      };
    });

    const health =
      overlapPairs > 0
        ? "suspicious_overlap"
        : failedRuns > 0
          ? "overloaded_or_failing"
          : longRuns > 0
            ? "heavy_but_bounded"
            : "healthy";

    return {
      jobName,
      configuredIntervalMs: intervalMs,
      observedRunsInWindow: all.length,
      overlapPairsInWindow: overlapPairs,
      lateStartEvidence,
      longRunsOverIntervalCount: longRuns,
      failedRunsInSample: failedRuns,
      runningNow,
      health,
      recentRuns,
    };
  });

  const suspiciousJobs = jobSummary
    .filter((j) => j.health !== "healthy")
    .sort((a, b) => b.longRunsOverIntervalCount - a.longRunsOverIntervalCount)
    .slice(0, 6)
    .map((j) => ({
      jobName: j.jobName,
      reason:
        j.overlapPairsInWindow > 0
          ? "overlap detected"
          : j.longRunsOverIntervalCount > 0
            ? "durations exceed interval"
            : j.failedRunsInSample > 0
              ? "recent failures"
              : "late starts",
      appearsLegitimate: j.overlapPairsInWindow === 0,
      health: j.health,
    }));

  // ---- Root cause classification ----
  let rootCauseCategory: RootCauseCategory = "OTHER_BUG";
  const rootCauseWhy: string[] = [];

  if (!schedulerBacklogHighActive) {
    rootCauseCategory = "STALE_BACKLOG_SIGNAL";
    rootCauseWhy.push("scheduler_backlog_high is not active in current degraded reasons (currently recovered)");
  } else if (schedulerBacklog == null) {
    rootCauseCategory = "WRONG_HEALTH_SOURCE";
    rootCauseWhy.push("degraded reason active but counts.schedulerBacklog missing");
  } else if (schedulerBacklog < schedulerBacklogThreshold) {
    rootCauseCategory = "STALE_BACKLOG_SIGNAL";
    rootCauseWhy.push(
      `schedulerBacklog=${schedulerBacklog} below threshold=${schedulerBacklogThreshold} while reason still active`
    );
  } else if ((schedulerOverloadPeriodCount ?? 0) > 0 || (schedulerQueueHighWaterMark ?? 0) >= schedulerBacklogThreshold) {
    rootCauseCategory = "LEGITIMATE_SCHEDULER_OVERLOAD";
    rootCauseWhy.push(
      `schedulerBacklog=${schedulerBacklog} >= threshold=${schedulerBacklogThreshold}; scheduler diagnostics show overload/high-water`
    );
  } else {
    rootCauseCategory = "WRONG_HEALTH_SOURCE";
    rootCauseWhy.push(
      "backlog reason appears active without corroborating scheduler overload diagnostics"
    );
  }

  if (schedulerBacklogHighActive && jobSummary.some((j) => j.overlapPairsInWindow > 0)) {
    rootCauseCategory = "DUPLICATE_JOB_DISPATCH";
    rootCauseWhy.push("scheduled job overlap detected in bounded run window");
  }

  const verdict = computeVerdict({
    runtimeStatus,
    lifecycleStatus,
    runtimeMarkedReady,
    automationPermitted,
    runtimeSafetyState,
  });

  const json = {
    generatedAt,
    heartbeat: {
      workerName: WORKER_NAME,
      lastSeenAt: hb?.lastSeenAt?.toISOString() ?? null,
      heartbeatFresh: hbFresh,
      status: hb?.status ?? null,
    },
    runtimePermissionSnapshot: {
      runtimeStatus,
      lifecycleStatus,
      runtimeMarkedReady,
      globalAutomationEnabled,
      automationPermitted,
      safeToAutomate,
      runtimeSafetyState,
      degradedReasons,
      scheduler_backlog_high_active: schedulerBacklogHighActive,
    },
    schedulerBacklogBreakdown: {
      signalPath:
        "worker/stream-runtime.ts -> d.botRuntime.getSchedulerBacklog() -> runtime-degraded.ts computeDegraded() threshold(100) -> degradedReasons includes scheduler_backlog_high",
      source: "runtimeHealth.counts.schedulerBacklog (bot scheduler queue depth)",
      threshold: schedulerBacklogThreshold,
      schedulerBacklog,
      diagnosticsAsOf,
      schedulerQueueHighWaterMark,
      schedulerDroppedEvents,
      schedulerCoalescedEvents,
      schedulerLastEvaluationLatencyMs,
      schedulerOverloadPeriodCount,
      appearsCurrent:
        schedulerBacklog != null && schedulerBacklog >= schedulerBacklogThreshold,
      appearsStale:
        schedulerBacklogHighActive &&
        schedulerBacklog != null &&
        schedulerBacklog < schedulerBacklogThreshold,
      note:
        "This backlog signal is from runtime bot decision scheduler queue, not from ScheduledJobRun table directly.",
    },
    recentJobExecutionSummary: {
      windowMs: RUN_WINDOW_MS,
      runsPerJob: RUNS_PER_JOB,
      jobs: jobSummary,
    },
    backlogAttributionSummary: {
      topContributors: suspiciousJobs,
      historicalOnly:
        schedulerBacklog != null && schedulerBacklog < schedulerBacklogThreshold,
    },
    rootCause: {
      category: rootCauseCategory,
      why: rootCauseWhy,
    },
    verdict,
    filesChanged: [
      "tools/create-scheduler-backlog-report.ts",
      "package.json",
    ],
  };

  const md: string[] = [];
  md.push("# Scheduler Backlog Report");
  md.push(`Generated at: ${generatedAt}`);
  md.push("");
  md.push("## 1) Runtime / permission snapshot");
  md.push(`- runtimeStatus: **${runtimeStatus ?? "—"}** · lifecycleStatus: **${lifecycleStatus ?? "—"}**`);
  md.push(`- runtimeMarkedReady: **${runtimeMarkedReady}**`);
  md.push(`- globalAutomationEnabled: **${globalAutomationEnabled ?? "—"}**`);
  md.push(`- automationPermitted: **${automationPermitted ?? "—"}** · safeToAutomate: **${safeToAutomate ?? "—"}**`);
  md.push(`- runtimeSafetyState: **${runtimeSafetyState ?? "—"}**`);
  md.push(`- degradedReasons: ${degradedReasons.join(", ") || "(none)"}`);
  md.push(`- scheduler_backlog_high active: **${schedulerBacklogHighActive}**`);
  md.push("");
  md.push("## 2) Scheduler backlog breakdown");
  md.push(`- signal/source: ${json.schedulerBacklogBreakdown.signalPath}`);
  md.push(`- current backlog (queue depth): **${schedulerBacklog ?? "—"}** · threshold: **${schedulerBacklogThreshold}**`);
  md.push(`- diagnostics asOf: ${diagnosticsAsOf ?? "—"}`);
  md.push(`- queue high-water: ${schedulerQueueHighWaterMark ?? "—"} · overload periods: ${schedulerOverloadPeriodCount ?? "—"}`);
  md.push(`- dropped/coalesced events: ${schedulerDroppedEvents ?? "—"} / ${schedulerCoalescedEvents ?? "—"}`);
  md.push(`- appears current: **${json.schedulerBacklogBreakdown.appearsCurrent}** · appears stale: **${json.schedulerBacklogBreakdown.appearsStale}**`);
  md.push("");
  md.push("## 3) Recent job execution summary");
  md.push(`- windowMs: ${RUN_WINDOW_MS} · runs/job: ${RUNS_PER_JOB}`);
  md.push("| job | intervalMs | observed runs | overlaps | long runs > interval | failed in sample | health |");
  md.push("|---|---:|---:|---:|---:|---:|---|");
  for (const j of jobSummary) {
    md.push(
      `| ${j.jobName} | ${j.configuredIntervalMs} | ${j.observedRunsInWindow} | ${j.overlapPairsInWindow} | ${j.longRunsOverIntervalCount} | ${j.failedRunsInSample} | ${j.health} |`
    );
  }
  md.push("");
  md.push("## 4) Backlog attribution summary");
  if (suspiciousJobs.length === 0) {
    md.push("- no suspicious scheduled-job overlap/duplication found in bounded window");
  } else {
    for (const s of suspiciousJobs) {
      md.push(`- ${s.jobName}: ${s.reason} (${s.health})`);
    }
  }
  md.push("- scheduler_backlog_high source is bot decision scheduler queue, not ScheduledJobRun directly.");
  md.push("");
  md.push("## 5) Root cause & fix summary");
  md.push(`- rootCauseCategory: **${rootCauseCategory}**`);
  for (const w of rootCauseWhy) md.push(`- ${w}`);
  md.push("");
  md.push("## 6) Overall verdict");
  md.push(`- verdict: **${verdict}**`);

  const jsonPath = path.join(DUMP_DIR, "scheduler-backlog-report.json");
  const mdPath = path.join(DUMP_DIR, "scheduler-backlog-report.md");
  await fs.writeFile(jsonPath, JSON.stringify(json, null, 2), "utf-8");
  await fs.writeFile(mdPath, md.join("\n"), "utf-8");

  // concise stdout summary for terminal use
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        verdict,
        rootCauseCategory,
        schedulerBacklogHighActive,
        schedulerBacklog,
        schedulerBacklogThreshold,
        runtimeStatus,
        lifecycleStatus,
        automationPermitted,
        safeToAutomate,
      },
      null,
      2
    )
  );
}

void main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("create-scheduler-backlog-report failed", err);
  process.exit(1);
});

