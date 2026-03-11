/**
 * Streaming Sync Layer v1: debounced recomputes on stream events and
 * StreamSyncState (lastEventAt, lastReconciliationAt, trackedAssetCount)
 * for health/status. All credentials stay server-side.
 */

import { prisma } from "@/lib/db";

const DEBOUNCE_MS = 4000;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

export interface StreamSyncStateRow {
  lastEventAt: Date | null;
  lastReconciliationAt: Date | null;
  trackedAssetCount: number | null;
  updatedAt: Date;
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
    const now = new Date();
    const existing = await prisma.streamSyncState.findUnique({
      where: { id: "default" },
    });
    const update: {
      lastEventAt?: Date | null;
      lastReconciliationAt?: Date | null;
      trackedAssetCount?: number | null;
      updatedAt: Date;
    } = { updatedAt: now };
    if (data.lastEventAt !== undefined) update.lastEventAt = data.lastEventAt;
    if (data.lastReconciliationAt !== undefined) update.lastReconciliationAt = data.lastReconciliationAt;
    if (data.trackedAssetCount !== undefined) update.trackedAssetCount = data.trackedAssetCount;

    if (existing) {
      await prisma.streamSyncState.update({
        where: { id: "default" },
        data: update,
      });
    } else {
      await prisma.streamSyncState.upsert({
        where: { id: "default" },
        create: {
          id: "default",
          lastEventAt: data.lastEventAt ?? null,
          lastReconciliationAt: data.lastReconciliationAt ?? null,
          trackedAssetCount: data.trackedAssetCount ?? null,
          updatedAt: now,
        },
        update: update,
      });
    }
  } catch (e) {
    console.error("[live/streaming-sync] updateStreamSyncState failed", e);
  }
}

/**
 * Read current StreamSyncState for health API.
 */
export async function getStreamSyncState(): Promise<StreamSyncStateRow | null> {
  try {
    const row = await prisma.streamSyncState.findUnique({
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
  }, DEBOUNCE_MS);
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
