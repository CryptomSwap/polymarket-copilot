/**
 * When BehaviorFlags change, MarketSignal.behaviorPenalty and DecisionPolicySnapshot can go stale.
 * Mark funders dirty here; the scheduled job `policy_refresh_pending` debounces and runs
 * recomputeRecommendations → recomputeDecisions.
 *
 * Self-heal: reconcileStalePolicyFunders() detects penalty mismatch or stale behavior-block copy
 * and auto-enqueues (same queue; no duplicate marks if already dirty / in-flight / cooldown).
 */

import { prisma } from "@/lib/db";
import { recomputeRecommendations } from "@/lib/polymarket/recommendations-recompute";
import { recomputeDecisions } from "@/lib/decision/recompute";
import { getAutomationBehaviorPenaltyForFunder } from "@/lib/polymarket/signals";

const DEFAULT_DEBOUNCE_MS = 45_000;
const DEFAULT_MAX_FUNDERS = 4;
/** Skip starting a new refresh if prior attempt still "open" and younger than this. */
const IN_FLIGHT_MAX_MS = 3 * 60_000;

const BEHAVIOR_BLOCKED = "Behavior flags suggest pausing new trades.";
const PENALTY_EPS = 0.001;
const LIVE_BLOCK_THRESHOLD = 0.25;
/** After reconcile enqueue + successful refresh, wait before re-auto-enqueue if still stale (rare). */
const POST_SUCCESS_STALE_COOLDOWN_MS = 12 * 60_000;
/** Cooldown applies only if lastStaleEnqueueAt is this recent (ignore ancient audit timestamps). */
const STALE_ENQUEUE_RECENCY_MS = 2 * 60 * 60 * 1000;
const MAX_FUNDERS_STALE_SCAN = 40;
const MAX_STALE_ENQUEUE_PER_TICK = 8;

export type StalePolicyReason = "behavior_penalty_mismatch" | "stale_behavior_block_copy";

export async function markFunderPolicyRefreshNeeded(
  funderAddress: string,
  meta?: { enqueueReason?: string }
): Promise<void> {
  const f = funderAddress.trim().toLowerCase();
  if (!f) return;
  const reason = meta?.enqueueReason;
  await prisma.funderPolicyRefreshState.upsert({
    where: { funderAddress: f },
    create: {
      funderAddress: f,
      dirtyAt: new Date(),
      ...(reason
        ? { lastStaleEnqueueReason: reason, lastStaleEnqueueAt: new Date() }
        : {}),
    },
    update: {
      dirtyAt: new Date(),
      ...(reason
        ? { lastStaleEnqueueReason: reason, lastStaleEnqueueAt: new Date() }
        : {}),
    },
  });
}

export interface FunderStaleAnalysis {
  funderAddress: string;
  stale: boolean;
  reasons: StalePolicyReason[];
  livePenalty: number;
  persistedPenalty: number | null;
  behaviorBlockedRecCount: number;
}

export async function analyzeFunderPolicyStaleState(funderAddress: string): Promise<FunderStaleAnalysis> {
  const f = funderAddress.trim().toLowerCase();
  const livePenalty = await getAutomationBehaviorPenaltyForFunder(f);
  const sig = await prisma.marketSignal.findFirst({
    where: { funderAddress: f },
    select: { behaviorPenalty: true },
    orderBy: { updatedAt: "desc" },
  });
  let persistedPenalty: number | null = null;
  if (sig?.behaviorPenalty != null && sig.behaviorPenalty !== "") {
    const p = parseFloat(sig.behaviorPenalty);
    persistedPenalty = Number.isFinite(p) ? p : null;
  }
  const behaviorBlockedRecCount = await prisma.recommendation.count({
    where: {
      marketSignal: { funderAddress: f },
      blockedReason: BEHAVIOR_BLOCKED,
    },
  });

  const reasons: StalePolicyReason[] = [];
  if (
    persistedPenalty != null &&
    Math.abs(persistedPenalty - livePenalty) > PENALTY_EPS
  ) {
    reasons.push("behavior_penalty_mismatch");
  }
  if (behaviorBlockedRecCount > 0 && livePenalty < LIVE_BLOCK_THRESHOLD) {
    reasons.push("stale_behavior_block_copy");
  }

  return {
    funderAddress: f,
    stale: reasons.length > 0,
    reasons,
    livePenalty,
    persistedPenalty,
    behaviorBlockedRecCount,
  };
}

