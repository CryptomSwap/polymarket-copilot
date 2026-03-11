/**
 * Pure health and freshness evaluation for market state.
 * No store mutation; intended for use by Market State Engine and risk layer.
 */

import type { MarketStateMetrics } from "./market-state-metrics";

// ---------- Configurable health thresholds ----------

export interface HealthConfig {
  /** No market event for this many ms → consider stale. */
  staleAfterMs: number;
  /** No market event for this many ms → consider degraded (softer than stale). */
  degradedAfterMs: number;
  /** After recovery, require event within this many ms to confirm recovered. */
  recoveryGraceMs: number;
  /** Source confidence below this → treat as low confidence. */
  minSourceConfidence: number;
  /** Minimum tracked assets to consider stream healthy. */
  minTrackedAssetsForHealthy: number;
}

export const DEFAULT_HEALTH_CONFIG: HealthConfig = {
  staleAfterMs: 120_000,
  degradedAfterMs: 60_000,
  recoveryGraceMs: 5_000,
  minSourceConfidence: 0.5,
  minTrackedAssetsForHealthy: 1,
};

// ---------- Stale detection ----------

/**
 * True if last market event is older than staleAfterMs from now.
 * Intended for per-asset or stream-level freshness.
 */
export function isStale(
  lastMarketEventAt: Date | null | undefined,
  now: Date,
  config: HealthConfig = DEFAULT_HEALTH_CONFIG
): boolean {
  if (lastMarketEventAt == null) return true;
  const t = lastMarketEventAt instanceof Date ? lastMarketEventAt.getTime() : NaN;
  if (!Number.isFinite(t)) return true;
  return now.getTime() - t >= config.staleAfterMs;
}

// ---------- Degraded detection ----------

/**
 * True if last market event is older than degradedAfterMs but not necessarily stale.
 * Use for "soft" warning before marking fully stale.
 */
export function isDegraded(
  lastMarketEventAt: Date | null | undefined,
  now: Date,
  config: HealthConfig = DEFAULT_HEALTH_CONFIG
): boolean {
  if (lastMarketEventAt == null) return true;
  const t = lastMarketEventAt instanceof Date ? lastMarketEventAt.getTime() : NaN;
  if (!Number.isFinite(t)) return true;
  return now.getTime() - t >= config.degradedAfterMs;
}

// ---------- Recovery detection ----------

/**
 * True if we consider the stream/asset recovered: had an event recently (within recoveryGraceMs of now).
 * Intended to transition from stale → healthy when events resume.
 */
export function isRecovered(
  lastMarketEventAt: Date | null | undefined,
  now: Date,
  config: HealthConfig = DEFAULT_HEALTH_CONFIG
): boolean {
  if (lastMarketEventAt == null) return false;
  const t = lastMarketEventAt instanceof Date ? lastMarketEventAt.getTime() : NaN;
  if (!Number.isFinite(t)) return false;
  return now.getTime() - t <= config.recoveryGraceMs;
}

/**
 * Whether state has moved from stale to fresh (recovered) compared to a previous evaluation.
 * Pass previous and current lastMarketEventAt; returns true if was stale and now is not.
 */
export function detectedRecovery(
  prevLastMarketEventAt: Date | null | undefined,
  currentLastMarketEventAt: Date | null | undefined,
  now: Date,
  config: HealthConfig = DEFAULT_HEALTH_CONFIG
): boolean {
  const wasStale = isStale(prevLastMarketEventAt, now, config);
  const nowFresh = !isStale(currentLastMarketEventAt, now, config);
  return wasStale && nowFresh;
}

// ---------- Source confidence transitions ----------

export type SourceConfidenceTransition = "improved" | "unchanged" | "worsened";

/**
 * Compare previous and current source confidence; returns transition direction.
 * Uses minSourceConfidence to treat "below threshold" as low.
 */
export function sourceConfidenceTransition(
  prevConfidence: number | null | undefined,
  nextConfidence: number | null | undefined,
  config: HealthConfig = DEFAULT_HEALTH_CONFIG
): SourceConfidenceTransition {
  const prev = safeConfidence(prevConfidence);
  const next = safeConfidence(nextConfidence);
  const delta = next - prev;
  if (Math.abs(delta) < 1e-9) return "unchanged";
  return delta > 0 ? "improved" : "worsened";
}

