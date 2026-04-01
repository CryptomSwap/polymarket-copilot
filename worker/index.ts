/**
 * Background worker: WebSockets, heartbeat, and scheduled jobs. No autonomous trading.
 * Run with: npm run worker (or npx ts-node -r tsconfig-paths/register worker/index.ts)
 *
 * Env is loaded from .env in process.cwd() so USE_STREAM_RUNTIME and RUNTIME_MODE are set
 * before we read them. Set USE_STREAM_RUNTIME=true for the hardened StreamRuntime path.
 */

// Load .env first so USE_STREAM_RUNTIME and RUNTIME_MODE are available (worker runs as separate process)
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("dotenv").config({ path: process.env.ENV_PATH ?? ".env" });
} catch {
  // dotenv optional; env may be set by shell or --env-file
}

import { startHeartbeat, stopHeartbeat, triggerTick } from "./heartbeat";
import { startWebsockets, stopWebsockets } from "./websockets";
import { StreamRuntime } from "./stream-runtime";
import { getRuntimeSafetyState } from "@/lib/runtime-safety";
import { getLastSuccessfulUserTruthFetchAt } from "@/lib/live/user-truth-freshness";
import {
  evaluateLiveReadiness,
  buildLiveReadinessInputFromRuntime,
  updateLiveReadinessState,
  getLiveReadinessState,
} from "@/lib/live-readiness";
import { JOB_NAMES, JOB_INTERVALS_MS, runJob, type JobName } from "./jobs";
import { prisma } from "../lib/db";
import { consoleMethodForLevel, getLogLevelFromEnv, shouldEmitLog, type LogLevel } from "../lib/logging/log-level";
import { warnIfRuntimeAutomatedShadowWritesDisabledAtWorkerBoot } from "@/lib/shadow-telemetry/record";

const WORKER_NAME = "polymarket-copilot-worker";
const USE_STREAM_RUNTIME = process.env.USE_STREAM_RUNTIME === "true";
const RUNTIME_MODE = process.env.RUNTIME_MODE ?? "paper";
const LOG_LEVEL: LogLevel = getLogLevelFromEnv("info");

let jobIntervals: ReturnType<typeof setInterval>[] = [];
const runningJobs = new Set<string>();
let killSwitchPollInterval: ReturnType<typeof setInterval> | null = null;
let streamRuntime: StreamRuntime | null = null;
let eagerUserSyncInterval: ReturnType<typeof setInterval> | null = null;

const RUNTIME_CONTROL_POLL_MS = 5_000;
const RUNTIME_CONTROL_ID = "default";

const USER_TRUTH_TARGET_FRESH_MS = Number(process.env.USER_TRUTH_TARGET_FRESH_MS ?? "60000") || 60_000;
const USER_TRUTH_EAGER_TRIGGER_MS = Number(process.env.USER_TRUTH_EAGER_TRIGGER_MS ?? "90000") || 90_000;
const USER_TRUTH_EAGER_TRIGGER_MIN_GAP_MS =
  Number(process.env.USER_TRUTH_EAGER_TRIGGER_MIN_GAP_MS ?? "30000") || 30_000;
const USER_TRUTH_EAGER_TRIGGER_CHECK_INTERVAL_MS =
  Number(process.env.USER_TRUTH_EAGER_TRIGGER_CHECK_INTERVAL_MS ?? "15000") || 15_000;

let lastScheduledUserSyncStartAt: Date | null = null;
let lastEagerUserSyncRequestedAt: Date | null = null;
let lastEagerUserSyncRequestedReason: string | null = null;
let lastEagerUserSyncRunId: string | null = null;
let lastEagerUserSyncRunStartAt: Date | null = null;

function log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  if (!shouldEmitLog(level, LOG_LEVEL)) return;
  const line = meta ? `${message} ${JSON.stringify(meta)}` : message;
  const prefix = `[worker]`;
  switch (level) {
    case "debug":
      console.debug(prefix, line);
      break;
    case "info":
      console.info(prefix, line);
      break;
    case "warn":
      console.warn(prefix, line);
      break;
    case "error":
      console.error(prefix, line);
      break;
  }
}

