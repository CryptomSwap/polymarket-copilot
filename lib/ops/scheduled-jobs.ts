/**
 * Scheduled job definitions and execution. Used by the background worker and by POST /api/ops/run-job.
 * No autonomous trading; sync, recompute, and freshness only.
 */

import { prisma } from "../db";
import { CancelError, CANCEL_ERROR_CODES, runWithAbortScope } from "./cancellation";

export const JOB_NAMES = [
  "market_sync",
  "user_sync",
  "news_sync",
  "market_snapshot_capture",
  "recommendation_recompute",
  "decision_recompute",
  "order_reconciliation",
  "recommendation_evaluation",
  "position_decision_recompute",
  "stream_repair",
  "shadow_evaluation",
  "shadow_analysis",
  "ml_shadow_dataset_build",
  "ml_shadow_path_feature_backfill",
  "paper_trading_tick",
  "paper_trading_close_due",
  "policy_refresh_pending",
  "ml_shadow_retrain",
  "self_improving_paper_loop",
  "ml_shadow_bootstrap_activate",
  "ml_shadow_promote",
  "paper_config_optimize",
  "self_improvement_rollback_guard",
  "self_improvement_status_report",
] as const;

export type JobName = (typeof JOB_NAMES)[number];

export function isJobName(name: string): name is JobName {
  return (JOB_NAMES as readonly string[]).includes(name);
}

/** Intervals in ms for each job when running on a schedule. */
const USER_SYNC_INTERVAL_MS = Number(process.env.USER_SYNC_INTERVAL_MS ?? "60000") || 60_000;
export const JOB_INTERVALS_MS: Record<JobName, number> = {
  market_sync: 5 * 60 * 1000,
  user_sync: USER_SYNC_INTERVAL_MS,
  news_sync: 15 * 60 * 1000,
  market_snapshot_capture: 10 * 60 * 1000,
  recommendation_recompute: 15 * 60 * 1000,
  decision_recompute: 15 * 60 * 1000,
  order_reconciliation: 2 * 60 * 1000,
  recommendation_evaluation: 60 * 60 * 1000,
  position_decision_recompute: 10 * 60 * 1000,
  stream_repair: 5 * 60 * 1000,
  shadow_evaluation: 6 * 60 * 60 * 1000,
  shadow_analysis: 6 * 60 * 60 * 1000,
  ml_shadow_dataset_build: 6 * 60 * 60 * 1000,
  ml_shadow_path_feature_backfill: 12 * 60 * 60 * 1000,
  paper_trading_tick: 5 * 60 * 1000,
  paper_trading_close_due: 60 * 60 * 1000,
  /** Debounced signal/rec/snapshot refresh after BehaviorFlag changes (~1 funder per tick, max 4). */
  policy_refresh_pending: 90 * 1000,
  ml_shadow_retrain: 24 * 60 * 60 * 1000,
  /** Weekly full chain: eval → dataset → path backfill → retrain → bootstrap → promote → rollback (see runSelfImprovingPaperLoopJob). */
  self_improving_paper_loop: 7 * 24 * 60 * 60 * 1000,
  ml_shadow_bootstrap_activate: 24 * 60 * 60 * 1000,
  ml_shadow_promote: 24 * 60 * 60 * 1000,
  paper_config_optimize: 24 * 60 * 60 * 1000,
  self_improvement_rollback_guard: 6 * 60 * 60 * 1000,
  self_improvement_status_report: 6 * 60 * 60 * 1000,
};

const SHADOW_EVAL_MIN_AGE_MS_DEFAULT = 25 * 60 * 60 * 1000;
const SHADOW_EVAL_LIMIT_DEFAULT = 100;
const SHADOW_EVAL_LIMIT_CAP = 5000;
const SHADOW_EVAL_MIN_AGE_CAP_MS = 365 * 24 * 60 * 60 * 1000;

/** Optional shadow batch tuning. Invalid values ignored → safe defaults (fail-closed). */
function shadowEvalMinAgeMsFromEnv(): number {
  const raw = process.env.SHADOW_EVAL_MIN_AGE_MS;
  if (raw == null || String(raw).trim() === "") return SHADOW_EVAL_MIN_AGE_MS_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return SHADOW_EVAL_MIN_AGE_MS_DEFAULT;
  return Math.min(Math.floor(n), SHADOW_EVAL_MIN_AGE_CAP_MS);
}

function shadowEvalLimitFromEnv(): number {
  const raw = process.env.SHADOW_EVAL_LIMIT;
  if (raw == null || String(raw).trim() === "") return SHADOW_EVAL_LIMIT_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return SHADOW_EVAL_LIMIT_DEFAULT;
  return Math.min(Math.floor(n), SHADOW_EVAL_LIMIT_CAP);
}