/**
 * Funders to scan: those with behavior-blocked recs (likely stale after scope fix) plus any distinct signal funders (mismatch).
 */
export async function discoverFundersForStalePolicyScan(): Promise<string[]> {
  const fromBlocked = await prisma.recommendation.findMany({
    where: { blockedReason: BEHAVIOR_BLOCKED },
    select: { marketSignal: { select: { funderAddress: true } } },
    take: 600,
  });
  const s = new Set<string>();
  for (const r of fromBlocked) {
    s.add(r.marketSignal.funderAddress.trim().toLowerCase());
  }

  const distinctSignals = await prisma.marketSignal.findMany({
    select: { funderAddress: true },
    distinct: ["funderAddress"],
    take: 35,
  });
  for (const row of distinctSignals) {
    s.add(row.funderAddress.trim().toLowerCase());
  }

  return Array.from(s).slice(0, MAX_FUNDERS_STALE_SCAN);
}

export interface StaleReconcileResult {
  scannedFunders: number;
  staleDetected: { funderAddress: string; reasons: StalePolicyReason[] }[];
  enqueued: { funderAddress: string; reason: string }[];
  skippedAlreadyDirty: string[];
  skippedInFlight: string[];
  skippedPostSuccessCooldown: string[];
}

/**
 * Auto-enqueue funders whose persisted policy inputs disagree with live automation behavior penalty.
 */
export async function reconcileStalePolicyFunders(): Promise<StaleReconcileResult> {
  const now = Date.now();
  const funders = await discoverFundersForStalePolicyScan();
  const staleDetected: StaleReconcileResult["staleDetected"] = [];
  const enqueued: StaleReconcileResult["enqueued"] = [];
  const skippedAlreadyDirty: string[] = [];
  const skippedInFlight: string[] = [];
  const skippedPostSuccessCooldown: string[] = [];

  let enqueueBudget = MAX_STALE_ENQUEUE_PER_TICK;

  for (const f of funders) {
    if (enqueueBudget <= 0) break;

    const analysis = await analyzeFunderPolicyStaleState(f);
    if (!analysis.stale) continue;

    staleDetected.push({
      funderAddress: f,
      reasons: analysis.reasons,
    });

    const row = await prisma.funderPolicyRefreshState.findUnique({
      where: { funderAddress: f },
    });

    if (row?.dirtyAt) {
      skippedAlreadyDirty.push(f);
      continue;
    }

    if (
      row?.lastRefreshStartedAt &&
      (!row.lastRefreshSuccessAt || row.lastRefreshSuccessAt < row.lastRefreshStartedAt) &&
      now - row.lastRefreshStartedAt.getTime() < IN_FLIGHT_MAX_MS
    ) {
      skippedInFlight.push(f);
      continue;
    }

    if (
      row?.lastStaleEnqueueAt &&
      now - row.lastStaleEnqueueAt.getTime() < STALE_ENQUEUE_RECENCY_MS &&
      row.lastRefreshSuccessAt &&
      row.lastRefreshSuccessAt > row.lastStaleEnqueueAt &&
      !row.dirtyAt &&
      now - row.lastRefreshSuccessAt.getTime() < POST_SUCCESS_STALE_COOLDOWN_MS
    ) {
      skippedPostSuccessCooldown.push(f);
      continue;
    }

    const reasonStr = analysis.reasons.join("+");
    await markFunderPolicyRefreshNeeded(f, { enqueueReason: reasonStr });
    enqueued.push({ funderAddress: f, reason: reasonStr });
    enqueueBudget--;
    console.info(`[policy-refresh] stale-reconcile enqueue funder=${f}`, { reason: reasonStr });
  }

  return {
    scannedFunders: funders.length,
    staleDetected,
    enqueued,
    skippedAlreadyDirty,
    skippedInFlight,
    skippedPostSuccessCooldown,
  };
}

