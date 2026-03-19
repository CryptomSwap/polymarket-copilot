/**
 * Post-boot runtime validation report (read-only, bounded, deterministic).
 *
 * Writes:
 * - dump/post-boot-runtime-validation-report.json
 * - dump/post-boot-runtime-validation-report.md
 *
 * npm run dump:post-boot-runtime-validation-report
 *
 * Observes persisted worker heartbeat + DB state only; does not mutate runtime.
 * Optional HTTP checks use VALIDATION_APP_BASE_URL (default http://127.0.0.1:3000).
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
import { JOB_INTERVALS_MS, JOB_NAMES } from "../lib/ops/scheduled-jobs";

const DUMP_DIR = path.join(process.cwd(), "dump");
const WORKER_NAME = "polymarket-copilot-worker";
const RECENT_RUNS_LIMIT = 30;
const HEARTBEAT_FRESH_MS = Number(process.env.POST_BOOT_HEARTBEAT_FRESH_MS ?? "90000") || 90_000;
const RUNNING_STALL_MULT = 2;
const DEFAULT_APP_BASE = process.env.VALIDATION_APP_BASE_URL ?? "http://127.0.0.1:3000";
const HTTP_TIMEOUT_MS = Number(process.env.POST_BOOT_HTTP_TIMEOUT_MS ?? "8000") || 8000;

/** Self-improvement / shadow-ML related job names (subset of JOB_NAMES). */
const SELF_IMPROVEMENT_JOB_NAMES = [
  "shadow_evaluation",
  "shadow_analysis",
  "ml_shadow_dataset_build",
  "ml_shadow_retrain",
  "ml_shadow_promote",
  "paper_config_optimize",
  "self_improvement_rollback_guard",
  "self_improvement_status_report",
] as const;

type Verdict =
  | "HEALTHY_AND_OPERATING"
  | "HEALTHY_BUT_IDLE"
  | "BOOTED_BUT_FROZEN"
  | "DEGRADED"
  | "BROKEN";

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function excerpt(s: string | null | undefined, max = 200): string | null {
  if (s == null || s === "") return null;
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

async function httpCheck(
  label: string,
  url: string
): Promise<{ name: string; url: string; ok: boolean; status: number | null; errorExcerpt: string | null }> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: "GET", signal: ac.signal, headers: { Accept: "application/json" } });
    const ok = res.ok;
    let err: string | null = null;
    if (!ok) {
      const txt = await res.text().catch(() => "");
      err = excerpt(txt || res.statusText, 180);
    }
    return { name: label, url, ok, status: res.status, errorExcerpt: err };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { name: label, url, ok: false, status: null, errorExcerpt: excerpt(msg, 180) };
  } finally {
    clearTimeout(t);
  }
}

type JobRunRow = {
  jobName: string;
  status: string;
  startedAt: Date;
  finishedAt: Date | null;
  durationMs: number | null;
  errorMessage: string | null;
};

type JobRunSummary = {
  lastStartedAt: string;
  lastFinishedAt: string | null;
  lastStatus: string;
  lastDurationMs: number | null;
  lastErrorExcerpt: string | null;
};

function summarizeRunsByJob(runs: JobRunRow[]): Record<string, JobRunSummary> {
  const byJob: Record<string, JobRunRow> = {};
  for (const r of runs) {
    if (!byJob[r.jobName]) byJob[r.jobName] = r;
  }
  const out: Record<string, JobRunSummary> = {};
  for (const [job, r] of Object.entries(byJob)) {
    out[job] = {
      lastStartedAt: r.startedAt.toISOString(),
      lastFinishedAt: r.finishedAt?.toISOString() ?? null,
      lastStatus: r.status,
      lastDurationMs: r.durationMs ?? null,
      lastErrorExcerpt: excerpt(r.errorMessage),
    };
  }
  return out;
}