export interface RunJobResult {
  runId: string;
  status: "success" | "failure";
  durationMs: number;
  error?: string;
}

type JobStage =
  | "fetch_start"
  | "fetch_ok"
  | "fetch_fail"
  | "db_write_start"
  | "db_write_ok"
  | "db_write_fail"
  | "reconciliation_start"
  | "reconciliation_ok"
  | "reconciliation_fail"
  | "repair_start"
  | "repair_ok"
  | "repair_fail"
  | "user_truth_marker_write_attempt"
  | "exchange_truth_write_attempt";

type JobRunBreadcrumb = {
  stage: JobStage;
  at: string;
  durationMs?: number;
  ok?: boolean;
  error?: string;
  meta?: Record<string, unknown>;
};

type UserTruthMarkerWriteAudit = {
  attemptedAt: string;
  jobName: "user_sync" | "stream_repair" | "other";
  success: boolean;
  dbWriteResult: Record<string, unknown> | null;
  transactionContext: string | null;
  markerValue: string | null;
  setCallsite: string;
  error?: string | null;
};

type ExchangeTruthWriteAudit = {
  attemptedAt: string;
  jobName: "user_sync" | "stream_repair" | "other";
  caller: string;
  success: boolean;
  valuesWritten: {
    ordersSnapshotAt: string | null;
    fillsSnapshotAt: string | null;
    exchangeTruthUnavailable: boolean | null;
  };
  sourcePath: string;
  transactionContext: string | null;
  error?: string | null;
};

type JobRunMetadata = {
  leaseId?: string;
  maxDurationMs?: number;
  recoveredRunIds?: string[];
  breadcrumbs?: JobRunBreadcrumb[];
  lastStage?: JobStage;
  timeout?: { at: string; label: string; maxDurationMs: number } | null;
};

async function readRunMetadata(runId: string): Promise<JobRunMetadata> {
  const row = await prisma.scheduledJobRun.findUnique({
    where: { id: runId },
    select: { metadataJson: true },
  });
  if (!row?.metadataJson) return {};
  try {
    return JSON.parse(row.metadataJson) as JobRunMetadata;
  } catch {
    return {};
  }
}

async function appendRunBreadcrumb(runId: string, breadcrumb: JobRunBreadcrumb): Promise<void> {
  const current = await readRunMetadata(runId);
  const breadcrumbs = Array.isArray(current.breadcrumbs) ? current.breadcrumbs.slice(0, 200) : [];
  breadcrumbs.push(breadcrumb);
  const next: JobRunMetadata = {
    ...current,
    breadcrumbs,
    lastStage: breadcrumb.stage,
  };
  await prisma.scheduledJobRun.update({
    where: { id: runId },
    data: { metadataJson: JSON.stringify(next) },
  });
}

async function appendUserTruthMarkerWriteAudit(
  runId: string,
  audit: UserTruthMarkerWriteAudit
): Promise<void> {
  await appendRunBreadcrumb(runId, {
    stage: "user_truth_marker_write_attempt",
    at: audit.attemptedAt,
    ok: audit.success,
    error: audit.error ?? undefined,
    meta: {
      ...audit,
    },
  });
}

async function appendExchangeTruthWriteAudit(runId: string, audit: ExchangeTruthWriteAudit): Promise<void> {
  await appendRunBreadcrumb(runId, {
    stage: "exchange_truth_write_attempt",
    at: audit.attemptedAt,
    ok: audit.success,
    error: audit.error ?? undefined,
    meta: {
      ...audit,
    },
  });
}

async function setRunTimeout(runId: string, data: JobRunMetadata["timeout"]): Promise<void> {
  const current = await readRunMetadata(runId);
  const next: JobRunMetadata = { ...current, timeout: data ?? null };
  await prisma.scheduledJobRun.update({
    where: { id: runId },
    data: { metadataJson: JSON.stringify(next) },
  });
}

export const JOB_MAX_DURATION_MS: Record<JobName, number> = {
  market_sync: 10 * 60 * 1000,
  user_sync: 3 * 60 * 1000,
  news_sync: 5 * 60 * 1000,
  market_snapshot_capture: 5 * 60 * 1000,
  recommendation_recompute: 5 * 60 * 1000,
  decision_recompute: 5 * 60 * 1000,
  order_reconciliation: 3 * 60 * 1000,
  recommendation_evaluation: 15 * 60 * 1000,
  position_decision_recompute: 5 * 60 * 1000,
  stream_repair: 6 * 60 * 1000,
  shadow_evaluation: 20 * 60 * 1000,
  shadow_analysis: 20 * 60 * 1000,
  ml_shadow_dataset_build: 30 * 60 * 1000,
  ml_shadow_path_feature_backfill: 45 * 60 * 1000,
  paper_trading_tick: 3 * 60 * 1000,
  paper_trading_close_due: 10 * 60 * 1000,
  policy_refresh_pending: 3 * 60 * 1000,
  ml_shadow_retrain: 45 * 60 * 1000,
  self_improving_paper_loop: 120 * 60 * 1000,
  ml_shadow_bootstrap_activate: 30 * 60 * 1000,
  ml_shadow_promote: 30 * 60 * 1000,
  paper_config_optimize: 20 * 60 * 1000,
  self_improvement_rollback_guard: 10 * 60 * 1000,
  self_improvement_status_report: 10 * 60 * 1000,
};

