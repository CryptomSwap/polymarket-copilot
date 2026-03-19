/**
 * Latency and data-integrity monitoring for the runtime. Lightweight, non-blocking.
 * Tracks stream-to-engine latency, processing latencies, and integrity counters.
 * Used by health/dashboard and degraded logic.
 */

const ROLLING_SIZE = 100;

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx] ?? null;
}

function rollingStats(samples: number[]): {
  last: number | null;
  p50: number | null;
  p95: number | null;
  maxRecent: number | null;
  count: number;
} {
  if (samples.length === 0) {
    return { last: null, p50: null, p95: null, maxRecent: null, count: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    last: samples[samples.length - 1] ?? null,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    maxRecent: Math.max(...samples),
    count: samples.length,
  };
}

export interface LatencySeriesSnapshot {
  lastMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  maxRecentMs: number | null;
  sampleCount: number;
}

export interface LatencyMonitorSnapshot {
  asOf: string;
  /** Market message receive → engine apply complete. */
  marketStreamToEngine: LatencySeriesSnapshot;
  /** User message receive → lifecycle apply complete. */
  userStreamToEngine: LatencySeriesSnapshot;
  /** Market normalization only. */
  marketNormalization: LatencySeriesSnapshot;
  /** User normalization only. */
  userNormalization: LatencySeriesSnapshot;
  /** Market engine apply (feedNormalizedUpdatesToEngine). */
  marketEngineApply: LatencySeriesSnapshot;
  /** Lifecycle apply (order ack/fill/cancel applied). */
  lifecycleApply: LatencySeriesSnapshot;
  /** Bot evaluation (scheduler run). */
  botEvaluation: LatencySeriesSnapshot;
  /** Guardrail evaluation. */
  guardrailEvaluation: LatencySeriesSnapshot;
  /** Reconcile duration (intent reconciliation). */
  reconcileDuration: LatencySeriesSnapshot;
  /** Rebuild duration (startup). */
  rebuildDuration: LatencySeriesSnapshot;
  /** Heartbeat round-trip if available. */
  heartbeatLatency: LatencySeriesSnapshot;
}

export interface IntegrityCountersSnapshot {
  malformedMarketPayloads: number;
  malformedUserPayloads: number;
  outOfOrderFills: number;
  unmatchedExchangeOrderIds: number;
  duplicateLifecycleEvents: number;
  droppedSchedulerEvents: number;
  coalescedSchedulerEvents: number;
  /** Cumulative ms subscription was out of sync (optional). */
  subscriptionMismatchDurationMs: number;
  /** Number of stream silence periods detected. */
  streamSilencePeriods: number;
}

export interface RuntimeLatencyMonitorSnapshot {
  latency: LatencyMonitorSnapshot;
  integrity: IntegrityCountersSnapshot;
}

/** Degraded reason codes for severe latency/integrity. */
export const LATENCY_DEGRADED_REASONS = {
  MARKET_PROCESSING_LATENCY_HIGH: "market_processing_latency_high",
  USER_PROCESSING_LATENCY_HIGH: "user_processing_latency_high",
  RECONCILE_LATENCY_HIGH: "reconcile_latency_high",
  MALFORMED_PAYLOAD_RATE_HIGH: "malformed_payload_rate_high",
  OUT_OF_ORDER_EVENT_RATE_HIGH: "out_of_order_event_rate_high",
} as const;

export type LatencyDegradedReason =
  (typeof LATENCY_DEGRADED_REASONS)[keyof typeof LATENCY_DEGRADED_REASONS];

function createLatencySeries(): number[] {
  return [];
}

function pushRolling(arr: number[], value: number, maxSize: number): void {
  arr.push(value);
  if (arr.length > maxSize) arr.shift();
}

export interface RuntimeLatencyMonitorConfig {
  rollingSize?: number;
  /** ms: market stream-to-engine above this => market_processing_latency_high. */
  marketLatencyThresholdMs?: number;
  /** ms: user stream-to-engine above this => user_processing_latency_high. */
  userLatencyThresholdMs?: number;
  /** ms: reconcile duration above this => reconcile_latency_high. */
  reconcileLatencyThresholdMs?: number;
  /** Malformed count in window above this => malformed_payload_rate_high. */
  malformedRateThreshold?: number;
  /** Out-of-order count in window above this => out_of_order_event_rate_high. */
  outOfOrderRateThreshold?: number;
  /** Window ms for rate thresholds (default 60_000). */
  rateWindowMs?: number;
}

const DEFAULT_MARKET_LATENCY_MS = 5000;
const DEFAULT_USER_LATENCY_MS = 5000;
const DEFAULT_RECONCILE_LATENCY_MS = 30_000;
const DEFAULT_MALFORMED_RATE = 10;
const DEFAULT_OUT_OF_ORDER_RATE = 5;
const DEFAULT_RATE_WINDOW_MS = 60_000;

/**
 * Lightweight latency and integrity monitor. Non-blocking; call record* from hot path.
 */
export class RuntimeLatencyMonitor {
  private readonly rollingSize: number;
  private readonly marketLatencyThresholdMs: number;
  private readonly userLatencyThresholdMs: number;
  private readonly reconcileLatencyThresholdMs: number;
  private readonly malformedRateThreshold: number;
  private readonly outOfOrderRateThreshold: number;
  private readonly rateWindowMs: number;

  private marketStreamToEngine: number[] = [];
  private userStreamToEngine: number[] = [];
  private marketNormalization: number[] = [];
  private userNormalization: number[] = [];
  private marketEngineApply: number[] = [];
  private lifecycleApply: number[] = [];
  private botEvaluation: number[] = [];
  private guardrailEvaluation: number[] = [];
  private reconcileDuration: number[] = [];
  private rebuildDuration: number[] = [];
  private heartbeatLatency: number[] = [];

  private malformedMarketPayloads = 0;
  private malformedUserPayloads = 0;
  private outOfOrderFills = 0;
  private unmatchedExchangeOrderIds = 0;
  private duplicateLifecycleEvents = 0;
  private droppedSchedulerEvents = 0;
  private coalescedSchedulerEvents = 0;
  private subscriptionMismatchDurationMs = 0;
  private streamSilencePeriods = 0;

  private malformedTimestamps: number[] = [];
  private outOfOrderTimestamps: number[] = [];

  constructor(config: RuntimeLatencyMonitorConfig = {}) {
    this.rollingSize = config.rollingSize ?? ROLLING_SIZE;
    this.marketLatencyThresholdMs = config.marketLatencyThresholdMs ?? DEFAULT_MARKET_LATENCY_MS;
    this.userLatencyThresholdMs = config.userLatencyThresholdMs ?? DEFAULT_USER_LATENCY_MS;
    this.reconcileLatencyThresholdMs =
      config.reconcileLatencyThresholdMs ?? DEFAULT_RECONCILE_LATENCY_MS;
    this.malformedRateThreshold = config.malformedRateThreshold ?? DEFAULT_MALFORMED_RATE;
    this.outOfOrderRateThreshold = config.outOfOrderRateThreshold ?? DEFAULT_OUT_OF_ORDER_RATE;
    this.rateWindowMs = config.rateWindowMs ?? DEFAULT_RATE_WINDOW_MS;
  }

  recordMarketStreamToEngineMs(ms: number): void {
    pushRolling(this.marketStreamToEngine, ms, this.rollingSize);
  }

  recordUserStreamToEngineMs(ms: number): void {
    pushRolling(this.userStreamToEngine, ms, this.rollingSize);
  }

  recordMarketNormalizationMs(ms: number): void {
    pushRolling(this.marketNormalization, ms, this.rollingSize);
  }

  recordUserNormalizationMs(ms: number): void {
    pushRolling(this.userNormalization, ms, this.rollingSize);
  }

  recordMarketEngineApplyMs(ms: number): void {
    pushRolling(this.marketEngineApply, ms, this.rollingSize);
  }

  recordLifecycleApplyMs(ms: number): void {
    pushRolling(this.lifecycleApply, ms, this.rollingSize);
  }

  recordBotEvaluationMs(ms: number): void {
    pushRolling(this.botEvaluation, ms, this.rollingSize);
  }

  recordGuardrailEvaluationMs(ms: number): void {
    pushRolling(this.guardrailEvaluation, ms, this.rollingSize);
  }

  recordReconcileDurationMs(ms: number): void {
    pushRolling(this.reconcileDuration, ms, this.rollingSize);
  }

  recordRebuildDurationMs(ms: number): void {
    pushRolling(this.rebuildDuration, ms, this.rollingSize);
  }

  recordHeartbeatLatencyMs(ms: number): void {
    pushRolling(this.heartbeatLatency, ms, this.rollingSize);
  }

  recordMalformedMarketPayload(): void {
    this.malformedMarketPayloads += 1;
    this.malformedTimestamps.push(Date.now());
    this.pruneRateTimestamps();
  }

  recordMalformedUserPayload(): void {
    this.malformedUserPayloads += 1;
    this.malformedTimestamps.push(Date.now());
    this.pruneRateTimestamps();
  }

  recordOutOfOrderFill(): void {
    this.outOfOrderFills += 1;
    this.outOfOrderTimestamps.push(Date.now());
    this.pruneRateTimestamps();
  }

  recordUnmatchedExchangeOrderId(): void {
    this.unmatchedExchangeOrderIds += 1;
  }

  recordDuplicateLifecycleEvent(): void {
    this.duplicateLifecycleEvents += 1;
  }

  recordDroppedSchedulerEvent(): void {
    this.droppedSchedulerEvents += 1;
  }

  recordCoalescedSchedulerEvent(): void {
    this.coalescedSchedulerEvents += 1;
  }

  recordSubscriptionMismatchDurationMs(ms: number): void {
    this.subscriptionMismatchDurationMs += ms;
  }

  recordStreamSilencePeriod(): void {
    this.streamSilencePeriods += 1;
  }

  private pruneRateTimestamps(): void {
    const cutoff = Date.now() - this.rateWindowMs;
    this.malformedTimestamps = this.malformedTimestamps.filter((t) => t > cutoff);
    this.outOfOrderTimestamps = this.outOfOrderTimestamps.filter((t) => t > cutoff);
  }

  private toSeries(samples: number[]): LatencySeriesSnapshot {
    const s = rollingStats(samples);
    return {
      lastMs: s.last,
      p50Ms: s.p50,
      p95Ms: s.p95,
      maxRecentMs: s.maxRecent,
      sampleCount: s.count,
    };
  }

  getSnapshot(): RuntimeLatencyMonitorSnapshot {
    const asOf = new Date().toISOString();
    return {
      latency: {
        asOf,
        marketStreamToEngine: this.toSeries(this.marketStreamToEngine),
        userStreamToEngine: this.toSeries(this.userStreamToEngine),
        marketNormalization: this.toSeries(this.marketNormalization),
        userNormalization: this.toSeries(this.userNormalization),
        marketEngineApply: this.toSeries(this.marketEngineApply),
        lifecycleApply: this.toSeries(this.lifecycleApply),
        botEvaluation: this.toSeries(this.botEvaluation),
        guardrailEvaluation: this.toSeries(this.guardrailEvaluation),
        reconcileDuration: this.toSeries(this.reconcileDuration),
        rebuildDuration: this.toSeries(this.rebuildDuration),
        heartbeatLatency: this.toSeries(this.heartbeatLatency),
      },
      integrity: {
        malformedMarketPayloads: this.malformedMarketPayloads,
        malformedUserPayloads: this.malformedUserPayloads,
        outOfOrderFills: this.outOfOrderFills,
        unmatchedExchangeOrderIds: this.unmatchedExchangeOrderIds,
        duplicateLifecycleEvents: this.duplicateLifecycleEvents,
        droppedSchedulerEvents: this.droppedSchedulerEvents,
        coalescedSchedulerEvents: this.coalescedSchedulerEvents,
        subscriptionMismatchDurationMs: this.subscriptionMismatchDurationMs,
        streamSilencePeriods: this.streamSilencePeriods,
      },
    };
  }

  /**
   * Reasons to add to degraded when latency/integrity thresholds are exceeded.
   */
  getDegradedReasons(): LatencyDegradedReason[] {
    const reasons: LatencyDegradedReason[] = [];
    const marketStats = rollingStats(this.marketStreamToEngine);
    const userStats = rollingStats(this.userStreamToEngine);
    const reconcileStats = rollingStats(this.reconcileDuration);
    // Use a high percentile (p95) instead of a rolling max so a single historical
    // latency spike doesn't keep the runtime permanently degraded for the full
    // rolling window.
    const marketWorst = marketStats.p95 ?? marketStats.last ?? 0;
    const userWorst = userStats.p95 ?? userStats.last ?? 0;
    const reconcileWorst = reconcileStats.p95 ?? reconcileStats.last ?? 0;
    if (this.marketStreamToEngine.length > 0 && marketWorst >= this.marketLatencyThresholdMs) {
      reasons.push(LATENCY_DEGRADED_REASONS.MARKET_PROCESSING_LATENCY_HIGH);
    }
    if (this.userStreamToEngine.length > 0 && userWorst >= this.userLatencyThresholdMs) {
      reasons.push(LATENCY_DEGRADED_REASONS.USER_PROCESSING_LATENCY_HIGH);
    }
    if (this.reconcileDuration.length > 0 && reconcileWorst >= this.reconcileLatencyThresholdMs) {
      reasons.push(LATENCY_DEGRADED_REASONS.RECONCILE_LATENCY_HIGH);
    }
    this.pruneRateTimestamps();
    if (this.malformedTimestamps.length >= this.malformedRateThreshold) {
      reasons.push(LATENCY_DEGRADED_REASONS.MALFORMED_PAYLOAD_RATE_HIGH);
    }
    if (this.outOfOrderTimestamps.length >= this.outOfOrderRateThreshold) {
      reasons.push(LATENCY_DEGRADED_REASONS.OUT_OF_ORDER_EVENT_RATE_HIGH);
    }
    return reasons;
  }

  reset(): void {
    this.marketStreamToEngine = [];
    this.userStreamToEngine = [];
    this.marketNormalization = [];
    this.userNormalization = [];
    this.marketEngineApply = [];
    this.lifecycleApply = [];
    this.botEvaluation = [];
    this.guardrailEvaluation = [];
    this.reconcileDuration = [];
    this.rebuildDuration = [];
    this.heartbeatLatency = [];
    this.malformedMarketPayloads = 0;
    this.malformedUserPayloads = 0;
    this.outOfOrderFills = 0;
    this.unmatchedExchangeOrderIds = 0;
    this.duplicateLifecycleEvents = 0;
    this.droppedSchedulerEvents = 0;
    this.coalescedSchedulerEvents = 0;
    this.subscriptionMismatchDurationMs = 0;
    this.streamSilencePeriods = 0;
    this.malformedTimestamps = [];
    this.outOfOrderTimestamps = [];
  }
}
