/**
 * Periodic worker heartbeat persistence. Updates WorkerHeartbeat so the app can show worker health.
 */

import { prisma } from "../lib/db";

const DEFAULT_INTERVAL_MS = 30_000;

let intervalId: ReturnType<typeof setInterval> | null = null;

export interface HeartbeatOptions {
  workerName: string;
  intervalMs?: number;
  /** Static metadata. */
  metadata?: Record<string, unknown>;
  /** Optional: called each tick to merge with metadata (e.g. runtime health). */
  getMetadata?: () => Record<string, unknown>;
}

/**
 * Start periodic heartbeat. Upserts WorkerHeartbeat with status "running" and lastSeenAt = now.
 */
export function startHeartbeat(opts: HeartbeatOptions): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  const { workerName, intervalMs = DEFAULT_INTERVAL_MS, metadata = {}, getMetadata } = opts;

  function tick(): void {
    const now = new Date();
    const merged = getMetadata ? { ...metadata, ...getMetadata() } : metadata;
    const metadataJson = Object.keys(merged).length > 0 ? JSON.stringify(merged) : undefined;
    prisma.workerHeartbeat
      .upsert({
        where: { workerName },
        create: {
          workerName,
          status: "running",
          lastSeenAt: now,
          metadataJson,
        },
        update: {
          status: "running",
          lastSeenAt: now,
          metadataJson,
        },
      })
      .catch((err) => {
        console.error("[worker/heartbeat] upsert failed", err);
      });
  }

  tick();
  intervalId = setInterval(tick, intervalMs);
}

/**
 * Stop heartbeat and set status to idle.
 */
export async function stopHeartbeat(workerName: string): Promise<void> {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  try {
    await prisma.workerHeartbeat.upsert({
      where: { workerName },
      create: {
        workerName,
        status: "idle",
        lastSeenAt: new Date(),
      },
      update: {
        status: "idle",
        lastSeenAt: new Date(),
      },
    });
  } catch (err) {
    console.error("[worker/heartbeat] stop failed", err);
  }
}
