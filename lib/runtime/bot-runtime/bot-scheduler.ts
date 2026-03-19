import type { BotDecisionEnvelope } from "./bot-decision-types";
import type { BotRuntimeContextProvider } from "./bot-context";

export type TriggerPriority = "low" | "normal" | "high" | "priority";

const PRIORITY_ORDER: Record<TriggerPriority, number> = {
  low: 0,
  normal: 1,
  high: 2,
  priority: 3,
};

/** Config for flood/backlog protection. Lifecycle-critical (high/priority) are never dropped. */
export interface SchedulerOverloadConfig {
  /** Max queued assets (pending + in-flight can exceed this when only high/priority enqueued). */
  maxQueueSize: number;
  /** When queue size >= this, treat as overloaded (degraded, diagnostics). */
  overloadThreshold: number;
  /** When at maxQueueSize, reject new low/normal enqueues; high/priority always accepted. */
  dropLowPriorityWhenFull: boolean;
}

export const DEFAULT_SCHEDULER_OVERLOAD_CONFIG: SchedulerOverloadConfig = {
  maxQueueSize: 500,
  overloadThreshold: 100,
  dropLowPriorityWhenFull: true,
};

/** Callbacks for scheduler metrics (optional). Avoids coupling to diagnostics. */
export interface SchedulerDiagnosticsCallback {
  recordCoalesced(): void;
  recordDropped(): void;
  recordEvaluationLatency(ms: number): void;
  recordOverload(): void;
  recordHighWaterMark(mark: number): void;
}

export interface BotSchedulerOptions {
  contextProvider: BotRuntimeContextProvider;
  /** Coalesce window in ms: events within this window are merged per assetId. */
  coalesceMs: number;
  /** Funder address for context (required for envelope). */
  funderAddress: string;
  /** Strategy id for context. */
  strategyId: string;
  /** Overload protection (max queue, thresholds). */
  overloadConfig?: SchedulerOverloadConfig;
  /** Optional: record coalesced/dropped/latency/overload for diagnostics. */
  schedulerDiagnostics?: SchedulerDiagnosticsCallback;
}

export interface BotScheduler {
  start(): void;
  stop(): void;
  /** Queue an asset for evaluation. Call from event handlers; avoids inline heavy work. */
  enqueue(assetId: string, priority?: TriggerPriority): void;
  /** Queue multiple assets (e.g. from regime or risk events). */
  enqueueBatch(assetIds: string[], priority?: TriggerPriority): void;
  /** Current queue size (pending evaluations). For health/backlog reporting. */
  getQueueSize(): number;
  /** Number of assets currently being evaluated. */
  getInFlightCount(): number;
  /** Max queue size observed since start. */
  getQueueHighWaterMark(): number;
  /** Coalesced enqueues (assetId already in queue, priority updated or skipped). */
  getCoalescedCount(): number;
  /** Enqueues rejected due to full queue (low/normal only). */
  getDroppedCount(): number;
  /** Last evaluation duration in ms. */
  getLastEvaluationLatencyMs(): number | null;
  /** Number of times load crossed above overloadThreshold. */
  getOverloadPeriodCount(): number;
  /** True when queue size + in-flight >= overloadThreshold. */
  isOverloaded(): boolean;
}

export type BotDecisionCallback = (envelope: BotDecisionEnvelope) => void | Promise<void>;

/**
 * Event-driven scheduler: queues assetIds, coalesces bursts, prevents duplicate concurrent
 * evaluation per asset, supports priority. Drains queue after coalesce window.
 * Lifecycle-critical (high/priority) are never dropped when at capacity.
 */
export class EventDrivenBotScheduler implements BotScheduler {
  private readonly options: BotSchedulerOptions;
  private readonly onDecision: BotDecisionCallback;
  private readonly overload: SchedulerOverloadConfig;
  private coalesceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly queue = new Map<string, TriggerPriority>();
  private readonly inFlight = new Set<string>();
  private started = false;
  private queueHighWaterMark = 0;
  private coalescedCount = 0;
  private droppedCount = 0;
  private lastEvaluationLatencyMs: number | null = null;
  private overloadPeriodCount = 0;
  private wasOverloaded = false;

