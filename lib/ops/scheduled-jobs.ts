/**
 * Scheduled job definitions and execution. Used by the background worker and by POST /api/ops/run-job.
 * No autonomous trading; sync, recompute, and freshness only.
 */

import { prisma } from "../db";

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
] as const;

export type JobName = (typeof JOB_NAMES)[number];

export function isJobName(name: string): name is JobName {
  return (JOB_NAMES as readonly string[]).includes(name);
}

/** Intervals in ms for each job when running on a schedule. */
export const JOB_INTERVALS_MS: Record<JobName, number> = {
  market_sync: 5 * 60 * 1000,
  user_sync: 2 * 60 * 1000,
  news_sync: 15 * 60 * 1000,
  market_snapshot_capture: 10 * 60 * 1000,
  recommendation_recompute: 15 * 60 * 1000,
  decision_recompute: 15 * 60 * 1000,
  order_reconciliation: 2 * 60 * 1000,
  recommendation_evaluation: 60 * 60 * 1000,
  position_decision_recompute: 10 * 60 * 1000,
  stream_repair: 5 * 60 * 1000,
};

export interface RunJobResult {
  runId: string;
  status: "success" | "failure";
  durationMs: number;
  error?: string;
}

/**
 * Create a ScheduledJobRun, execute the job, update with status/duration. Safe for worker or API.
 */
export async function runScheduledJob(name: JobName): Promise<RunJobResult> {
  const startedAt = new Date();
  const run = await prisma.scheduledJobRun.create({
    data: {
      jobName: name,
      status: "running",
      startedAt,
    },
  });

  try {
    await executeJob(name);
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
    return { runId: run.id, status: "success", durationMs };
  } catch (err) {
    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - startedAt.getTime();
    const errorMessage = err instanceof Error ? err.message : String(err);
    await prisma.scheduledJobRun.update({
      where: { id: run.id },
      data: {
        status: "failure",
        finishedAt,
        durationMs,
        errorMessage,
      },
    });
    return { runId: run.id, status: "failure", durationMs, error: errorMessage };
  }
}

async function executeJob(name: JobName): Promise<void> {
  const { getFunderForRecompute } = await import("../polymarket/recompute");

  switch (name) {
    case "market_sync": {
      const { syncMarkets } = await import("../polymarket/markets");
      await syncMarkets({ limit: 100, maxPages: 5 });
      break;
    }
    case "user_sync": {
      const { syncUser } = await import("../polymarket/user-sync");
      await syncUser();
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
      if (funder) await reconcileOrders(funder);
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
      await syncUser();
      const funder = await getFunderForRecompute();
      if (funder) await reconcileOrders(funder);
      await captureMarketSnapshots();
      await updateStreamSyncState({ lastReconciliationAt: new Date() });
      break;
    }
    default:
      throw new Error(`Unknown job: ${name}`);
  }
}
