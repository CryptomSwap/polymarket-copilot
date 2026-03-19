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

/**
 * Persist one shadow telemetry row. Call at decision/submission time for every candidate.
 */
export async function recordShadowCandidate(
  input: RecordShadowCandidateInput
): Promise<RecordShadowCandidateResult> {
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
        candidateSource: input.candidateSource ?? "runtime_automated",
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
    return { id: row.id, ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (typeof (globalThis as unknown as { console?: { error?: (a: string, b?: unknown) => void } }).console?.error === "function") {
      (globalThis as unknown as { console: { error: (a: string, b?: unknown) => void } }).console.error("[shadow-telemetry] recordShadowCandidate failed", err);
    }
    return { id: null, ok: false, error: message };
  }
}