function scheduleJobs(): void {
  for (const name of JOB_NAMES) {
    const intervalMs = JOB_INTERVALS_MS[name as JobName];
    const id = setInterval(async () => {
      try {
        if (runningJobs.has(name)) {
          log("warn", `Scheduled job skipped (still running): ${name}`, {});
          return;
        }
        runningJobs.add(name);
        log("info", `Scheduled job started: ${name}`, {});
        if (name === "user_sync") {
          lastScheduledUserSyncStartAt = new Date();
        }
        const result = await runJob(name as JobName);
        log("info", `Scheduled job finished: ${name}`, { status: result.status, durationMs: result.durationMs });
        if (result.error) log("error", `Job ${name} error`, { error: result.error });
      } catch (err) {
        log("error", `Scheduled job threw: ${name}`, { error: String(err) });
      } finally {
        runningJobs.delete(name);
      }
    }, intervalMs);
    jobIntervals.push(id);
  }
  log("info", "Scheduled jobs registered", { count: JOB_NAMES.length });
}

function clearScheduledJobs(): void {
  for (const id of jobIntervals) clearInterval(id);
  jobIntervals = [];
}

function clearKillSwitchPoll(): void {
  if (killSwitchPollInterval) {
    clearInterval(killSwitchPollInterval);
    killSwitchPollInterval = null;
  }
}

async function shutdown(): Promise<void> {
  log("info", "Shutdown requested", {});
  clearKillSwitchPoll();
  if (eagerUserSyncInterval) {
    clearInterval(eagerUserSyncInterval);
    eagerUserSyncInterval = null;
  }
  clearScheduledJobs();
  if (streamRuntime) {
    await streamRuntime.stop();
    streamRuntime = null;
  } else {
    stopWebsockets();
  }
  await stopHeartbeat(WORKER_NAME);
  log("info", "Shutdown complete", {});
  process.exit(0);
}