function isTimeoutError(err: unknown): boolean {
  if (err instanceof CancelError && err.code === CANCEL_ERROR_CODES.TIMEOUT) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return msg.startsWith("job_timeout:") || msg.startsWith("timeout:");
}

async function recoverStaleRunningRuns(jobName: JobName, maxDurationMs: number): Promise<{ recoveredRunIds: string[] }> {
  const cutoff = new Date(Date.now() - maxDurationMs);
  const stale = await prisma.scheduledJobRun.findMany({
    where: { jobName, status: "running", startedAt: { lt: cutoff } },
    select: { id: true },
  });
  if (stale.length === 0) return { recoveredRunIds: [] };
  const ids = stale.map((s) => s.id);
  await prisma.scheduledJobRun.updateMany({
    where: { id: { in: ids }, status: "running" },
    data: {
      status: "failure",
      finishedAt: new Date(),
      durationMs: maxDurationMs,
      errorMessage: `abandoned_stale_run:${maxDurationMs}ms`,
    },
  });
  return { recoveredRunIds: ids };
}

async function claimLease(params: { jobName: JobName; maxDurationMs: number }): Promise<{ leaseId: string } | null> {
  const now = new Date();
  const leaseId = `lease_${Math.random().toString(16).slice(2)}_${Date.now()}`;
  const expiresAt = new Date(now.getTime() + params.maxDurationMs);

  // Single atomic claim: only update the lease when expired; else do nothing.
  // If row does not exist, insert it.
  const rows = await prisma.$queryRaw<
    Array<{ jobName: string; leaseId: string; leaseExpiresAt: Date }>
  >`
    INSERT INTO "ScheduledJobLease" ("jobName","leaseId","leasedAt","leaseExpiresAt","lastHeartbeatAt","updatedAt")
    VALUES (${params.jobName}, ${leaseId}, ${now}, ${expiresAt}, ${now}, ${now})
    ON CONFLICT ("jobName") DO UPDATE
    SET "leaseId" = EXCLUDED."leaseId",
        "leasedAt" = EXCLUDED."leasedAt",
        "leaseExpiresAt" = EXCLUDED."leaseExpiresAt",
        "lastHeartbeatAt" = EXCLUDED."lastHeartbeatAt",
        "updatedAt" = EXCLUDED."updatedAt"
    WHERE "ScheduledJobLease"."leaseExpiresAt" < ${now}
    RETURNING "jobName","leaseId","leaseExpiresAt";
  `;
  if (!rows || rows.length === 0) return null;
  return { leaseId };
}

async function heartbeatLease(jobName: JobName, leaseId: string, extendMs: number): Promise<void> {
  const now = new Date();
  const nextExpiry = new Date(now.getTime() + extendMs);
  await prisma.scheduledJobLease.updateMany({
    where: { jobName, leaseId },
    data: { lastHeartbeatAt: now, leaseExpiresAt: nextExpiry },
  });
}

async function releaseLease(jobName: JobName, leaseId: string): Promise<void> {
  await prisma.scheduledJobLease.updateMany({
    where: { jobName, leaseId },
    data: { leaseExpiresAt: new Date(0), lastHeartbeatAt: new Date() },
  });
}

/**
 * Create a ScheduledJobRun, execute the job, update with status/duration. Safe for worker or API.
 */