function computeVerdict(input: {
  dbOk: boolean;
  heartbeatRow: { lastSeenAt: Date | null } | null;
  heartbeatFresh: boolean;
  runtimeHealth: Record<string, unknown> | null;
  status: string | null;
  lifecycleStatus: string | null;
  globalAutomationEnabled: boolean | null;
  operatorReadiness: { safeToAutomate?: boolean; automationPermitted?: boolean } | null;
  streamsSocketOpen: boolean | null;
  dataFlowHealthy: boolean | null;
  runtimeSafetyState: string | null;
  paperCount24h: number;
  recentPaperTickSuccess: boolean;
}): { verdict: Verdict; why: string[] } {
  const why: string[] = [];
  if (!input.dbOk) {
    why.push("Database unreachable or query failed.");
    return { verdict: "BROKEN", why };
  }
  if (!input.heartbeatRow?.lastSeenAt) {
    why.push("No WorkerHeartbeat row for worker (worker may not be running or DB not wired).");
    return { verdict: "BROKEN", why };
  }
  if (!input.heartbeatFresh) {
    why.push(`Worker heartbeat stale (older than ${HEARTBEAT_FRESH_MS}ms).`);
    return { verdict: "DEGRADED", why };
  }
  if (!input.runtimeHealth) {
    why.push("Heartbeat present but runtimeHealth missing (USE_STREAM_RUNTIME off or runtime not reporting).");
    return { verdict: "DEGRADED", why };
  }
  if (input.status === "degraded" || input.lifecycleStatus === "degraded") {
    why.push("Runtime status/lifecycle is degraded.");
    return { verdict: "DEGRADED", why };
  }
  if (input.runtimeSafetyState === "blocked" || input.runtimeSafetyState === "degraded") {
    why.push(`runtimeSafety.state=${input.runtimeSafetyState}.`);
    return { verdict: "DEGRADED", why };
  }
  const ga = input.globalAutomationEnabled;
  if (ga == null) {
    why.push("globalAutomationEnabled unknown (missing from runtimeHealth snapshot).");
    return { verdict: "DEGRADED", why };
  }
  if (ga === false) {
    why.push("globalAutomationEnabled=false (kill-switch / automation disabled at last heartbeat snapshot).");
    why.push("Paper vs live: this report only uses runtime heartbeat + DB; live trading remains gated separately.");
    return { verdict: "BOOTED_BUT_FROZEN", why };
  }
  if (input.operatorReadiness && input.operatorReadiness.safeToAutomate === false) {
    why.push("operatorHealth.readiness.safeToAutomate=false (reconciliation / readiness / data flow gating).");
    if (input.lifecycleStatus === "ready" || input.status === "ready") {
      return { verdict: "BOOTED_BUT_FROZEN", why };
    }
  }
  if (input.streamsSocketOpen === false) {
    why.push("Both websockets not open per streams.socketOpen.");
    return { verdict: "DEGRADED", why };
  }
  if (input.dataFlowHealthy === false) {
    why.push("streams.dataFlowHealthy=false (market/user data flow not healthy).");
    return { verdict: "DEGRADED", why };
  }
  const idle =
    input.paperCount24h === 0 &&
    !input.recentPaperTickSuccess &&
    (input.status === "ready" || input.lifecycleStatus === "ready");
  if (idle) {
    why.push("Runtime appears ready and automation enabled; no paper trades in 24h and no recent paper_trading_tick success in sampled runs.");
    return { verdict: "HEALTHY_BUT_IDLE", why };
  }
  why.push("Runtime ready, heartbeat fresh, automation enabled, and there is recent paper/job activity or trades.");
  return { verdict: "HEALTHY_AND_OPERATING", why };
}

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });
  const generatedAt = new Date().toISOString();
  const now = Date.now();

  let dbOk = true;
  let hb: { lastSeenAt: Date; status: string; metadataJson: string | null } | null = null;
  try {
    hb = await prisma.workerHeartbeat.findUnique({
      where: { workerName: WORKER_NAME },
      select: { lastSeenAt: true, status: true, metadataJson: true },
    });
  } catch {
    dbOk = false;
  }

  const meta = parseHeartbeatMetadataJson(hb?.metadataJson ?? undefined);
  const runtimeHealth = (meta?.runtimeHealth ?? null) as Record<string, unknown> | null;
  const runtimeSafety = asRecord(meta?.runtimeSafety);
  const liveReadiness = asRecord(meta?.liveReadiness);

  const canonical = extractCanonicalWorkerRuntime(meta);
  const heartbeatFresh = hb ? heartbeatIsFresh(hb.lastSeenAt, now, HEARTBEAT_FRESH_MS) : false;

  const status = typeof runtimeHealth?.status === "string" ? runtimeHealth.status : null;
  const lifecycleStatus =
    typeof runtimeHealth?.lifecycleStatus === "string" ? runtimeHealth.lifecycleStatus : null;
  const degradedReasons = Array.isArray(runtimeHealth?.degradedReasons)
    ? (runtimeHealth!.degradedReasons as string[])
    : [];
  const truthModelStatus = runtimeHealth?.truthModelStatus ?? null;
  const truthModelPresent = truthModelStatus != null;

  const streams = asRecord(runtimeHealth?.streams);
  const marketConn = asRecord(streams?.marketConnection);
  const userConn = asRecord(streams?.userConnection);
  const marketStatus = typeof marketConn?.status === "string" ? marketConn.status : null;
  const userStatus = typeof userConn?.status === "string" ? userConn.status : null;
  const streamsSocketOpen = typeof streams?.socketOpen === "boolean" ? streams.socketOpen : null;
  const dataFlowHealthy = typeof streams?.dataFlowHealthy === "boolean" ? streams.dataFlowHealthy : null;
  const globalAutomationEnabled =
    typeof runtimeHealth?.globalAutomationEnabled === "boolean" ? runtimeHealth.globalAutomationEnabled : null;

  const operatorHealth = asRecord(runtimeHealth?.operatorHealth);
  const opReadiness = asRecord(operatorHealth?.readiness);
  const opKs = asRecord(operatorHealth?.killSwitch);
  const operatorReadiness = operatorHealth
    ? {
        runtimePhase: typeof opReadiness?.runtimePhase === "string" ? opReadiness.runtimePhase : null,
        operationalReadiness:
          typeof opReadiness?.operationalReadiness === "boolean" ? opReadiness.operationalReadiness : null,
        automationPermitted:
          typeof opReadiness?.automationPermitted === "boolean" ? opReadiness.automationPermitted : null,
        safeToAutomate: typeof opReadiness?.safeToAutomate === "boolean" ? opReadiness.safeToAutomate : null,
      }
    : null;

  const killSwitchTripped = typeof opKs?.tripped === "boolean" ? opKs.tripped : null;
  const killSwitchReasonsListed = Array.isArray(opKs?.reasons) ? (opKs!.reasons as string[]) : [];

  const marketSub = asRecord(runtimeHealth?.marketSubscriptionCoverage);
  const subscriptionInSync = typeof marketSub?.inSync === "boolean" ? marketSub.inSync : null;

  const runtimeModeFromHealth =
    typeof runtimeHealth?.mode === "string" ? runtimeHealth.mode : null;
  const runtimeModeConfig =
    typeof runtimeHealth?.runtimeMode === "string" ? runtimeHealth.runtimeMode : null;
  const workerRuntimeModeEnv = process.env.RUNTIME_MODE ?? null;

  /** Inference only: heartbeat does not store kill-switch reason string; default_safe is inferred from automation + phase. */
  const inferredDefaultSafeStillActive =
    globalAutomationEnabled === false &&
    (lifecycleStatus === "ready" || status === "ready") &&
    degradedReasons.length === 0;
  const inferredDefaultSafeAutoClearedLikely =
    globalAutomationEnabled === true &&
    (lifecycleStatus === "ready" || status === "ready") &&
    streamsSocketOpen === true;

  const runtimeSafetyState = typeof runtimeSafety?.state === "string" ? runtimeSafety.state : null;
  const runtimeSafetyBlocking = Array.isArray(runtimeSafety?.blockingReasons)
    ? (runtimeSafety!.blockingReasons as string[])
    : [];

  let blockingReasonIfFrozen: string | null = null;
  if (globalAutomationEnabled === false) {
    blockingReasonIfFrozen =
      runtimeSafetyBlocking.length > 0
        ? `runtimeSafety.blockingReasons: ${runtimeSafetyBlocking.slice(0, 5).join("; ")}`
        : "globalAutomationEnabled=false (kill-switch tripped; see worker logs for precise stop reason — not fully mirrored in heartbeat).";
  } else if (operatorReadiness?.safeToAutomate === false) {
    blockingReasonIfFrozen =
      "operatorHealth.readiness.safeToAutomate=false (typical causes: reconciliation not fresh/healthy, data flow, or operational readiness).";
  }

  let recentRuns: Array<{
    id: string;
    jobName: string;
    status: string;
    startedAt: Date;
    finishedAt: Date | null;
    durationMs: number | null;
    errorMessage: string | null;
  }> = [];
  let runningJobs: Array<{ jobName: string; startedAt: string; ageMs: number; possiblyStalled: boolean }> = [];
  if (dbOk) {
    try {
      recentRuns = await prisma.scheduledJobRun.findMany({
        orderBy: { startedAt: "desc" },
        take: RECENT_RUNS_LIMIT,
        select: {
          id: true,
          jobName: true,
          status: true,
          startedAt: true,
          finishedAt: true,
          durationMs: true,
          errorMessage: true,
        },
      });
      const runningRows = await prisma.scheduledJobRun.findMany({
        where: { status: "running" },
        select: { jobName: true, startedAt: true },
        orderBy: { startedAt: "asc" },
        take: 50,
      });
      runningJobs = runningRows.map((r) => {
        const interval =
          r.jobName in JOB_INTERVALS_MS
            ? JOB_INTERVALS_MS[r.jobName as keyof typeof JOB_INTERVALS_MS]
            : 15 * 60 * 1000;
        const stallMs = Math.max(15 * 60 * 1000, interval * RUNNING_STALL_MULT);
        const ageMs = now - r.startedAt.getTime();
        return {
          jobName: r.jobName,
          startedAt: r.startedAt.toISOString(),
          ageMs,
          possiblyStalled: ageMs > stallMs,
        };
      });
    } catch {
      /* keep empty */
    }
  }

  const runsFlat = recentRuns.map((r) => ({
    jobName: r.jobName,
    status: r.status,
    startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
    durationMs: r.durationMs ?? null,
    errorExcerpt: excerpt(r.errorMessage),
  }));

  const byJobSummary = summarizeRunsByJob(recentRuns);

  const selfImprovementLatest: Record<string, JobRunSummary | null> = {};
  for (const j of SELF_IMPROVEMENT_JOB_NAMES) {
    selfImprovementLatest[j] = byJobSummary[j] ?? null;
  }

  const paperWindows = {
    h1: new Date(now - 60 * 60 * 1000),
    h24: new Date(now - 24 * 60 * 60 * 1000),
    d7: new Date(now - 7 * 24 * 60 * 60 * 1000),
  };
  let paperCount1h = 0;
  let paperCount24h = 0;
  let paperCount7d = 0;
  let latestPaper: {
    id: string;
    status: string;
    createdAt: string;
    entryTime: string;
    exitTime: string | null;
    updatedAt: string;
  } | null = null;
  if (dbOk) {
    try {
      ;[paperCount1h, paperCount24h, paperCount7d] = await Promise.all([
        prisma.paperTrade.count({ where: { createdAt: { gte: paperWindows.h1 } } }),
        prisma.paperTrade.count({ where: { createdAt: { gte: paperWindows.h24 } } }),
        prisma.paperTrade.count({ where: { createdAt: { gte: paperWindows.d7 } } }),
      ]);
      const lp = await prisma.paperTrade.findFirst({
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          status: true,
          createdAt: true,
          entryTime: true,
          exitTime: true,
          updatedAt: true,
        },
      });
      latestPaper = lp
        ? {
            id: lp.id,
            status: lp.status,
            createdAt: lp.createdAt.toISOString(),
            entryTime: lp.entryTime.toISOString(),
            exitTime: lp.exitTime?.toISOString() ?? null,
            updatedAt: lp.updatedAt.toISOString(),
          }
        : null;
    } catch {
      /* ignore */
    }
  }

  const recentPaperTick = recentRuns.find((r) => r.jobName === "paper_trading_tick");
  const recentPaperTickSuccess =
    recentPaperTick?.status === "success" &&
    recentPaperTick.startedAt.getTime() > now - 2 * 60 * 60 * 1000;

  let latestShadow: {
    id: string;
    createdAt: string;
    wasBlocked: boolean;
    wasSubmitted: boolean;
    candidateSource: string;
    blockingReasonsPresent: boolean;
  } | null = null;
  if (dbOk) {
    try {
      const sc = await prisma.shadowCandidate.findFirst({
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          createdAt: true,
          wasBlocked: true,
          wasSubmitted: true,
          candidateSource: true,
          blockingReasons: true,
        },
      });
      latestShadow = sc
        ? {
            id: sc.id,
            createdAt: sc.createdAt.toISOString(),
            wasBlocked: sc.wasBlocked,
            wasSubmitted: sc.wasSubmitted,
            candidateSource: sc.candidateSource,
            blockingReasonsPresent: sc.blockingReasons != null,
          }
        : null;
    } catch {
      /* ignore */
    }
  }

  let paperPipelineEvidence: "progressing" | "idle" | "blocked" | "unknown" = "unknown";
  if (!dbOk) paperPipelineEvidence = "unknown";
  else if (recentRuns.some((r) => r.jobName === "paper_trading_tick" && r.status === "failure"))
    paperPipelineEvidence = "blocked";
  else if (paperCount1h > 0 || recentPaperTickSuccess) paperPipelineEvidence = "progressing";
  else if (paperCount24h === 0 && !recentPaperTickSuccess) paperPipelineEvidence = "idle";

  const base = DEFAULT_APP_BASE.replace(/\/$/, "");
  const apiChecks = await Promise.all([
    httpCheck("GET /api/health", `${base}/api/health`),
    httpCheck("GET /api/ops/runtime/health", `${base}/api/ops/runtime/health`),
    httpCheck("GET /api/ops/live-readiness", `${base}/api/ops/live-readiness`),
    httpCheck("GET /api/polymarket/sync-stats", `${base}/api/polymarket/sync-stats`),
  ]);

  const { verdict, why } = computeVerdict({
    dbOk,
    heartbeatRow: hb,
    heartbeatFresh,
    runtimeHealth,
    status,
    lifecycleStatus,
    globalAutomationEnabled,
    operatorReadiness: operatorReadiness
      ? {
          safeToAutomate: operatorReadiness.safeToAutomate ?? undefined,
          automationPermitted: operatorReadiness.automationPermitted ?? undefined,
        }
      : null,
    streamsSocketOpen,
    dataFlowHealthy,
    runtimeSafetyState,
    paperCount24h,
    recentPaperTickSuccess: !!recentPaperTickSuccess,
  });

  const report = {
    generatedAt,
    assumptions: {
      heartbeatWorkerName: WORKER_NAME,
      heartbeatFreshThresholdMs: HEARTBEAT_FRESH_MS,
      validationAppBaseUrl: base,
      containerRestartWindow:
        "Not available from DB; paper/shadow timestamps are wall-clock only (correlate with docker inspect if needed).",
    },
    A_runtimeReadiness: {
      currentRuntimeStatus: status,
      lifecycleStatus,
      degradedReasons,
      runtimeMarkedReady: status === "ready" || lifecycleStatus === "ready",
      truthModelStatusPresent: truthModelPresent,
      truthModelStatusSummary: truthModelPresent ? "present (see runtimeHealth.truthModelStatus in raw snapshot if needed)" : null,
      latestHeartbeatAt: hb?.lastSeenAt?.toISOString() ?? null,
      heartbeatFresh,
      workerRuntimeModeFromHeartbeat: {
        modePaperOrLive: runtimeModeFromHealth,
        runtimeModeConfig: runtimeModeConfig,
        note: "RUNTIME_MODE from this process .env (may differ from worker container if not using same env file)",
        runEnvRuntimeMode: workerRuntimeModeEnv,
      },
      reconciliationCanonical: canonical,
    },
    B_killSwitchAutomation: {
      globalAutomationEnabled,
      killSwitchTrippedFromOperatorHealth: killSwitchTripped,
      operatorKillSwitchReasonsFieldNote:
        "operatorHealth.killSwitch.reasons carries watchdog reasons in current code (not the private kill-switch stop string).",
      automationPermitted: operatorReadiness?.automationPermitted ?? null,
      safeToAutomate: operatorReadiness?.safeToAutomate ?? null,
      runtimeStillFrozenFromAutomationPerspective: globalAutomationEnabled === false,
      inferredDefaultSafeAutoClearLikely: inferredDefaultSafeAutoClearedLikely,
      inferredDefaultSafeStillActive,
      preciseBlockingReasonIfFrozen: blockingReasonIfFrozen,
      runtimeSafety: {
        state: runtimeSafetyState,
        blockingReasons: runtimeSafetyBlocking.slice(0, 20),
      },
    },
    C_websocketDataflow: {
      marketWebsocket: { status: marketStatus },
      userWebsocket: { status: userStatus },
      bothSocketsOpen: streamsSocketOpen,
      dataFlowHealthy,
      operationalReadinessStreams: typeof streams?.operationalReadiness === "boolean" ? streams.operationalReadiness : null,
      subscriptionCoverageInSync: subscriptionInSync,
      evidenceTimestamps: {
        marketLastDataEventAt: typeof streams?.marketLastDataEventAt === "string" ? streams.marketLastDataEventAt : null,
        userLastDataEventAt: typeof streams?.userLastDataEventAt === "string" ? streams.userLastDataEventAt : null,
        marketLastHeartbeatAt:
          typeof streams?.marketLastHeartbeatAt === "string" ? streams.marketLastHeartbeatAt : null,
        userLastHeartbeatAt: typeof streams?.userLastHeartbeatAt === "string" ? streams.userLastHeartbeatAt : null,
      },
      operatorHealthConnection: operatorHealth?.connection ?? null,
      operatorHealthDataFreshness: operatorHealth?.dataFreshness ?? null,
    },
    D_scheduledJobs: {
      recentRunsLimit: RECENT_RUNS_LIMIT,
      recentRuns: runsFlat,
      summarizeByJobFromRecentWindow: byJobSummary,
      selfImprovementRelatedLatest: selfImprovementLatest,
      knownJobNamesCount: JOB_NAMES.length,
      currentlyRunning: runningJobs,
      stallRule: `running row older than max(15m, ${RUNNING_STALL_MULT}×job interval) => possiblyStalled`,
    },
    E_paperTrading: {
      counts: { last1h: paperCount1h, last24h: paperCount24h, last7d: paperCount7d },
      latestPaperTrade: latestPaper,
      paperPipelineEvidence,
      latestShadowCandidate: latestShadow,
    },
    F_apiValidation: {
      checks: apiChecks,
      allPassed: apiChecks.every((c) => c.ok),
    },
    G_verdict: {
      verdict,
      why,
      liveReadinessFromHeartbeat: liveReadiness
        ? {
            overallState: liveReadiness.overallState,
            allowLiveTrading: liveReadiness.allowLiveTrading,
            blockingReasons: Array.isArray(liveReadiness.blockingReasons)
              ? (liveReadiness.blockingReasons as string[]).slice(0, 15)
              : [],
          }
        : null,
      noteLiveVsPaper:
        "Verdict is based on worker heartbeat + DB observability for the paper/runtime path; live trading gates are separate (liveReadiness.allowLiveTrading).",
    },
  };

  const md: string[] = [];
  md.push("# Post-boot runtime validation");
  md.push("");
  md.push(`**Generated:** ${generatedAt}`);
  md.push("");
  md.push(`## Verdict: **${verdict}**`);
  md.push("");
  for (const w of why) md.push(`- ${w}`);
  md.push("");
  md.push("## A — Runtime readiness (summary)");
  md.push("");
  md.push(`| Field | Value |`);
  md.push(`|------|-------|`);
  md.push(`| status / lifecycle | ${status ?? "—"} / ${lifecycleStatus ?? "—"} |`);
  md.push(`| ready? | ${report.A_runtimeReadiness.runtimeMarkedReady ? "yes" : "no"} |`);
  md.push(`| heartbeat @ | ${report.A_runtimeReadiness.latestHeartbeatAt ?? "—"} |`);
  md.push(`| heartbeat fresh? | ${heartbeatFresh ? "yes" : "no"} |`);
  md.push(`| truth model present? | ${truthModelPresent ? "yes" : "no"} |`);
  md.push(`| degraded reasons (count) | ${degradedReasons.length} |`);
  md.push("");
  md.push("## B — Automation / kill-switch");
  md.push("");
  md.push(`- **globalAutomationEnabled:** ${globalAutomationEnabled ?? "unknown"}`);
  md.push(`- **safeToAutomate:** ${operatorReadiness?.safeToAutomate ?? "unknown"}`);
  md.push(`- **Blocking (if frozen):** ${blockingReasonIfFrozen ?? "—"}`);
  md.push("");
  md.push("## C — Websockets");
  md.push("");
  md.push(`- market: **${marketStatus ?? "unknown"}** · user: **${userStatus ?? "unknown"}**`);
  md.push(`- socketOpen: **${streamsSocketOpen ?? "unknown"}** · dataFlowHealthy: **${dataFlowHealthy ?? "unknown"}**`);
  md.push(`- subscription inSync: **${subscriptionInSync ?? "unknown"}**`);
  md.push("");
  md.push("## D — Scheduled jobs (latest window)");
  md.push("");
  md.push(`- Running (possibly stalled): **${runningJobs.filter((j) => j.possiblyStalled).length}** / ${runningJobs.length}`);
  md.push(`- Recent runs listed: **${runsFlat.length}** (see JSON for detail)`);
  md.push("");
  md.push("## E — Paper / shadow");
  md.push("");
  md.push(`- Paper trades: 1h=${paperCount1h} · 24h=${paperCount24h} · 7d=${paperCount7d}`);
  md.push(`- Pipeline evidence: **${paperPipelineEvidence}**`);
  md.push("");
  md.push("## F — API checks");
  md.push("");
  for (const c of apiChecks) {
    md.push(`- **${c.name}** → ${c.ok ? "PASS" : "FAIL"}${c.status != null ? ` (${c.status})` : ""}${c.errorExcerpt ? ` — ${c.errorExcerpt}` : ""}`);
  }
  md.push("");

  const jsonPath = path.join(DUMP_DIR, "post-boot-runtime-validation-report.json");
  const mdPath = path.join(DUMP_DIR, "post-boot-runtime-validation-report.md");
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");
  await fs.writeFile(mdPath, md.join("\n"), "utf8");
  console.log("Wrote dump/post-boot-runtime-validation-report.{json,md}");

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("create-post-boot-runtime-validation-report failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
