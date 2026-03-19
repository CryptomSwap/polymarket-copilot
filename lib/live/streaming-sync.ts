/**
 * Streaming Sync Layer v1: debounced recomputes on stream events and
 * StreamSyncState (lastEventAt, lastReconciliationAt, trackedAssetCount)
 * for health/status. All credentials stay server-side.
 *
 * lastEventAt persistence is debounced; trackedAssetCount skips redundant writes;
 * upserts avoid read-before-write to cut pool usage.
 */

import { prisma } from "@/lib/db";

const RECOMPUTE_DEBOUNCE_MS = 4000;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

/** Debounce high-frequency lastEventAt ticks (many stream messages per second). */
const LAST_EVENT_PERSIST_MS = Number(process.env.STREAM_SYNC_LAST_EVENT_DEBOUNCE_MS ?? "3000") || 3000;
let lastEventFlushTimer: ReturnType<typeof setTimeout> | null = null;
let pendingLastEventAt: Date | null = null;

let lastFlushedTrackedCount: number | null = null;

export interface StreamSyncStateRow {
  lastEventAt: Date | null;
  lastReconciliationAt: Date | null;
  trackedAssetCount: number | null;
  updatedAt: Date;
}

async function persistStreamSyncState(data: {
  lastEventAt?: Date | null;
  lastReconciliationAt?: Date | null;
  trackedAssetCount?: number | null;
}): Promise<void> {
  const now = new Date();
  await prisma.stream_sync_state.upsert({
    where: { id: "default" },
    create: {
      id: "default",
      lastEventAt: data.lastEventAt ?? null,
      lastReconciliationAt: data.lastReconciliationAt ?? null,
      trackedAssetCount: data.trackedAssetCount ?? null,
      updatedAt: now,
    },
    update: {
      ...(data.lastEventAt !== undefined && { lastEventAt: data.lastEventAt }),
      ...(data.lastReconciliationAt !== undefined && { lastReconciliationAt: data.lastReconciliationAt }),
      ...(data.trackedAssetCount !== undefined && { trackedAssetCount: data.trackedAssetCount }),
      updatedAt: now,
    },
  });
}

/**
 * Upsert the single StreamSyncState row. Used by event handlers and stream_repair job.
 */
export async function updateStreamSyncState(data: {
  lastEventAt?: Date | null;
  lastReconciliationAt?: Date | null;
  trackedAssetCount?: number | null;
}): Promise<void> {
  try {
    const tracked = data.trackedAssetCount;
    const trackedChanged =
      tracked !== undefined && tracked !== lastFlushedTrackedCount;
    const needImmediate =
      data.lastReconciliationAt !== undefined ||
      trackedChanged ||
      (data.lastEventAt !== undefined && (data.lastReconciliationAt !== undefined || tracked !== undefined));

    if (needImmediate) {
      if (tracked !== undefined) lastFlushedTrackedCount = tracked;
      const patch: {
        lastEventAt?: Date | null;
        lastReconciliationAt?: Date | null;
        trackedAssetCount?: number | null;
      } = {};
      if (data.lastEventAt !== undefined) patch.lastEventAt = data.lastEventAt;
      if (data.lastReconciliationAt !== undefined) patch.lastReconciliationAt = data.lastReconciliationAt;
      if (tracked !== undefined) patch.trackedAssetCount = tracked;
      if (Object.keys(patch).length > 0) {
        await persistStreamSyncState(patch);
      }
      if (lastEventFlushTimer && data.lastEventAt !== undefined) {
        clearTimeout(lastEventFlushTimer);
        lastEventFlushTimer = null;
        pendingLastEventAt = null;
      }
      return;
    }

    if (data.lastEventAt !== undefined) {
      pendingLastEventAt = data.lastEventAt;
      if (!lastEventFlushTimer) {
        lastEventFlushTimer = setTimeout(() => {
          lastEventFlushTimer = null;
          const at = pendingLastEventAt;
          pendingLastEventAt = null;
          if (at != null) {
            void persistStreamSyncState({ lastEventAt: at }).catch((e) => {
              console.error("[live/streaming-sync] debounced lastEventAt persist failed", e);
            });
          }
        }, LAST_EVENT_PERSIST_MS);
      }
    }
  } catch (e) {
    console.error("[live/streaming-sync] updateStreamSyncState failed", e);
  }
}

/**
 * When startup gets no tracked assets but stream_sync_state has a non-zero count, retry with no funder filter.
 * Used so market WS and desiredTrackedAssetIds are populated when DB says we have assets (e.g. from a previous run).
 */
export function shouldRetryTrackedAssetsWithNoFunder(
  assetIds: string[],
  syncStateTrackedCount: number | null | undefined
): boolean {
  return assetIds.length === 0 && (syncStateTrackedCount ?? 0) > 0;
}

/**
 * Read current StreamSyncState for health API.
 */
export async function getStreamSyncState(): Promise<StreamSyncStateRow | null> {
  try {
    const row = await prisma.stream_sync_state.findUnique({
      where: { id: "default" },
    });
    if (!row) return null;
    return {
      lastEventAt: row.lastEventAt,
      lastReconciliationAt: row.lastReconciliationAt,
      trackedAssetCount: row.trackedAssetCount,
      updatedAt: row.updatedAt,
    };
  } catch {
    return null;
  }
}

/**
 * Called when a stream event is persisted. Updates lastEventAt and schedules
 * a debounced recompute (portfolio, positions, recommendations, decisions, alerts).
 */
export function onStreamEvent(): void {
  updateStreamSyncState({ lastEventAt: new Date() }).catch(() => {});

  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    runDebouncedRecomputes().catch((err) => {
      console.error("[live/streaming-sync] debounced recomputes failed", err);
    });
  }, RECOMPUTE_DEBOUNCE_MS);
}

async function runDebouncedRecomputes(): Promise<void> {
  const { getFunderForRecompute } = await import("@/lib/polymarket/recompute");
  const funder = await getFunderForRecompute();
  if (!funder) return;

  const { recomputePortfolio } = await import("@/lib/polymarket/recompute");
  const { recomputeRecommendations } = await import("@/lib/polymarket/recommendations-recompute");
  const { recomputeDecisions } = await import("@/lib/decision/recompute");
  const { recomputePositionDecisions } = await import("@/lib/position/recompute");

  try {
    await recomputePortfolio(funder);
  } catch (e) {
    console.warn("[streaming-sync] recomputePortfolio failed", e);
  }
  try {
    await recomputeRecommendations();
  } catch (e) {
    console.warn("[streaming-sync] recomputeRecommendations failed", e);
  }
  try {
    await recomputeDecisions(funder);
  } catch (e) {
    console.warn("[streaming-sync] recomputeDecisions failed", e);
  }
  try {
    await recomputePositionDecisions(funder);
  } catch (e) {
    console.warn("[streaming-sync] recomputePositionDecisions failed", e);
  }
}
