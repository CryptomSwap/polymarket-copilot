/**
 * Periodic worker heartbeat persistence. Updates WorkerHeartbeat so the app can show worker health.
 *
 * Each tick writes one upsert with a single metadataJson blob (atomic at DB row level): no partial
 * merge of runtimeSafety vs runtimeHealth across writes — snapshots are consistent for that instant.
 */

import { prisma } from "../lib/db";
import { getLogLevelFromEnv, shouldEmitLog, type LogLevel } from "../lib/logging/log-level";

const DEFAULT_INTERVAL_MS = 30_000;

let intervalId: ReturnType<typeof setInterval> | null = null;
let currentTick: (() => void) | null = null;

export interface HeartbeatOptions {
  workerName: string;
  intervalMs?: number;
  /** Static metadata. */
  metadata?: Record<string, unknown>;
  /** Optional: called each tick to merge with metadata (e.g. runtime health). */
  getMetadata?: () => Record<string, unknown>;
}

/**
 * Run one heartbeat write immediately. Use after runtime start completes so health API sees
 * post-startup state without waiting for the next interval. No-op if heartbeat not started.
 */
export function triggerTick(): void {
  if (currentTick) currentTick();
}

/**
 * Start periodic heartbeat. Upserts WorkerHeartbeat with status "running" and lastSeenAt = now.
 * First tick runs immediately; that write may not include runtimeHealth if stream runtime hasn't started yet.
 */
export function startHeartbeat(opts: HeartbeatOptions): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  currentTick = null;
  const { workerName, intervalMs = DEFAULT_INTERVAL_MS, metadata = {}, getMetadata } = opts;
  // Read LOG_LEVEL at startHeartbeat time so dotenv (loaded by worker/index.ts) has already populated env vars.
  const LOG_LEVEL: LogLevel = getLogLevelFromEnv("info");

  function tick(): void {
    const now = new Date();
    const merged = getMetadata ? { ...metadata, ...getMetadata() } : metadata;
    const runtimeHealth = merged.runtimeHealth as Record<string, unknown> | null | undefined;
    if (runtimeHealth != null) {
      const streams = (runtimeHealth.streams ?? {}) as Record<string, unknown>;
      const market = streams.marketConnection as Record<string, unknown> | null | undefined;
      const user = streams.userConnection as Record<string, unknown> | null | undefined;
      if (shouldEmitLog("info", LOG_LEVEL)) {
        console.info("[worker/heartbeat] heartbeat write", {
          timestamp: now.toISOString(),
          runtimeHealth_status: runtimeHealth.status,
          runtimeHealth_startedAt: runtimeHealth.startedAt != null ? String(runtimeHealth.startedAt) : null,
          runtimeHealth_degradedReasons: runtimeHealth.degradedReasons,
          marketConnection_status: market?.status ?? null,
          userConnection_status: user?.status ?? null,
        });
      }
    } else {
      if (shouldEmitLog("info", LOG_LEVEL)) {
        console.info("[worker/heartbeat] heartbeat write (no runtimeHealth yet)", { timestamp: now.toISOString() });
      }
    }
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
        if (shouldEmitLog("error", LOG_LEVEL)) console.error("[worker/heartbeat] upsert failed", err);
      });
  }

  currentTick = tick;
  tick();
  intervalId = setInterval(tick, intervalMs);
}

/**
 * Stop heartbeat and set status to idle.
 */
export async function stopHeartbeat(workerName: string): Promise<void> {
  const LOG_LEVEL: LogLevel = getLogLevelFromEnv("info");
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  currentTick = null;
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
    if (shouldEmitLog("error", LOG_LEVEL)) console.error("[worker/heartbeat] stop failed", err);
  }
}