export interface PolicyRefreshProcessResult {
  processed: string[];
  skippedDebounced: string[];
  skippedInFlight: string[];
  errors: { funderAddress: string; message: string }[];
}

export interface PolicyRefreshJobResult {
  staleReconcile: StaleReconcileResult;
  process: PolicyRefreshProcessResult;
}

export async function runPolicyRefreshJobCycle(options?: {
  debounceMs?: number;
  maxFunders?: number;
}): Promise<PolicyRefreshJobResult> {
  const staleReconcile = await reconcileStalePolicyFunders();
  const process = await processPendingPolicyRefreshes(options);
  return { staleReconcile, process };
}

/**
 * Process queued funders: debounced, coalesced, idempotent refresh.
 */
export async function processPendingPolicyRefreshes(options?: {
  debounceMs?: number;
  maxFunders?: number;
}): Promise<PolicyRefreshProcessResult> {
  const debounceMs = options?.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const maxFunders = options?.maxFunders ?? DEFAULT_MAX_FUNDERS;
  const now = Date.now();

  const rows = await prisma.funderPolicyRefreshState.findMany({
    where: { dirtyAt: { not: null } },
    orderBy: { dirtyAt: "asc" },
  });

  const processed: string[] = [];
  const skippedDebounced: string[] = [];
  const skippedInFlight: string[] = [];
  const errors: { funderAddress: string; message: string }[] = [];

  let done = 0;
  for (const row of rows) {
    if (done >= maxFunders) break;
    const dirtyAt = row.dirtyAt;
    if (!dirtyAt) continue;

    if (now - dirtyAt.getTime() < debounceMs) {
      skippedDebounced.push(row.funderAddress);
      continue;
    }

    if (
      row.lastRefreshStartedAt &&
      (!row.lastRefreshSuccessAt || row.lastRefreshSuccessAt < row.lastRefreshStartedAt) &&
      now - row.lastRefreshStartedAt.getTime() < IN_FLIGHT_MAX_MS
    ) {
      skippedInFlight.push(row.funderAddress);
      continue;
    }

    const dirtySnapshotMs = dirtyAt.getTime();

    await prisma.funderPolicyRefreshState.update({
      where: { funderAddress: row.funderAddress },
      data: { lastRefreshStartedAt: new Date() },
    });

    console.info(`[policy-refresh] start funder=${row.funderAddress}`);

    try {
      const rec = await recomputeRecommendations(row.funderAddress, { captureSnapshotsFirst: false });
      if (rec.errors.length > 0) {
        console.warn(`[policy-refresh] recomputeRecommendations notes`, {
          funder: row.funderAddress,
          errors: rec.errors.slice(0, 5),
        });
      }
      await recomputeDecisions(row.funderAddress);

      const latest = await prisma.funderPolicyRefreshState.findUnique({
        where: { funderAddress: row.funderAddress },
      });
      const bumpedDuringRun =
        latest?.dirtyAt != null && latest.dirtyAt.getTime() !== dirtySnapshotMs;

      await prisma.funderPolicyRefreshState.update({
        where: { funderAddress: row.funderAddress },
        data: {
          dirtyAt: bumpedDuringRun ? latest!.dirtyAt : null,
          lastRefreshSuccessAt: new Date(),
          lastRefreshError: null,
        },
      });

      processed.push(row.funderAddress);
      done++;
      console.info(`[policy-refresh] success funder=${row.funderAddress}`, {
        bumpedDuringRun,
        signals: rec.signalsWritten,
        recommendations: rec.recommendationsWritten,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      errors.push({ funderAddress: row.funderAddress, message });
      await prisma.funderPolicyRefreshState.update({
        where: { funderAddress: row.funderAddress },
        data: { lastRefreshError: message.slice(0, 8000) },
      });
      console.error(`[policy-refresh] failure funder=${row.funderAddress}`, message);
    }
  }

  return { processed, skippedDebounced, skippedInFlight, errors };
}