function safeConfidence(c: number | null | undefined): number {
  if (c == null || !Number.isFinite(c)) return 0;
  return Math.max(0, Math.min(1, c));
}

/**
 * Whether current source confidence is above the minimum threshold.
 */
export function hasSufficientSourceConfidence(
  sourceConfidence: number | null | undefined,
  config: HealthConfig = DEFAULT_HEALTH_CONFIG
): boolean {
  const c = safeConfidence(sourceConfidence);
  return c >= config.minSourceConfidence;
}

// ---------- Repair timestamp handling ----------

/**
 * Last "known good" time: more recent of lastRepairAt and lastMarketEventAt.
 * Use for reporting or for "last time we had a valid state".
 */
export function lastKnownGoodAt(
  lastRepairAt: Date | null | undefined,
  lastMarketEventAt: Date | null | undefined
): Date | null {
  const repair = toTime(lastRepairAt);
  const event = toTime(lastMarketEventAt);
  if (repair == null && event == null) return null;
  if (repair == null) return lastMarketEventAt ?? null;
  if (event == null) return lastRepairAt ?? null;
  return repair >= event ? (lastRepairAt ?? null) : (lastMarketEventAt ?? null);
}

function toTime(d: Date | null | undefined): number | null {
  if (d == null) return null;
  const t = d instanceof Date ? d.getTime() : NaN;
  return Number.isFinite(t) ? t : null;
}

/**
 * Whether a repair is recent relative to now (within recoveryGraceMs).
 * Use to avoid treating recently repaired state as stale immediately.
 */
export function repairIsRecent(
  lastRepairAt: Date | null | undefined,
  now: Date,
  config: HealthConfig = DEFAULT_HEALTH_CONFIG
): boolean {
  if (lastRepairAt == null) return false;
  const t = toTime(lastRepairAt);
  if (t == null) return false;
  return now.getTime() - t <= config.recoveryGraceMs;
}

// ---------- Runtime health state (aggregate) ----------

export type RuntimeHealthStatus = "healthy" | "degraded" | "unhealthy";

export interface RuntimeHealthState {
  status: RuntimeHealthStatus;
  summary: string;
  reasons: string[];
  metrics: MarketStateMetrics;
  evaluatedAt: Date;
}

export interface MarketStateHealthChecker {
  evaluate(metrics: MarketStateMetrics): RuntimeHealthState;
}

/**
 * Evaluate aggregate stream health from metrics (track count, lastUpdateAt).
 * No per-asset state here; engine can call isStale/isDegraded per asset and aggregate.
 */
export class BasicMarketStateHealthChecker implements MarketStateHealthChecker {
  constructor(private readonly config: HealthConfig = DEFAULT_HEALTH_CONFIG) {}

  evaluate(metrics: MarketStateMetrics): RuntimeHealthState {
    const now = new Date();
    const reasons: string[] = [];
    let status: RuntimeHealthStatus = "healthy";

    if (metrics.trackedAssetCount < this.config.minTrackedAssetsForHealthy) {
      reasons.push("tracked_asset_count_below_minimum");
      status = "unhealthy";
    }

    const lastAt = metrics.lastUpdateAt;
    if (lastAt == null) {
      reasons.push("no_market_event_ever");
      status = status === "healthy" ? "degraded" : status;
    } else {
      const ageMs = now.getTime() - lastAt.getTime();
      if (ageMs >= this.config.staleAfterMs) {
        reasons.push("stream_stale");
        status = "unhealthy";
      } else if (ageMs >= this.config.degradedAfterMs) {
        reasons.push("stream_degraded");
        if (status === "healthy") status = "degraded";
      }
    }

    const summary =
      status === "healthy"
        ? "Market state stream healthy."
        : status === "degraded"
          ? "Market state stream degraded; check connectivity."
          : "Market state stream unhealthy; do not rely on live data.";

    return {
      status,
      summary,
      reasons,
      metrics,
      evaluatedAt: now,
    };
  }
}
