/**
 * Safe read-only debug surface for Bot Runtime.
 * Used by Market Detail Live API to expose last decision/signal per asset.
 * No credentials, no write, no order hooks.
 */

import type { BotRuntime } from "./bot-runtime";
import type { MarketDetailLiveBotSummary } from "../market-state/market-detail-live";

let botRuntimeRef: BotRuntime | null = null;

/**
 * Register the bot runtime for debug/summary (e.g. from StreamRuntime when it starts).
 * Call with null when the runtime shuts down.
 */
export function setBotRuntimeForDebug(runtime: BotRuntime | null): void {
  botRuntimeRef = runtime;
}

/**
 * Get the registered bot runtime, if any. Used by Market Detail Live API.
 */
export function getBotRuntimeForDebug(): BotRuntime | null {
  return botRuntimeRef;
}

function toIso(d: Date | null | undefined): string | null {
  if (d == null) return null;
  const t = d instanceof Date ? d.getTime() : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * Build a UI-safe bot summary for an asset from the registered bot runtime.
 * Returns null when no bot is registered or the asset has no state.
 */
export function getBotAssetSummaryForDetail(assetId: string): MarketDetailLiveBotSummary | null {
  const runtime = getBotRuntimeForDebug();
  if (!runtime) return null;
  const state = runtime.getAssetState(assetId);
  if (!state) return null;
  return {
    lastAction: state.lastSignal,
    lastEvaluatedAt: toIso(state.lastEvaluatedAt),
    lastDecisionAt: toIso(state.lastDecisionAt),
    mode: state.mode,
  };
}
