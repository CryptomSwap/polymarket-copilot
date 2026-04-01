/**
 * Record a shadow candidate (blocked or allowed) for post-trade evaluation.
 * Durable; safe to call from runtime path. Does not throw on DB errors (logs and returns).
 */

import { prisma } from "@/lib/db";
import type { RecordShadowCandidateInput } from "./types";

export interface RecordShadowCandidateResult {
  id: string | null;
  ok: boolean;
  error?: string;
}

/** Explicit opt-out: set SHADOW_CANDIDATE_RUNTIME_AUTOMATED_WRITE_DISABLE=1 to skip DB creates for candidateSource=runtime_automated. */
export function isRuntimeAutomatedShadowWriteDisabled(): boolean {
  return process.env.SHADOW_CANDIDATE_RUNTIME_AUTOMATED_WRITE_DISABLE === "1";
}

const SKIP_LOG_INTERVAL_MS = 30_000;
let lastSkipLogAtMs = 0;
let skippedSinceLastLog = 0;

const WRITE_LOG_INTERVAL_MS = 30_000;
let lastWriteLogAtMs = 0;
let loaderVisibleWritesSinceLastLog = 0;

/** Counters for the current paper_trading_tick window (reset at tick start, logged at tick end). */
let windowRuntimeAutomatedSkipped = 0;
let windowRuntimeAutomatedPersisted = 0;
let windowLoaderVisiblePersisted = 0;
let lastRuntimeAutomatedCreatedAtIso: string | null = null;
let lastLoaderVisibleCreatedAtIso: string | null = null;

export function resetRuntimeAutomatedShadowWriteWindowCounters(): void {
  windowRuntimeAutomatedSkipped = 0;
  windowRuntimeAutomatedPersisted = 0;
  windowLoaderVisiblePersisted = 0;
  lastRuntimeAutomatedCreatedAtIso = null;
  lastLoaderVisibleCreatedAtIso = null;
}

export function getRuntimeAutomatedShadowWriteWindowSnapshot(): {
  skipped: number;
  persistedRuntimeAutomated: number;
  persistedLoaderVisible: number;
  lastRuntimeAutomatedCreatedAt: string | null;
  lastLoaderVisibleCreatedAt: string | null;
  writeDisabled: boolean;
} {
  return {
    skipped: windowRuntimeAutomatedSkipped,
    persistedRuntimeAutomated: windowRuntimeAutomatedPersisted,
    persistedLoaderVisible: windowLoaderVisiblePersisted,
    lastRuntimeAutomatedCreatedAt: lastRuntimeAutomatedCreatedAtIso,
    lastLoaderVisibleCreatedAt: lastLoaderVisibleCreatedAtIso,
    writeDisabled: isRuntimeAutomatedShadowWriteDisabled(),
  };
}

export function logRuntimeAutomatedShadowWriteWindowAfterPaperTick(): void {
  const s = getRuntimeAutomatedShadowWriteWindowSnapshot();
  if (s.writeDisabled) {
    if (s.skipped > 0) {
      console.warn("[shadow-telemetry] paper_trading_tick window: runtime_automated writes disabled (SHADOW_CANDIDATE_RUNTIME_AUTOMATED_WRITE_DISABLE=1)", s);
    }
    return;
  }
  if (s.skipped === 0 && s.persistedRuntimeAutomated === 0) {
    return;
  }
  console.info("[shadow-telemetry] paper_trading_tick window: runtime_automated ShadowCandidate activity", s);
}

export function warnIfRuntimeAutomatedShadowWritesDisabledAtWorkerBoot(): void {
  if (!isRuntimeAutomatedShadowWriteDisabled()) return;
  console.warn(
    "[worker] SHADOW_CANDIDATE_RUNTIME_AUTOMATED_WRITE_DISABLE=1 — runtime_automated ShadowCandidate rows are not persisted. " +
      "The V2 paper loader will not see fresh fuel. Remove this env, set it to 0, or unset it to re-enable writes."
  );
}

/**
 * Persist one shadow telemetry row. Call at decision/submission time for every candidate.
 */
export async function recordShadowCandidate(
  input: RecordShadowCandidateInput
): Promise<RecordShadowCandidateResult> {
  const source = input.candidateSource ?? "runtime_automated";
  if (isRuntimeAutomatedShadowWriteDisabled() && source === "runtime_automated") {
    windowRuntimeAutomatedSkipped += 1;
    skippedSinceLastLog += 1;
    const nowMs = Date.now();
    if (nowMs - lastSkipLogAtMs >= SKIP_LOG_INTERVAL_MS) {
      lastSkipLogAtMs = nowMs;
      console.warn("[shadow-telemetry] runtime_automated ShadowCandidate write skipped (disabled by env)", {
        skippedSinceLastLog,
        windowSkipped: windowRuntimeAutomatedSkipped,
      });
      skippedSinceLastLog = 0;
    }
    return { id: null, ok: true, error: "skipped:runtime_automated_shadow_write_disabled" };
  }

  try {
    const blockingReasons =
      input.blockingReasons && input.blockingReasons.length > 0 ? input.blockingReasons : null;
    const row = await prisma.shadowCandidate.create({
      data: {
        funderAddress: input.funderAddress.toLowerCase().trim(),
        recommendationId: input.recommendationId ?? null,
        orderIntentId: input.orderIntentId ?? null,
        assetId: input.assetId,
        marketId: input.marketId ?? null,
        side: input.side,
        intendedPrice: String(input.intendedPrice),
        intendedSize: String(input.intendedSize),
        candidateSource: source,
        decisionSnapshotJson: input.decisionSnapshotJson ?? null,
        executionPolicySnapshotJson: input.executionPolicySnapshotJson ?? null,
        executionQualitySnapshotJson: input.executionQualitySnapshotJson ?? null,
        portfolioRiskSnapshotJson: input.portfolioRiskSnapshotJson ?? null,
        runtimeSafetySnapshotJson: input.runtimeSafetySnapshotJson ?? null,
        wasBlocked: input.wasBlocked,
        blockingReasons: blockingReasons as object,
        wasSubmitted: input.wasSubmitted ?? false,
        wasFilled: input.wasFilled ?? null,
      },
    });

    if (source === "runtime_automated") {
      const createdIso = row.createdAt.toISOString();
      lastRuntimeAutomatedCreatedAtIso = createdIso;
      windowRuntimeAutomatedPersisted += 1;
      const loaderVisible = input.wasSubmitted === true && input.wasBlocked === false;
      if (loaderVisible) {
        lastLoaderVisibleCreatedAtIso = createdIso;
        windowLoaderVisiblePersisted += 1;
        loaderVisibleWritesSinceLastLog += 1;
        const wn = Date.now();
        if (wn - lastWriteLogAtMs >= WRITE_LOG_INTERVAL_MS) {
          lastWriteLogAtMs = wn;
          console.info("[shadow-telemetry] runtime_automated loader-visible ShadowCandidate persisted", {
            batchCount: loaderVisibleWritesSinceLastLog,
            lastAt: lastLoaderVisibleCreatedAtIso,
            lastId: row.id,
            funderPrefix: row.funderAddress.slice(0, 12),
          });
          loaderVisibleWritesSinceLastLog = 0;
        }
      }
    }

    return { id: row.id, ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (typeof (globalThis as unknown as { console?: { error?: (a: string, b?: unknown) => void } }).console?.error === "function") {
      (globalThis as unknown as { console: { error: (a: string, b?: unknown) => void } }).console.error(
        "[shadow-telemetry] recordShadowCandidate failed",
        err
      );
    }
    return { id: null, ok: false, error: message };
  }
}