export async function runScheduledJob(name: JobName): Promise<RunJobResult> {
  const startedAt = new Date();
  const maxDurationMs = JOB_MAX_DURATION_MS[name] ?? 5 * 60 * 1000;

  // Recover stale "running" rows before attempting a new run (auditable).
  const recovery = await recoverStaleRunningRuns(name, maxDurationMs);

  // Enforce true non-overlap across processes via DB lease.
  const lease = await claimLease({ jobName: name, maxDurationMs });
  if (!lease) {
    return { runId: "skipped_no_lease", status: "success", durationMs: 0 };
  }

  const run = await prisma.scheduledJobRun.create({
    data: {
      jobName: name,
      status: "running",
      startedAt,
      metadataJson: JSON.stringify({
        leaseId: lease.leaseId,
        maxDurationMs,
        recoveredRunIds: recovery.recoveredRunIds,
      }),
    },
  });

  try {
    // Link lease to this run for debugging/audit.
    await prisma.scheduledJobLease.updateMany({
      where: { jobName: name, leaseId: lease.leaseId },
      data: { lastRunId: run.id },
    });

    // Keep lease alive while job runs (prevents another runner from taking it).
    const hbInterval = setInterval(() => {
      void heartbeatLease(name, lease.leaseId, maxDurationMs).catch(() => {});
    }, Math.min(30_000, Math.max(5_000, Math.floor(maxDurationMs / 6))));

    try {
      await runWithAbortScope({
        label: `job:${name}`,
        timeoutMs: maxDurationMs,
        fn: async (signal) => await executeJob(name, { runId: run.id, signal }),
      });
    } finally {
      clearInterval(hbInterval);
    }
    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - startedAt.getTime();
    await prisma.scheduledJobRun.update({
      where: { id: run.id },
      data: {
        status: "success",
        finishedAt,
        durationMs,
      },
    });
    await releaseLease(name, lease.leaseId);
    return { runId: run.id, status: "success", durationMs };
  } catch (err) {
    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - startedAt.getTime();
    const errorMessage = err instanceof Error ? err.message : String(err);
    if (isTimeoutError(err)) {
      await setRunTimeout(run.id, { at: new Date().toISOString(), label: name, maxDurationMs });
    }
    await prisma.scheduledJobRun.update({
      where: { id: run.id },
      data: {
        status: "failure",
        finishedAt,
        durationMs,
        errorMessage,
      },
    });
    await releaseLease(name, lease.leaseId);
    return { runId: run.id, status: "failure", durationMs, error: errorMessage };
  }
}