  constructor(options: BotSchedulerOptions, onDecision: BotDecisionCallback) {
    this.options = options;
    this.onDecision = onDecision;
    this.overload = options.overloadConfig ?? DEFAULT_SCHEDULER_OVERLOAD_CONFIG;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
  }

  stop(): void {
    this.started = false;
    if (this.coalesceTimer) {
      clearTimeout(this.coalesceTimer);
      this.coalesceTimer = null;
    }
    this.queue.clear();
    this.inFlight.clear();
  }

  getQueueSize(): number {
    return this.queue.size;
  }

  getInFlightCount(): number {
    return this.inFlight.size;
  }

  getQueueHighWaterMark(): number {
    return this.queueHighWaterMark;
  }

  getCoalescedCount(): number {
    return this.coalescedCount;
  }

  getDroppedCount(): number {
    return this.droppedCount;
  }

  getLastEvaluationLatencyMs(): number | null {
    return this.lastEvaluationLatencyMs;
  }

  getOverloadPeriodCount(): number {
    return this.overloadPeriodCount;
  }

  isOverloaded(): boolean {
    const load = this.queue.size + this.inFlight.size;
    return load >= this.overload.overloadThreshold;
  }

  enqueue(assetId: string, priority: TriggerPriority = "normal"): void {
    if (!this.started || !assetId?.trim()) return;
    const id = assetId.trim();
    const existing = this.queue.get(id);
    const order = PRIORITY_ORDER[priority];
    const isHighOrPriority = priority === "high" || priority === "priority";

    if (existing !== undefined) {
      this.coalescedCount += 1;
      this.options.schedulerDiagnostics?.recordCoalesced();
      if (PRIORITY_ORDER[existing] >= order) return;
    }

    const atCap = this.queue.size >= this.overload.maxQueueSize;
    if (
      atCap &&
      this.overload.dropLowPriorityWhenFull &&
      !isHighOrPriority
    ) {
      this.droppedCount += 1;
      this.options.schedulerDiagnostics?.recordDropped();
      return;
    }

    this.queue.set(id, priority);
    if (this.queue.size > this.queueHighWaterMark) {
      this.queueHighWaterMark = this.queue.size;
      this.options.schedulerDiagnostics?.recordHighWaterMark(this.queueHighWaterMark);
    }
    this.updateOverloadState();
    this.scheduleDrain();
  }

  enqueueBatch(assetIds: string[], priority: TriggerPriority = "normal"): void {
    for (const id of assetIds) {
      this.enqueue(id, priority);
    }
  }

  private updateOverloadState(): void {
    const overloaded = this.isOverloaded();
    if (overloaded && !this.wasOverloaded) {
      this.overloadPeriodCount += 1;
      this.options.schedulerDiagnostics?.recordOverload();
    }
    this.wasOverloaded = overloaded;
  }

  private scheduleDrain(): void {
    if (this.coalesceTimer != null) return;
    this.coalesceTimer = setTimeout(() => {
      this.coalesceTimer = null;
      this.drainQueue();
    }, this.options.coalesceMs);
  }

  private drainQueue(): void {
    if (this.queue.size === 0) return;
    const snapshot = this.options.contextProvider.createSnapshot();
    const entries = Array.from(this.queue.entries()).sort(
      (a, b) => PRIORITY_ORDER[b[1]] - PRIORITY_ORDER[a[1]]
    );
    this.queue.clear();

    for (const [assetId, _priority] of entries) {
      if (this.inFlight.has(assetId)) continue;
      this.inFlight.add(assetId);
      this.updateOverloadState();
      const startMs = Date.now();
      const envelope: BotDecisionEnvelope = {
        context: {
          funderAddress: this.options.funderAddress,
          strategyId: this.options.strategyId,
          asOf: snapshot.asOf,
          assetId,
        },
        decisions: [],
      };
      const onDone = (): void => {
        this.lastEvaluationLatencyMs = Date.now() - startMs;
        this.options.schedulerDiagnostics?.recordEvaluationLatency(this.lastEvaluationLatencyMs);
        this.inFlight.delete(assetId);
        this.updateOverloadState();
      };
      Promise.resolve(this.onDecision(envelope))
        .then(onDone)
        .catch(onDone);
    }
  }
}
