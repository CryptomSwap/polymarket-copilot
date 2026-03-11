import type { BotDecisionEnvelope } from "./bot-decision-types";
import type { BotRuntimeContextProvider } from "./bot-context";

export type TriggerPriority = "low" | "normal" | "high" | "priority";

const PRIORITY_ORDER: Record<TriggerPriority, number> = {
  low: 0,
  normal: 1,
  high: 2,
  priority: 3,
};

export interface BotSchedulerOptions {
  contextProvider: BotRuntimeContextProvider;
  /** Coalesce window in ms: events within this window are merged per assetId. */
  coalesceMs: number;
  /** Funder address for context (required for envelope). */
  funderAddress: string;
  /** Strategy id for context. */
  strategyId: string;
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
}

export type BotDecisionCallback = (envelope: BotDecisionEnvelope) => void | Promise<void>;

/**
 * Event-driven scheduler: queues assetIds, coalesces bursts, prevents duplicate concurrent
 * evaluation per asset, supports priority. Drains queue after coalesce window.
 */
export class EventDrivenBotScheduler implements BotScheduler {
  private readonly options: BotSchedulerOptions;
  private readonly onDecision: BotDecisionCallback;
  private coalesceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly queue = new Map<string, TriggerPriority>();
  private readonly inFlight = new Set<string>();
  private started = false;

  constructor(options: BotSchedulerOptions, onDecision: BotDecisionCallback) {
    this.options = options;
    this.onDecision = onDecision;
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

  enqueue(assetId: string, priority: TriggerPriority = "normal"): void {
    if (!this.started || !assetId?.trim()) return;
    const id = assetId.trim();
    const existing = this.queue.get(id);
    const order = PRIORITY_ORDER[priority];
    if (existing !== undefined && PRIORITY_ORDER[existing] >= order) return;
    this.queue.set(id, priority);
    this.scheduleDrain();
  }

  enqueueBatch(assetIds: string[], priority: TriggerPriority = "normal"): void {
    for (const id of assetIds) {
      this.enqueue(id, priority);
    }
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
      const envelope: BotDecisionEnvelope = {
        context: {
          funderAddress: this.options.funderAddress,
          strategyId: this.options.strategyId,
          asOf: snapshot.asOf,
          assetId,
        },
        decisions: [],
      };
      Promise.resolve(this.onDecision(envelope))
        .then(() => {
          this.inFlight.delete(assetId);
        })
        .catch(() => {
          this.inFlight.delete(assetId);
        });
    }
  }
}
