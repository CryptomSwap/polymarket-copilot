/**
 * Bounded runtime stabilization report (read-only, deterministic).
 *
 * Writes:
 * - dump/runtime-stabilization-report.json
 * - dump/runtime-stabilization-report.md
 *
 * npm run dump:runtime-stabilization-report
 *
 * Summarizes post-patch observability: heartbeat, truth/reconciliation metadata, WS snapshot,
 * selected scheduled jobs, and recent shadow/paper candidates with blocking reasons.
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
const HEARTBEAT_FRESH_MS = Number(process.env.STABILIZATION_HEARTBEAT_FRESH_MS ?? "90000") || 90_000;
const CANDIDATE_LIMIT = 20;

const JOBS_OF_INTEREST = [
  "user_sync",
  "order_reconciliation",
  "stream_repair",
  "market_sync",
  "paper_trading_tick",
  "position_decision_recompute",
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

function parseBlockingReasonsJson(raw: unknown): string[] {
  if (raw == null) return [];
  if (Array.isArray(raw)) {
    return raw.filter((x): x is string => typeof x === "string").slice(0, 25);
  }
  if (typeof raw === "string") {
    try {
      return parseBlockingReasonsJson(JSON.parse(raw) as unknown);
    } catch {
      const e = excerpt(raw, 300);
      return e ? [e] : [];
    }
  }
  return [];
}

function summarizeReasonCounts(rows: { reasons: string[] }[]): { reason: string; count: number }[] {
  const m = new Map<string, number>();
  for (const r of rows) {
    for (const x of r.reasons) {
      m.set(x, (m.get(x) ?? 0) + 1);
    }
  }
  return [...m.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 25);
}

async function lastRunForJob(jobName: string): Promise<{
  status: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  errorExcerpt: string | null;
} | null> {
  const r = await prisma.scheduledJobRun.findFirst({
    where: { jobName },
    orderBy: { startedAt: "desc" },
    select: { status: true, startedAt: true, finishedAt: true, durationMs: true, errorMessage: true },
  });
  if (!r) return null;
  return {
    status: r.status,
    startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
    durationMs: r.durationMs ?? null,
    errorExcerpt: excerpt(r.errorMessage),
  };
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
    why.push("No WorkerHeartbeat row for worker.");
    return { verdict: "BROKEN", why };
  }
  if (!input.heartbeatFresh) {
    why.push(`Worker heartbeat stale (>${HEARTBEAT_FRESH_MS}ms).`);
    return { verdict: "DEGRADED", why };
  }
  if (!input.runtimeHealth) {
    why.push("runtimeHealth missing from heartbeat.");
    return { verdict: "DEGRADED", why };
  }
  if (input.status === "degraded" || input.lifecycleStatus === "degraded") {
    why.push("Runtime status/lifecycle degraded.");
    return { verdict: "DEGRADED", why };
  }
  if (input.runtimeSafetyState === "blocked" || input.runtimeSafetyState === "degraded") {
    why.push(`runtimeSafety.state=${input.runtimeSafetyState}.`);
    return { verdict: "DEGRADED", why };
  }
  const ga = input.globalAutomationEnabled;
  if (ga == null) {
    why.push("globalAutomationEnabled unknown.");
    return { verdict: "DEGRADED", why };
  }
  if (ga === false) {
    why.push("globalAutomationEnabled=false.");
    return { verdict: "BOOTED_BUT_FROZEN", why };
  }
  if (input.operatorReadiness && input.operatorReadiness.safeToAutomate === false) {
    why.push("operatorHealth.readiness.safeToAutomate=false.");
    if (input.lifecycleStatus === "ready" || input.status === "ready") {
      return { verdict: "BOOTED_BUT_FROZEN", why };
    }
  }
  if (input.streamsSocketOpen === false) {
    why.push("streams.socketOpen=false.");
    return { verdict: "DEGRADED", why };
  }
  if (input.dataFlowHealthy === false) {
    why.push("streams.dataFlowHealthy=false.");
    return { verdict: "DEGRADED", why };
  }
  const idle =
    input.paperCount24h === 0 &&
    !input.recentPaperTickSuccess &&
    (input.status === "ready" || input.lifecycleStatus === "ready");
  if (idle) {
    why.push("Ready automation on; no paper trades in 24h / no recent paper_trading_tick success in sample.");
    return { verdict: "HEALTHY_BUT_IDLE", why };
  }
  why.push("Ready, heartbeat fresh, automation path open, with recent activity.");
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
  const rhMeta = asRecord(runtimeHealth?.metadata);

  const canonical = extractCanonicalWorkerRuntime(meta);
  const heartbeatFresh = hb ? heartbeatIsFresh(hb.lastSeenAt, now, HEARTBEAT_FRESH_MS) : false;

  const status = typeof runtimeHealth?.status === "string" ? runtimeHealth.status : null;
  const lifecycleStatus =
    typeof runtimeHealth?.lifecycleStatus === "string" ? runtimeHealth.lifecycleStatus : null;
  const degradedReasons = Array.isArray(runtimeHealth?.degradedReasons)
    ? (runtimeHealth!.degradedReasons as string[])
    : [];
  const runtimeMarkedReady = status === "ready" || lifecycleStatus === "ready";
  const globalAutomationEnabled =
    typeof runtimeHealth?.globalAutomationEnabled === "boolean" ? runtimeHealth.globalAutomationEnabled : null;

  const operatorHealth = asRecord(runtimeHealth?.operatorHealth);
  const opReadiness = asRecord(operatorHealth?.readiness);
  const automationPermitted =
    typeof opReadiness?.automationPermitted === "boolean" ? opReadiness.automationPermitted : null;
  const safeToAutomate =
    typeof opReadiness?.safeToAutomate === "boolean" ? opReadiness.safeToAutomate : null;

  const streams = asRecord(runtimeHealth?.streams);
  const marketConn = asRecord(streams?.marketConnection);
  const userConn = asRecord(streams?.userConnection);
  const marketWsStatus = typeof marketConn?.status === "string" ? marketConn.status : null;
  const userWsStatus = typeof userConn?.status === "string" ? userConn.status : null;
  const marketLastData =
    typeof streams?.marketLastDataEventAt === "string" ? streams.marketLastDataEventAt : null;
  const userLastData =
    typeof streams?.userLastDataEventAt === "string" ? streams.userLastDataEventAt : null;
  const dataFlowHealthy = typeof streams?.dataFlowHealthy === "boolean" ? streams.dataFlowHealthy : null;
  const marketSub = asRecord(runtimeHealth?.marketSubscriptionCoverage);
  const subscriptionInSync = typeof marketSub?.inSync === "boolean" ? marketSub.inSync : null;
  const userSilenceReasonActive = degradedReasons.includes("user_data_silence_with_orders");

  const reconciliation = asRecord(runtimeHealth?.reconciliation);
  const lastRecAt =
    typeof reconciliation?.lastAt === "string" ? reconciliation.lastAt : null;
  const lastRecStatus = typeof reconciliation?.status === "string" ? reconciliation.status : null;
  const reconciliationFreshness =
    typeof reconciliation?.freshness === "string" ? reconciliation.freshness : null;

  const lastExchangeOrders =
    typeof rhMeta?.lastExchangeOrdersSnapshotAt === "string" ? rhMeta.lastExchangeOrdersSnapshotAt : null;
  const lastExchangeFills =
    typeof rhMeta?.lastExchangeFillsSnapshotAt === "string" ? rhMeta.lastExchangeFillsSnapshotAt : null;
  const lastUserTruth =
    typeof rhMeta?.lastSuccessfulUserTruthFetchAt === "string" ? rhMeta.lastSuccessfulUserTruthFetchAt : null;
  const reconciliationAlignmentReady =
    typeof rhMeta?.reconciliationAlignmentReady === "boolean" ? rhMeta.reconciliationAlignmentReady : null;

  const truthModel = asRecord(runtimeHealth?.truthModelStatus);
  const exchangeTruthHealthy =
    typeof truthModel?.exchangeTruthHealthy === "boolean" ? truthModel.exchangeTruthHealthy : null;

  const jobSnapshots: Record<string, Awaited<ReturnType<typeof lastRunForJob>>> = {};
  if (dbOk) {
    for (const j of JOBS_OF_INTEREST) {
      try {
        jobSnapshots[j] = await lastRunForJob(j);
      } catch {
        jobSnapshots[j] = null;
      }
    }
  }

  const pdr = jobSnapshots.position_decision_recompute;
  const positionRecomputeLikelyFixed =
    pdr == null
      ? null
      : pdr.status === "success"
        ? true
        : !(pdr.errorExcerpt ?? "").includes("markets' before initialization");

  let candidates: Array<{
    id: string;
    createdAt: string;
    wasBlocked: boolean;
    wasSubmitted: boolean;
    candidateSource: string;
    blockingReasonsConcise: string[];
  }> = [];
  let topBlocking: { reason: string; count: number }[] = [];
  if (dbOk) {
    try {
      const rows = await prisma.shadowCandidate.findMany({
        orderBy: { createdAt: "desc" },
        take: CANDIDATE_LIMIT,
        select: {
          id: true,
          createdAt: true,
          wasBlocked: true,
          wasSubmitted: true,
          candidateSource: true,
          blockingReasons: true,
        },
      });
      candidates = rows.map((r) => {
        const reasons = parseBlockingReasonsJson(r.blockingReasons);
        return {
          id: r.id,
          createdAt: r.createdAt.toISOString(),
          wasBlocked: r.wasBlocked,
          wasSubmitted: r.wasSubmitted,
          candidateSource: r.candidateSource,
          blockingReasonsConcise: reasons,
        };
      });
      topBlocking = summarizeReasonCounts(candidates.map((c) => ({ reasons: c.blockingReasonsConcise })));
    } catch {
      /* ignore */
    }
  }

  let paperCount24h = 0;
  let recentPaperTickSuccess = false;
  if (dbOk) {
    try {
      const since = new Date(now - 24 * 60 * 60 * 1000);
      paperCount24h = await prisma.paperTrade.count({ where: { createdAt: { gte: since } } });
      const tick = await prisma.scheduledJobRun.findFirst({
        where: { jobName: "paper_trading_tick", status: "success" },
        orderBy: { startedAt: "desc" },
        select: { startedAt: true },
      });
      recentPaperTickSuccess =
        !!tick && tick.startedAt.getTime() > now - 2 * 60 * 60 * 1000;
    } catch {
      /* ignore */
    }
  }

  const streamsSocketOpen = typeof streams?.socketOpen === "boolean" ? streams.socketOpen : null;

  const { verdict, why } = computeVerdict({
    dbOk,
    heartbeatRow: hb,
    heartbeatFresh,
    runtimeHealth,
    status,
    lifecycleStatus,
    globalAutomationEnabled,
    operatorReadiness: operatorHealth
      ? {
          safeToAutomate: safeToAutomate ?? undefined,
          automationPermitted: automationPermitted ?? undefined,
        }
      : null,
    streamsSocketOpen,
    dataFlowHealthy,
    runtimeSafetyState: typeof runtimeSafety?.state === "string" ? runtimeSafety.state : null,
    paperCount24h,
    recentPaperTickSuccess,
  });

  const report = {
    generatedAt,
    releasePatchSummary: {
      codeAreas: [
        "A) lib/position/recompute.ts — load markets before dependent queries (fixes TDZ / position_decision_recompute).",
        "B) lib/polymarket/ws-user.ts + lib/live/user-feed-normalizer.ts — classify user WS payloads (incl. type on nested payload); normalizeUserFeedMessage drives lastDataEventAt when applicable.",
        "C) lib/runtime/runtime-degraded.ts + lib/runtime/runtime-health.ts + worker/stream-runtime.ts — degraded/dataFlow align with recent user_sync REST + merge exchange snapshot times from scheduled jobs (lib/live/exchange-truth-snapshots.ts).",
        "D) lib/ops/scheduled-jobs.ts — user_sync requires persistedOk; records exchange snapshot globals; stream_repair stage1 requires persistedOk for truth stamps.",
      ],
      observed: {
        position_decision_recompute_lastRunStatus: pdr?.status ?? null,
        position_decision_recompute_lastErrorExcerpt: pdr?.errorExcerpt ?? null,
        inferredPositionRecomputeTdzResolved: positionRecomputeLikelyFixed,
        userLastDataEventAtPresent: userLastData != null,
        userDataFlowHealthy: dataFlowHealthy,
        userSilenceDegradedReasonStillPresent: userSilenceReasonActive,
      },
    },
    section1_fixedIssuesSummary: {
      position_decision_recompute: {
        lastRun: pdr,
        likelyTdzResolved: positionRecomputeLikelyFixed,
        note: "If last run predates deploy, re-run job or wait for next schedule.",
      },
      user_stream_data_events: {
        userLastDataEventAt: userLastData,
        dataFlowHealthy,
        user_data_silence_with_orders_still_in_degradedReasons: userSilenceReasonActive,
        note: "REST user truth + WS parsing fixes should clear silence when user_sync succeeds and/or WS emits normalized events.",
      },
      truth_freshness: {
        lastExchangeOrdersSnapshotAt: lastExchangeOrders,
        lastExchangeFillsSnapshotAt: lastExchangeFills,
        lastSuccessfulUserTruthFetchAt: lastUserTruth,
        exchangeTruthHealthy,
        reconciliationLastAt: lastRecAt,
        reconciliationStatus: lastRecStatus,
        reconciliationFreshness,
        reconciliationAlignmentReady,
      },
      remainingDegradedReasons: degradedReasons,
    },
    section2_runtimeHealth: {
      status,
      lifecycleStatus,
      runtimeMarkedReady,
      globalAutomationEnabled,
      automationPermitted,
      safeToAutomate,
      runtimeSafetyState: typeof runtimeSafety?.state === "string" ? runtimeSafety.state : null,
      runtimeSafetyBlockingReasons: Array.isArray(runtimeSafety?.blockingReasons)
        ? (runtimeSafety!.blockingReasons as string[]).slice(0, 25)
        : [],
      heartbeatLastSeenAt: hb?.lastSeenAt?.toISOString() ?? null,
      heartbeatFresh,
      workerCanonical: canonical,
    },
    section3_websocketDataflow: {
      marketWsStatus,
      userWsStatus,
      socketOpen: streamsSocketOpen,
      marketLastDataEventAt: marketLastData,
      userLastDataEventAt: userLastData,
      dataFlowHealthy,
      subscriptionCoverageInSync: subscriptionInSync,
      userSilenceReasonActive,
    },
    section4_truthReconciliation: {
      reconciliation: { lastAt: lastRecAt, status: lastRecStatus, freshness: reconciliationFreshness },
      exchangeTruthFromHeartbeat: {
        lastExchangeOrdersSnapshotAt: lastExchangeOrders,
        lastExchangeFillsSnapshotAt: lastExchangeFills,
        lastSuccessfulUserTruthFetchAt: lastUserTruth,
        exchangeTruthHealthy,
      },
      reconciliationAlignmentReady,
      note: "Timestamps come from worker heartbeat metadata (merged exchange snapshots + user truth).",
    },
    section5_scheduledJobs: jobSnapshots,
    section6_blockedCandidates: {
      limit: CANDIDATE_LIMIT,
      rows: candidates,
      topBlockingReasonsInWindow: topBlocking,
    },
    section7_verdict: { verdict, why },
  };

  const jsonPath = path.join(DUMP_DIR, "runtime-stabilization-report.json");
  const mdPath = path.join(DUMP_DIR, "runtime-stabilization-report.md");
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");

  const md: string[] = [];
  md.push("# Runtime stabilization report");
  md.push("");
  md.push(`Generated: **${generatedAt}**`);
  md.push("");
  md.push("## 1) Fixed issues (code + observed)");
  md.push(`- **position_decision_recompute:** last status \`${pdr?.status ?? "n/a"}\`${pdr?.errorExcerpt ? ` — error: ${pdr.errorExcerpt}` : ""}`);
  md.push(`- **User stream / data flow:** userLastDataEventAt=${userLastData ?? "—"} · dataFlowHealthy=${dataFlowHealthy ?? "—"} · user_silence reason active=${userSilenceReasonActive}`);
  md.push(
    `- **Truth / reconciliation:** orders@${lastExchangeOrders ?? "—"} · fills@${lastExchangeFills ?? "—"} · userTruth@${lastUserTruth ?? "—"} · reconciliation \`${lastRecStatus ?? "—"}\` @ ${lastRecAt ?? "—"}`
  );
  md.push(`- **Remaining degraded reasons:** ${degradedReasons.length ? degradedReasons.join(", ") : "—"}`);
  md.push("");
  md.push("## 2) Runtime health");
  md.push(`- status **${status ?? "—"}** · lifecycle **${lifecycleStatus ?? "—"}** · runtimeMarkedReady **${runtimeMarkedReady}**`);
  md.push(`- globalAutomationEnabled **${globalAutomationEnabled ?? "—"}** · automationPermitted **${automationPermitted ?? "—"}** · safeToAutomate **${safeToAutomate ?? "—"}**`);
  md.push(`- runtimeSafety **${typeof runtimeSafety?.state === "string" ? runtimeSafety.state : "—"}** · heartbeatFresh **${heartbeatFresh}**`);
  md.push("");
  md.push("## 3) Websockets");
  md.push(`- market **${marketWsStatus ?? "—"}** · user **${userWsStatus ?? "—"}** · socketOpen **${streamsSocketOpen ?? "—"}**`);
  md.push(`- market last data **${marketLastData ?? "—"}** · user last data **${userLastData ?? "—"}** · dataFlowHealthy **${dataFlowHealthy ?? "—"}**`);
  md.push(`- subscription in sync **${subscriptionInSync ?? "—"}**`);
  md.push("");
  md.push("## 4) Truth / reconciliation");
  md.push(`- reconciliationAlignmentReady **${reconciliationAlignmentReady ?? "—"}** · exchangeTruthHealthy **${exchangeTruthHealthy ?? "—"}**`);
  md.push("");
  md.push("## 5) Scheduled jobs (latest)");
  for (const j of JOBS_OF_INTEREST) {
    const s = jobSnapshots[j];
    md.push(
      `- **${j}:** ${s ? `${s.status} @ ${s.startedAt}${s.errorExcerpt ? ` — ${s.errorExcerpt}` : ""}` : "no row"}`
    );
  }
  md.push("");
  md.push("## 6) Recent candidates (blocking)");
  md.push(`Top reasons: ${topBlocking.length ? topBlocking.map((t) => `${t.reason}(${t.count})`).join(", ") : "—"}`);
  for (const c of candidates.slice(0, 10)) {
    md.push(
      `- ${c.createdAt} · blocked=${c.wasBlocked} submitted=${c.wasSubmitted} · ${c.candidateSource} · ${c.blockingReasonsConcise.join("; ") || "—"}`
    );
  }
  md.push("");
  md.push("## 7) Verdict");
  md.push(`**${verdict}**`);
  for (const w of why) md.push(`- ${w}`);

  await fs.writeFile(mdPath, md.join("\n"), "utf8");
  console.log("Wrote dump/runtime-stabilization-report.{json,md}");
}

main().catch((e) => {
  console.error("create-runtime-stabilization-report failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
