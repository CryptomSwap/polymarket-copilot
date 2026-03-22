/**
 * Single entry point for execution-quality evaluation used when persisting runtime ShadowCandidate rows.
 * Always runs evaluateExecutionQuality (never skips); when market state is missing, inputs are explicit nulls
 * so snapshotJson is still valid JSON for observability. Policy/guardrail behavior elsewhere must still gate
 * on whether live state was present (see stream-runtime).
 */

import { evaluateExecutionQuality } from "./evaluate";
import type { ExecutionQualityInput, ExecutionQualityResult } from "./types";

/** Subset of asset live state needed for EQ input (matches stream-runtime casts). */
export type RuntimeIntentAssetLiveState =
  | {
      health?: { isStale?: boolean; isDegraded?: boolean };
      liquidity?: { qualityScore?: number; isTradable?: boolean };
      quote?: {
        bestBid?: number | null;
        bestAsk?: number | null;
        spreadBps?: number | null;
        updatedAt?: Date | null;
      };
      depth?: { bidTopSize?: number | null; askTopSize?: number | null };
    }
  | null
  | undefined;

function buildExecutionQualityInputForRuntimeIntent(params: {
  assetId: string;
  marketId: string;
  side: "BUY" | "SELL";
  intendedPrice: number;
  intendedSize: number;
  assetLiveState: RuntimeIntentAssetLiveState;
}): ExecutionQualityInput {
  const ls = params.assetLiveState;
  return {
    assetId: params.assetId,
    marketId: params.marketId,
    side: params.side,
    intendedPrice: params.intendedPrice,
    intendedSize: params.intendedSize,
    bestBid: ls?.quote?.bestBid ?? null,
    bestAsk: ls?.quote?.bestAsk ?? null,
    bidDepth: ls?.depth?.bidTopSize ?? null,
    askDepth: ls?.depth?.askTopSize ?? null,
    spreadBps: ls?.quote?.spreadBps ?? undefined,
    quoteAgeMs:
      ls?.quote?.updatedAt != null
        ? Date.now() - new Date(ls.quote.updatedAt).getTime()
        : undefined,
    liquidityScore: ls?.liquidity?.qualityScore ?? undefined,
    isTradable: ls?.liquidity?.isTradable ?? undefined,
  };
}

/**
 * Evaluate EQ for persistence on runtime_automated ShadowCandidate rows.
 * Call exactly once per row; use `.snapshotJson` for DB and `.qualityState` / blocking fields only when
 * `assetLiveState` was present (policy input in stream-runtime).
 */
export function evaluateExecutionQualityForRuntimeIntentRecord(params: {
  assetId: string;
  marketId: string;
  side: "BUY" | "SELL";
  intendedPrice: number;
  intendedSize: number;
  assetLiveState: RuntimeIntentAssetLiveState;
}): ExecutionQualityResult {
  return evaluateExecutionQuality(buildExecutionQualityInputForRuntimeIntent(params));
}