function main(): void {
  if (typeof (globalThis as unknown as { WebSocket?: unknown }).WebSocket === "undefined") {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Ws = require("ws");
      (globalThis as unknown as { WebSocket: unknown }).WebSocket = Ws;
      log("info", "WebSocket polyfill installed (ws)", {});
    } catch {
      log("warn", "WebSocket not available; install 'ws' for worker WebSocket support", {});
    }
  }

  startHeartbeat({
    workerName: WORKER_NAME,
    intervalMs: 30_000,
    metadata: { pid: process.pid, nodeVersion: process.version },
    getMetadata: () => {
      if (!streamRuntime) return {};
      const runtimeHealth = streamRuntime.getHealth();
      const runtimeSafety = getRuntimeSafetyState();
      const health = runtimeHealth as {
        streams?: { heartbeatHealthy?: boolean };
        reconciliation?: { status?: string; lastAt?: string };
        metadata?: { exchangeCredentialValidationReady?: boolean; reconciliationAlignmentReady?: boolean };
      };
      const exchangeCredentialValidationReady =
        health?.metadata?.exchangeCredentialValidationReady === true;
      const reconciliationOk = health?.metadata?.reconciliationAlignmentReady === true ||
        (health?.reconciliation?.status === "ok" && health?.reconciliation?.lastAt != null);
      const input = buildLiveReadinessInputFromRuntime({
        runtimeSafetyState: runtimeSafety.state,
        exchangeTruthHealthy: health?.streams?.heartbeatHealthy ?? false,
        reconciliationOk,
        exchangeCredentialValidationReady,
        operatorMode: "paper_only",
        manualLiveEnableRequested: false,
      });
      const readinessResult = evaluateLiveReadiness(input);
      updateLiveReadinessState(readinessResult);
      const liveReadiness = getLiveReadinessState();
      return {
        runtimeHealth,
        runtimeSafety,
        userTruthMaintenance: {
          targetFreshMs: USER_TRUTH_TARGET_FRESH_MS,
          eagerTriggerMs: USER_TRUTH_EAGER_TRIGGER_MS,
          eagerTriggerMinGapMs: USER_TRUTH_EAGER_TRIGGER_MIN_GAP_MS,
          userSyncIntervalMs: JOB_INTERVALS_MS.user_sync,
          lastScheduledUserSyncStartAt: lastScheduledUserSyncStartAt?.toISOString() ?? null,
          lastEagerUserSyncRequestedAt: lastEagerUserSyncRequestedAt?.toISOString() ?? null,
          lastEagerUserSyncRequestedReason: lastEagerUserSyncRequestedReason,
          lastEagerUserSyncRunId: lastEagerUserSyncRunId,
          lastEagerUserSyncRunStartAt: lastEagerUserSyncRunStartAt?.toISOString() ?? null,
          earlySyncRequestedRecently:
            lastEagerUserSyncRequestedAt != null && Date.now() - lastEagerUserSyncRequestedAt.getTime() <= 2 * USER_TRUTH_EAGER_TRIGGER_MIN_GAP_MS,
          nextScheduledUserSyncAtApprox:
            lastScheduledUserSyncStartAt != null ? new Date(lastScheduledUserSyncStartAt.getTime() + JOB_INTERVALS_MS.user_sync).toISOString() : null,
        },
        liveReadiness: {
          overallState: liveReadiness.overallState,
          allowLiveTrading: liveReadiness.allowLiveTrading,
          blockingReasons: liveReadiness.blockingReasons,
          warnings: liveReadiness.warnings,
          passedChecks: liveReadiness.passedChecks,
          failedChecks: liveReadiness.failedChecks,
          evaluatedAt: liveReadiness.evaluatedAt,
        },
      };
    },
  });

  if (USE_STREAM_RUNTIME) {
    streamRuntime = new StreamRuntime({
      paperMode: true,
      globalAutomationDisabledByDefault: true,
      diagnosticsLogFn: (level, message, meta) => {
        if (!shouldEmitLog(level, LOG_LEVEL)) return;
        const line = meta ? `${message} ${JSON.stringify(meta)}` : message;
        const prefix = "[runtime]";
        const method = consoleMethodForLevel(level);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (console as any)[method](prefix, line);
      },
    });
    streamRuntime.start().then(
      () => {
        log("info", "StreamRuntime started", { mode: "paper" });
        triggerTick();
        const h = streamRuntime?.getHealth();
        if (h) {
          const hRecord = h as unknown as Record<string, unknown>;
          const streams = (h.streams ?? {}) as Record<string, unknown>;
          const market = streams.marketConnection as Record<string, unknown> | null | undefined;
          const user = streams.userConnection as Record<string, unknown> | null | undefined;
          log("info", "Post-startup summary", {
            startedAt: h.startedAt != null ? String(h.startedAt) : null,
            status: h.status,
            lifecycleStatus: h.lifecycleStatus,
            degradedReasons: h.degradedReasons,
            marketConnection_status: market?.status ?? null,
            userConnection_status: user?.status ?? null,
            operatingMode: hRecord.operatingMode ?? null,
            truthModelStatus: hRecord.truthModelStatus != null ? "present" : null,
          });
        }
        killSwitchPollInterval = setInterval(async () => {
          try {
            const row = await prisma.runtimeControl.findUnique({
              where: { id: RUNTIME_CONTROL_ID },
            });
            if (!row?.clearGlobalStopRequested) return;
            const ks = streamRuntime?.getKillSwitch();
            if (ks) {
              ks.clearGlobalStop();
              log("info", "Global kill switch cleared (operator request)", {});
              // Ensure risk engine state (globalAutomationEnabled) reflects latest kill-switch state.
              streamRuntime?.syncKillSwitchIntoRiskEngine();
            }
            await prisma.runtimeControl.update({
              where: { id: RUNTIME_CONTROL_ID },
              data: { clearGlobalStopRequested: false, updatedAt: new Date() },
            });
          } catch (e) {
            log("warn", "Kill-switch poll error", { error: String(e) });
          }
        }, RUNTIME_CONTROL_POLL_MS);
      },
      (err) => log("error", "StreamRuntime start failed", { error: String(err) })
    );
  } else {
    startWebsockets().catch((err) => log("error", "startWebsockets failed", { error: String(err) }));
  }

  scheduleJobs();
  warnIfRuntimeAutomatedShadowWritesDisabledAtWorkerBoot();

  // Freshness-aware eager triggering for user_sync. This keeps lastSuccessfulUserTruthFetchAt fresh
  // even when the user WS has no real order/fill messages (lastDataEventAt stays null).
  eagerUserSyncInterval = setInterval(() => {
    void (async () => {
      let claimedUserSyncJob = false;
      try {
        const truthAt = getLastSuccessfulUserTruthFetchAt();
        const truthAgeMs = truthAt != null ? Date.now() - truthAt.getTime() : Infinity;

        let wsLastDataEventAt: Date | null = null;
        if (streamRuntime) {
          const health = streamRuntime.getHealth();
          const userConn = (health.streams as unknown as { userConnection?: { lastDataEventAt?: unknown } }).userConnection;
          if (userConn?.lastDataEventAt instanceof Date) {
            wsLastDataEventAt = userConn.lastDataEventAt;
          } else if (userConn?.lastDataEventAt != null && typeof (userConn.lastDataEventAt as unknown) === "string") {
            const d = new Date(userConn.lastDataEventAt as unknown as string);
            wsLastDataEventAt = Number.isFinite(d.getTime()) ? d : null;
          }
        }
        const wsAgeMs = wsLastDataEventAt != null ? Date.now() - wsLastDataEventAt.getTime() : null;
        const wsStaleOrNull = wsLastDataEventAt == null || (wsAgeMs != null && wsAgeMs > USER_TRUTH_TARGET_FRESH_MS);
        const truthStaleForEager = truthAt == null || truthAgeMs > USER_TRUTH_EAGER_TRIGGER_MS;

        if (!wsStaleOrNull || !truthStaleForEager) return;

        if (lastEagerUserSyncRequestedAt != null && Date.now() - lastEagerUserSyncRequestedAt.getTime() <= USER_TRUTH_EAGER_TRIGGER_MIN_GAP_MS) {
          return;
        }

        if (runningJobs.has("user_sync")) {
          lastEagerUserSyncRequestedAt = new Date();
          lastEagerUserSyncRequestedReason = "skip_in_progress:user_sync_already_running";
          return;
        }

        runningJobs.add("user_sync");
        claimedUserSyncJob = true;
        lastEagerUserSyncRequestedAt = new Date();
        lastEagerUserSyncRequestedReason = `eager_user_truth_stale: wsLastDataEventAt=${wsLastDataEventAt ? wsAgeMs : "null"}ms; truthAgeMs=${truthAgeMs}ms`;
        log("info", "Eager user_sync trigger", { truthAgeMs, wsAgeMs, wsLastDataEventAt: wsLastDataEventAt?.toISOString?.() ?? null });
        const result = await runJob("user_sync");
        lastEagerUserSyncRunId = result.runId ?? null;
        lastEagerUserSyncRunStartAt = new Date();
        log("info", "Eager user_sync finished", { status: result.status, durationMs: result.durationMs });
      } catch (e) {
        log("error", "Eager user_sync trigger failed", { error: e instanceof Error ? e.message : String(e) });
      } finally {
        if (claimedUserSyncJob) runningJobs.delete("user_sync");
      }
    })();
  }, USER_TRUTH_EAGER_TRIGGER_CHECK_INTERVAL_MS);

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  const streamSyncStateAvailable =
    typeof (prisma as unknown as { stream_sync_state?: { findUnique?: unknown } }).stream_sync_state?.findUnique === "function";
  log("info", "Worker started", {
    workerName: WORKER_NAME,
    pid: process.pid,
    timestamp: new Date().toISOString(),
    useStreamRuntime: USE_STREAM_RUNTIME,
    runtimeMode: RUNTIME_MODE,
    path: USE_STREAM_RUNTIME ? "StreamRuntime (hardened)" : "legacy websocket-only",
    streamSyncStatePersistence: streamSyncStateAvailable ? "available" : "unavailable",
  });
}

main();