async function executeJob(name: JobName, ctx: { runId: string; signal: AbortSignal }): Promise<void> {
  const { getFunderForRecompute } = await import("../polymarket/recompute");

  switch (name) {
    case "market_sync": {
      const { syncMarkets } = await import("../polymarket/markets");
      await syncMarkets({ limit: 100, maxPages: 5 });
      break;
    }
    case "user_sync": {
      const { syncUser } = await import("../polymarket/user-sync");
      const { setLastSuccessfulUserTruthFetchAt } = await import("../live/user-truth-freshness");
      const { recordExchangeFillsSnapshotSuccess, recordExchangeOrdersSnapshotSuccess } = await import(
        "../live/exchange-truth-snapshots"
      );
      const t0 = Date.now();
      await appendRunBreadcrumb(ctx.runId, { stage: "fetch_start", at: new Date().toISOString(), meta: { jobName: name } });
      try {
        const res = await syncUser({
          maxTradesPages: Number(process.env.USER_SYNC_MAX_TRADES_PAGES ?? "3") || 3,
          requestTimeoutMs: Number(process.env.USER_SYNC_REQUEST_TIMEOUT_MS ?? "20000") || 20_000,
          requestRetries: Number(process.env.USER_SYNC_REQUEST_RETRIES ?? "2") || 2,
          signal: ctx.signal,
        });
        const fetchOk = res.ordersStatus === 200 && res.fillsStatus === 200;
        const persistedOk = res.errors.length === 0;
        if (!fetchOk || !persistedOk) {
          const firstErr = res.errors[0] ?? "unknown";
          throw new Error(`user_sync_incomplete: fetchOk=${fetchOk} persistedOk=${persistedOk} firstError=${firstErr}`);
        }
        await appendRunBreadcrumb(ctx.runId, {
          stage: "fetch_ok",
          at: new Date().toISOString(),
          durationMs: Date.now() - t0,
          ok: true,
          meta: { persistedOk, errorsCount: res.errors.length, firstError: res.errors[0] ?? null },
        });
        const at = new Date();
        setLastSuccessfulUserTruthFetchAt(at);
        await appendUserTruthMarkerWriteAudit(ctx.runId, {
          attemptedAt: at.toISOString(),
          jobName: "user_sync",
          success: true,
          dbWriteResult: {
            ordersStatus: res.ordersStatus,
            fillsStatus: res.fillsStatus,
            ordersPersisted: res.ordersPersisted,
            fillsSynced: res.fillsSynced,
            positionsSynced: res.positionsSynced,
            errorsCount: res.errors.length,
          },
          transactionContext: null,
          markerValue: at.toISOString(),
          setCallsite: "lib/ops/scheduled-jobs.ts:user_sync",
          error: null,
        });
        recordExchangeOrdersSnapshotSuccess(at);
        recordExchangeFillsSnapshotSuccess(at);
        await appendExchangeTruthWriteAudit(ctx.runId, {
          attemptedAt: at.toISOString(),
          jobName: "user_sync",
          caller: "recordExchangeOrdersSnapshotSuccess + recordExchangeFillsSnapshotSuccess",
          success: true,
          valuesWritten: {
            ordersSnapshotAt: at.toISOString(),
            fillsSnapshotAt: at.toISOString(),
            exchangeTruthUnavailable: null,
          },
          sourcePath: "lib/ops/scheduled-jobs.ts:user_sync",
          transactionContext: null,
          error: null,
        });
      } catch (e) {
        await appendUserTruthMarkerWriteAudit(ctx.runId, {
          attemptedAt: new Date().toISOString(),
          jobName: "user_sync",
          success: false,
          dbWriteResult: null,
          transactionContext: null,
          markerValue: null,
          setCallsite: "lib/ops/scheduled-jobs.ts:user_sync",
          error: e instanceof Error ? e.message : String(e),
        });
        await appendExchangeTruthWriteAudit(ctx.runId, {
          attemptedAt: new Date().toISOString(),
          jobName: "user_sync",
          caller: "recordExchangeOrdersSnapshotSuccess + recordExchangeFillsSnapshotSuccess",
          success: false,
          valuesWritten: {
            ordersSnapshotAt: null,
            fillsSnapshotAt: null,
            exchangeTruthUnavailable: null,
          },
          sourcePath: "lib/ops/scheduled-jobs.ts:user_sync",
          transactionContext: null,
          error: e instanceof Error ? e.message : String(e),
        });
        await appendRunBreadcrumb(ctx.runId, { stage: "fetch_fail", at: new Date().toISOString(), durationMs: Date.now() - t0, ok: false, error: e instanceof Error ? e.message : String(e) });
        throw e;
      }
      break;
    }
    case "news_sync": {
      const { runNewsSync } = await import("../news/sync");
      await runNewsSync();
      break;
    }
    case "market_snapshot_capture": {
      const { captureMarketSnapshots } = await import("../polymarket/market-snapshots");
      await captureMarketSnapshots();
      break;
    }
    case "recommendation_recompute": {
      const { recomputeRecommendations } = await import("../polymarket/recommendations-recompute");
      await recomputeRecommendations();
      break;
    }
    case "decision_recompute": {
      const { recomputeDecisions } = await import("../decision/recompute");
      await recomputeDecisions();
      break;
    }
    case "order_reconciliation": {
      const { reconcileOrders } = await import("../polymarket/reconcile");
      const funder = await getFunderForRecompute();
      if (funder) {
        const t0 = Date.now();
        await appendRunBreadcrumb(ctx.runId, { stage: "reconciliation_start", at: new Date().toISOString(), meta: { funderAddress: funder } });
        try {
          await reconcileOrders(funder, { signal: ctx.signal });
          await appendRunBreadcrumb(ctx.runId, { stage: "reconciliation_ok", at: new Date().toISOString(), durationMs: Date.now() - t0, ok: true });
        } catch (e) {
          await appendRunBreadcrumb(ctx.runId, { stage: "reconciliation_fail", at: new Date().toISOString(), durationMs: Date.now() - t0, ok: false, error: e instanceof Error ? e.message : String(e) });
          throw e;
        }
      }
      break;
    }
    case "recommendation_evaluation": {
      const { evaluateRecommendations } = await import("../polymarket/recommendation-eval");
      await evaluateRecommendations();
      break;
    }
    case "position_decision_recompute": {
      const { recomputePositionDecisions } = await import("../position/recompute");
      await recomputePositionDecisions();
      break;
    }
    case "stream_repair": {
      const { syncUser } = await import("../polymarket/user-sync");
      const { reconcileOrders } = await import("../polymarket/reconcile");
      const { captureMarketSnapshots } = await import("../polymarket/market-snapshots");
      const { updateStreamSyncState } = await import("../live/streaming-sync");
      const { setLastSuccessfulUserTruthFetchAt } = await import("../live/user-truth-freshness");
      const { recordExchangeFillsSnapshotSuccess, recordExchangeOrdersSnapshotSuccess } = await import(
        "../live/exchange-truth-snapshots"
      );
      const repairStart = Date.now();
      await appendRunBreadcrumb(ctx.runId, { stage: "repair_start", at: new Date().toISOString() });
      try {
        const stage1BudgetMs = Number(process.env.STREAM_REPAIR_STAGE1_USER_TIMEOUT_MS ?? "60000") || 60_000;
        const stage2BudgetMs = Number(process.env.STREAM_REPAIR_STAGE2_RECON_TIMEOUT_MS ?? "60000") || 60_000;
        const stage3BudgetMs = Number(process.env.STREAM_REPAIR_STAGE3_DB_TIMEOUT_MS ?? "90000") || 90_000;

        // Stage 1: refresh user truth (bounded, cancellable).
        let stage1Ok = false;
        const userT0 = Date.now();
        await appendRunBreadcrumb(ctx.runId, { stage: "fetch_start", at: new Date().toISOString(), meta: { subtask: "syncUser", budgetMs: stage1BudgetMs } });
        try {
          const syncRes = await runWithAbortScope({
            label: "stream_repair:stage1_user_sync",
            parentSignal: ctx.signal,
            timeoutMs: stage1BudgetMs,
            fn: async (signal) =>
              await syncUser({
                maxTradesPages: Number(process.env.STREAM_REPAIR_MAX_TRADES_PAGES ?? "1") || 1,
                requestTimeoutMs: Number(process.env.STREAM_REPAIR_REQUEST_TIMEOUT_MS ?? "15000") || 15_000,
                requestRetries: Number(process.env.STREAM_REPAIR_REQUEST_RETRIES ?? "1") || 1,
                signal,
              }),
          });
          const fetchOk = syncRes.ordersStatus === 200 && syncRes.fillsStatus === 200;
          const persistedOk = syncRes.errors.length === 0;
          if (fetchOk && persistedOk) {
            stage1Ok = true;
            await appendRunBreadcrumb(ctx.runId, {
              stage: "fetch_ok",
              at: new Date().toISOString(),
              durationMs: Date.now() - userT0,
              ok: true,
              meta: { subtask: "syncUser", persistedOk, errorsCount: syncRes.errors.length, firstError: syncRes.errors[0] ?? null },
            });
            const at = new Date();
            setLastSuccessfulUserTruthFetchAt(at);
            await appendUserTruthMarkerWriteAudit(ctx.runId, {
              attemptedAt: at.toISOString(),
              jobName: "stream_repair",
              success: true,
              dbWriteResult: {
                ordersStatus: syncRes.ordersStatus,
                fillsStatus: syncRes.fillsStatus,
                ordersPersisted: syncRes.ordersPersisted,
                fillsSynced: syncRes.fillsSynced,
                positionsSynced: syncRes.positionsSynced,
                errorsCount: syncRes.errors.length,
              },
              transactionContext: "stream_repair:stage1_user_sync",
              markerValue: at.toISOString(),
              setCallsite: "lib/ops/scheduled-jobs.ts:stream_repair:stage1",
              error: null,
            });
            recordExchangeOrdersSnapshotSuccess(at);
            recordExchangeFillsSnapshotSuccess(at);
            await appendExchangeTruthWriteAudit(ctx.runId, {
              attemptedAt: at.toISOString(),
              jobName: "stream_repair",
              caller: "recordExchangeOrdersSnapshotSuccess + recordExchangeFillsSnapshotSuccess",
              success: true,
              valuesWritten: {
                ordersSnapshotAt: at.toISOString(),
                fillsSnapshotAt: at.toISOString(),
                exchangeTruthUnavailable: null,
              },
              sourcePath: "lib/ops/scheduled-jobs.ts:stream_repair:stage1",
              transactionContext: "stream_repair:stage1_user_sync",
              error: null,
            });
          } else {
            const firstErr = syncRes.errors[0] ?? "unknown";
            await appendUserTruthMarkerWriteAudit(ctx.runId, {
              attemptedAt: new Date().toISOString(),
              jobName: "stream_repair",
              success: false,
              dbWriteResult: {
                ordersStatus: syncRes.ordersStatus,
                fillsStatus: syncRes.fillsStatus,
                ordersPersisted: syncRes.ordersPersisted,
                fillsSynced: syncRes.fillsSynced,
                positionsSynced: syncRes.positionsSynced,
                errorsCount: syncRes.errors.length,
              },
              transactionContext: "stream_repair:stage1_user_sync",
              markerValue: null,
              setCallsite: "lib/ops/scheduled-jobs.ts:stream_repair:stage1",
              error: `user_sync_incomplete: fetchOk=${fetchOk} persistedOk=${persistedOk} firstError=${firstErr}`,
            });
            await appendExchangeTruthWriteAudit(ctx.runId, {
              attemptedAt: new Date().toISOString(),
              jobName: "stream_repair",
              caller: "recordExchangeOrdersSnapshotSuccess + recordExchangeFillsSnapshotSuccess",
              success: false,
              valuesWritten: {
                ordersSnapshotAt: null,
                fillsSnapshotAt: null,
                exchangeTruthUnavailable: null,
              },
              sourcePath: "lib/ops/scheduled-jobs.ts:stream_repair:stage1",
              transactionContext: "stream_repair:stage1_user_sync",
              error: `user_sync_incomplete: fetchOk=${fetchOk} persistedOk=${persistedOk} firstError=${firstErr}`,
            });
            await appendRunBreadcrumb(ctx.runId, {
              stage: "fetch_fail",
              at: new Date().toISOString(),
              durationMs: Date.now() - userT0,
              ok: false,
              error: `user_sync_incomplete: fetchOk=${fetchOk} persistedOk=${persistedOk} firstError=${firstErr}`,
              meta: { subtask: "syncUser" },
            });
          }
        } catch (e) {
          await appendUserTruthMarkerWriteAudit(ctx.runId, {
            attemptedAt: new Date().toISOString(),
            jobName: "stream_repair",
            success: false,
            dbWriteResult: null,
            transactionContext: "stream_repair:stage1_user_sync",
            markerValue: null,
            setCallsite: "lib/ops/scheduled-jobs.ts:stream_repair:stage1",
            error: e instanceof Error ? e.message : String(e),
          });
          await appendExchangeTruthWriteAudit(ctx.runId, {
            attemptedAt: new Date().toISOString(),
            jobName: "stream_repair",
            caller: "recordExchangeOrdersSnapshotSuccess + recordExchangeFillsSnapshotSuccess",
            success: false,
            valuesWritten: {
              ordersSnapshotAt: null,
              fillsSnapshotAt: null,
              exchangeTruthUnavailable: null,
            },
            sourcePath: "lib/ops/scheduled-jobs.ts:stream_repair:stage1",
            transactionContext: "stream_repair:stage1_user_sync",
            error: e instanceof Error ? e.message : String(e),
          });
          await appendRunBreadcrumb(ctx.runId, { stage: "fetch_fail", at: new Date().toISOString(), durationMs: Date.now() - userT0, ok: false, error: e instanceof Error ? e.message : String(e), meta: { subtask: "syncUser" } });
        }

        // Stage 2: reconciliation/alignment (safe to attempt, but bounded).
        const funder = await getFunderForRecompute();
        let stage2Ok = false;
        if (funder) {
          const reconT0 = Date.now();
          await appendRunBreadcrumb(ctx.runId, { stage: "reconciliation_start", at: new Date().toISOString(), meta: { funderAddress: funder, budgetMs: stage2BudgetMs, stage1Ok } });
          try {
            await runWithAbortScope({
              label: "stream_repair:stage2_reconcile",
              parentSignal: ctx.signal,
              timeoutMs: stage2BudgetMs,
              fn: async (signal) => await reconcileOrders(funder, { signal }),
            });
            stage2Ok = true;
            await appendRunBreadcrumb(ctx.runId, { stage: "reconciliation_ok", at: new Date().toISOString(), durationMs: Date.now() - reconT0, ok: true });
          } catch (e) {
            await appendRunBreadcrumb(ctx.runId, { stage: "reconciliation_fail", at: new Date().toISOString(), durationMs: Date.now() - reconT0, ok: false, error: e instanceof Error ? e.message : String(e) });
          }
        }

        // Stage 3: DB follow-up (snapshots / sync state). Only run if we haven't been aborted.
        const dbT0 = Date.now();
        await appendRunBreadcrumb(ctx.runId, { stage: "db_write_start", at: new Date().toISOString(), meta: { budgetMs: stage3BudgetMs, stage1Ok, stage2Ok } });
        await runWithAbortScope({
          label: "stream_repair:stage3_db",
          parentSignal: ctx.signal,
          timeoutMs: stage3BudgetMs,
          fn: async () => {
            await captureMarketSnapshots();
            await updateStreamSyncState({ lastReconciliationAt: new Date() });
          },
        });
        await appendRunBreadcrumb(ctx.runId, { stage: "db_write_ok", at: new Date().toISOString(), durationMs: Date.now() - dbT0, ok: true });

        await appendRunBreadcrumb(ctx.runId, { stage: "repair_ok", at: new Date().toISOString(), durationMs: Date.now() - repairStart, ok: true, meta: { stage1Ok, stage2Ok } });
      } catch (e) {
        await appendRunBreadcrumb(ctx.runId, { stage: "repair_fail", at: new Date().toISOString(), durationMs: Date.now() - repairStart, ok: false, error: e instanceof Error ? e.message : String(e) });
        throw e;
      }
      break;
    }
    case "shadow_evaluation": {
      const { evaluateShadowCandidates } = await import("../shadow-evaluation");
      await evaluateShadowCandidates({
        minAgeMs: shadowEvalMinAgeMsFromEnv(),
        limit: shadowEvalLimitFromEnv(),
      });
      break;
    }
    case "shadow_analysis": {
      const { runShadowAnalysis } = await import("../shadow-analysis");
      await runShadowAnalysis({});
      break;
    }
    case "ml_shadow_dataset_build": {
      const { persistShadowTrainingExamples } = await import("../ml/shadow-dataset");
      const { getActiveOrApprovedShadowModel } = await import("../ml/shadow-score");
      const rawLimit = parseInt(process.env.SHADOW_DATASET_BUILD_JOB_LIMIT ?? "3000", 10);
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 50_000) : 3000;
      const champion = await getActiveOrApprovedShadowModel();
      const coldStart = !champion;
      const allowUnevaluated = process.env.SELF_IMPROVE_BOOTSTRAP_ALLOW_UNEVALUATED !== "false";
      const evaluatedOnly = coldStart && allowUnevaluated ? false : true;
      const sel = (process.env.SHADOW_DATASET_CANDIDATE_SELECTION ?? "").toLowerCase().trim();
      const datasetCandidateSelection =
        sel === "sequential" ? ("sequential" as const) : ("prefer_missing_12h_label" as const);
      await persistShadowTrainingExamples({
        limit,
        evaluatedOnly,
        datasetCandidateSelection,
      });
      break;
    }
    case "ml_shadow_path_feature_backfill": {
      const { runShadowPathFeatureBackfillJob } = await import("./self-improvement-loop");
      await runShadowPathFeatureBackfillJob();
      break;
    }
    case "paper_trading_tick": {
      const { runPaperTradingTick } = await import("../paper-trading/engine");
      const { closePaperTradesAt12h } = await import("../paper-trading/engine");
      // Prefer credentials/wallet funder (same as stream-runtime) so paper candidate load aligns with
      // runtime_automated submissions. Falls back to snapshot heuristic when no wallet funder.
      const { getFunderForPaperTradingTick } = await import("../decision/recompute");
      const funder = await getFunderForPaperTradingTick();
      await runPaperTradingTick(funder ?? undefined);
      // Closing-only safety: run a due-close pass immediately after each tick so eligible opens,
      // including V2 rows, are not dependent on the hourly close job cadence.
      await closePaperTradesAt12h();
      break;
    }
    case "paper_trading_close_due": {
      const { closePaperTradesAt12h } = await import("../paper-trading/engine");
      await closePaperTradesAt12h();
      break;
    }
    case "policy_refresh_pending": {
      const { runPolicyRefreshJobCycle } = await import("../policy-refresh-queue");
      const { staleReconcile, process } = await runPolicyRefreshJobCycle();
      if (staleReconcile.enqueued.length > 0) {
        console.info("[policy_refresh_pending] stale reconcile enqueued", {
          count: staleReconcile.enqueued.length,
          funders: staleReconcile.enqueued.map((e) => e.funderAddress),
        });
      }
      if (process.processed.length > 0) {
        console.info("[policy_refresh_pending] processed", { funders: process.processed });
      }
      break;
    }
    case "ml_shadow_retrain": {
      const {
        runShadowDatasetRefreshJob,
        runShadowPathFeatureBackfillJob,
        runShadowRetrainJob,
      } = await import("./self-improvement-loop");
      /** Explicit order: fresh examples → path slots → train (fail-closed on ACTIVE/APPROVED parse for scoring remains separate). */
      await runShadowDatasetRefreshJob();
      await runShadowPathFeatureBackfillJob();
      await runShadowRetrainJob();
      break;
    }
    case "self_improving_paper_loop": {
      const { runSelfImprovingPaperLoopJob } = await import("./self-improvement-loop");
      await runSelfImprovingPaperLoopJob();
      break;
    }
    case "ml_shadow_bootstrap_activate": {
      const { runShadowBootstrapActivationJob } = await import("./self-improvement-loop");
      await runShadowBootstrapActivationJob();
      break;
    }
    case "ml_shadow_promote": {
      const { runShadowEvaluateAndPromoteJob } = await import("./self-improvement-loop");
      await runShadowEvaluateAndPromoteJob();
      break;
    }
    case "paper_config_optimize": {
      const { runPaperConfigOptimizerJob } = await import("./self-improvement-loop");
      await runPaperConfigOptimizerJob();
      break;
    }
    case "self_improvement_rollback_guard": {
      const { runSelfImprovementRollbackGuardJob } = await import("./self-improvement-loop");
      await runSelfImprovementRollbackGuardJob();
      break;
    }
    case "self_improvement_status_report": {
      const { runSelfImprovementStatusReportJob } = await import("./self-improvement-loop");
      await runSelfImprovementStatusReportJob();
      break;
    }
    default:
      throw new Error(`Unknown job: ${name}`);
  }
}
