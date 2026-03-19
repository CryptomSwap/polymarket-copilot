/**
 * Runtime diagnostics: counters and optional structured logging for observability.
 * Used by health/debug endpoints and ops; must not block the hot path.
 */

import type { RuntimeEvent } from "../events/runtime-events";

export type DiagnosticsLogLevel = "debug" | "info" | "warn" | "error";
export type DiagnosticsLogFn = (
  level: DiagnosticsLogLevel,
  message: string,
  meta?: Record<string, unknown>
) => void;

/** Snapshot of diagnostics for health/ops; all counts since process start (or last reset). */
export interface RuntimeDiagnosticsSnapshot {
  asOf: string;
  /** Market updates applied (from WS feed into engine). */
  marketUpdatesApplied: number;
  /** Total material events emitted (all event types). */
  materialEventsEmitted: number;
  /** Events by type (for drill-down). */
  eventsByType: Record<string, number>;
  /** Bot evaluations (bot.decision.evaluated count). */
  botEvaluations: number;
  /** Decision action counts (NOOP, UPDATE_QUOTES, CANCEL_ORDERS, etc.). */
  decisionTypesByAction: Record<string, number>;
  /** NOOP reason code counts (market_degraded, no_signal, market_not_tradable, etc.) for diagnostics. */
  noopReasonsByCode: Record<string, number>;
  /** Order intents generated (order.intent.created). */
  orderIntentsGenerated: number;
  /** Intents blocked by runtime mode (observe_only, disabled, live). Key = mode. */
  intentsBlockedByMode: Record<string, number>;
  /** Intents blocked by guardrails (risk/limit). */
  intentsBlockedByGuardrails: number;
  /** Intents blocked by freshness (market_data_stale, user_data_stale, etc.). */
  intentsBlockedByFreshness: number;
  /** Freshness block reason code counts (market_data_stale, user_data_stale, reconciliation_stale, etc.). */
  freshnessBlockReasonCounts: Record<string, number>;
  /** Reconciliation actions by kind (KEEP, PLACE, CANCEL, CANCEL_REPLACE). */
  reconciliationActionsByKind: Record<string, number>;
  /** Fills handled (order.partial_fill + order.filled). */
  fillsHandled: number;
  /** Partial fills applied to position store. */
  partialFillsApplied: number;
  /** Full fills applied to position store. */
  fullFillsApplied: number;
  /** Position store updates (applyFill calls). */
  positionUpdates: number;
  /** Exposure update invocations (updateRiskExposureFromStores). */
  exposureUpdates: number;
  /** Stale order detections (order.stale). */
  staleOrderDetections: number;
  /** Risk blocks (risk.limit_hit). */
  riskBlocks: number;
  /** Kill switch changes (risk.kill_switch_changed). */
  killSwitchChanges: number;
  /** Degraded entries (market.stale). */
  degradedModeEntries: number;
  /** Degraded exits (market.recovered). */
  degradedModeExits: number;
  /** Reconciliation failures (reconcileIntents threw or rejected). */
  reconcileFailureCount: number;
  /** Last reconcile failure timestamp (ISO). */
  lastReconcileFailureAt: string | null;
  /** Last reconcile failure reason/message. */
  lastReconcileFailureReason: string | null;
  /** Last reconcile failure intent id if available. */
  lastReconcileFailureIntentId: string | null;
  /** Runtime vs exchange reconciliation: total runs. */
  runtimeReconciliationRuns: number;
  /** Runtime vs exchange reconciliation: failure count. */
  runtimeReconciliationFailures: number;
  /** Last runtime reconciliation timestamp (ISO). */
  lastRuntimeReconciliationAt: string | null;
  /** Last runtime reconciliation status. */
  lastRuntimeReconciliationStatus: "ok" | "failure" | null;
  /** Number of times drift was detected (missing local/exchange orders, fill mismatch). */
  driftDetectionsCount: number;
  /** Repairs attempted (e.g. mark_local_canceled applied). */
  repairsAttemptedCount: number;
  /** Repairs successfully applied. */
  repairsAppliedCount: number;
  /** Scheduler: max queue size observed since start. */
  schedulerQueueHighWaterMark: number;
  /** Scheduler: enqueues rejected (queue full, low/normal priority). */
  schedulerDroppedEvents: number;
  /** Scheduler: enqueues that merged with existing assetId. */
  schedulerCoalescedEvents: number;
  /** Scheduler: last evaluation duration (ms). */
  schedulerLastEvaluationLatencyMs: number | null;
  /** Scheduler: number of times load crossed above overload threshold. */
  schedulerOverloadPeriodCount: number;
  /** Execution failure containment: submit ambiguous (timeout/unknown outcome). */
  submitAmbiguousCount: number;
  /** Execution failure containment: cancel ambiguous. */
  cancelAmbiguousCount: number;
  /** Execution failure containment: replace ambiguous (cancel-replace interrupted). */
  replaceAmbiguousCount: number;
  /** Execution failure containment: orders requiring verification. */
  executionVerificationRequiredCount: number;
}

const ZERO_SNAPSHOT = (): RuntimeDiagnosticsSnapshot => ({
  asOf: new Date().toISOString(),
  marketUpdatesApplied: 0,
  materialEventsEmitted: 0,
  eventsByType: {},
  botEvaluations: 0,
  decisionTypesByAction: {},
  noopReasonsByCode: {},
  orderIntentsGenerated: 0,
  intentsBlockedByMode: {},
  intentsBlockedByGuardrails: 0,
  intentsBlockedByFreshness: 0,
  freshnessBlockReasonCounts: {},
  reconciliationActionsByKind: {},
  fillsHandled: 0,
  partialFillsApplied: 0,
  fullFillsApplied: 0,
  positionUpdates: 0,
  exposureUpdates: 0,
  staleOrderDetections: 0,
  riskBlocks: 0,
  killSwitchChanges: 0,
  degradedModeEntries: 0,
  degradedModeExits: 0,
  reconcileFailureCount: 0,
  lastReconcileFailureAt: null,
  lastReconcileFailureReason: null,
  lastReconcileFailureIntentId: null,
  runtimeReconciliationRuns: 0,
  runtimeReconciliationFailures: 0,
  lastRuntimeReconciliationAt: null,
  lastRuntimeReconciliationStatus: null,
  driftDetectionsCount: 0,
  repairsAttemptedCount: 0,
  repairsAppliedCount: 0,
  schedulerQueueHighWaterMark: 0,
  schedulerDroppedEvents: 0,
  schedulerCoalescedEvents: 0,
  schedulerLastEvaluationLatencyMs: null,
  schedulerOverloadPeriodCount: 0,
  submitAmbiguousCount: 0,
  cancelAmbiguousCount: 0,
  replaceAmbiguousCount: 0,
  executionVerificationRequiredCount: 0,
});

function safeIncr(map: Record<string, number>, key: string, delta = 1): void {
  map[key] = (map[key] ?? 0) + delta;
}

export interface RuntimeDiagnosticsCollector {
  /** Record that n market updates were applied (e.g. from WS → engine). */
  recordMarketUpdatesApplied(n: number): void;
  /** Record an event (increments event type and derived counters). */
  recordEvent(event: RuntimeEvent): void;
  /** Record a reconciliation action (KEEP, PLACE, CANCEL, CANCEL_REPLACE). */
  recordReconciliationAction(kind: string): void;
  /** Record intent blocked by runtime mode (observe_only, disabled, live). */
  recordIntentBlockedByMode(mode: string): void;
  /** Record intent blocked by guardrails. */
  recordIntentBlockedByGuardrails(): void;
  /** Record intent blocked by freshness (pass reason codes for counts). */
  recordIntentBlockedByFreshness(reasonCodes: string[]): void;
  /** Record a reconcileIntents failure (unhandled rejection or throw). */
  recordReconcileFailure(reason: string, intentId?: string | null): void;
  /** Record a runtime vs exchange reconciliation run (success). */
  recordRuntimeReconciliationRun(): void;
  /** Record a runtime vs exchange reconciliation failure. */
  recordRuntimeReconciliationFailure(): void;
  /** Record drift detected (missing orders, fill mismatch). */
  recordDriftDetected(): void;
  /** Record repair attempted (e.g. mark_local_canceled). */
  recordRepairAttempted(count?: number): void;
  /** Record repair applied. */
  recordRepairApplied(count?: number): void;
  /** Record scheduler coalesced enqueue (assetId already in queue). */
  recordSchedulerCoalesced(): void;
  /** Record scheduler dropped enqueue (queue full, low/normal). */
  recordSchedulerDropped(): void;
  /** Record scheduler evaluation latency (ms). */
  recordSchedulerEvaluationLatency(ms: number): void;
  /** Record scheduler overload (load crossed above threshold). */
  recordSchedulerOverload(): void;
  /** Record scheduler queue high-water mark. */
  recordSchedulerHighWaterMark(mark: number): void;
  /** Record a position store update (applyFill). */
  recordPositionUpdate(): void;
  /** Record an exposure update. */
  recordExposureUpdate(): void;
  /** Record a partial fill applied to positions. */
  recordPartialFillApplied(): void;
  /** Record a full fill applied to positions. */
  recordFullFillApplied(): void;
  /** Record submit ambiguous (adapter timeout/unknown). */
  recordSubmitAmbiguous(): void;
  /** Record cancel ambiguous. */
  recordCancelAmbiguous(): void;
  /** Record replace ambiguous (cancel-replace interrupted). */
  recordReplaceAmbiguous(): void;
  /** Record execution verification required. */
  recordExecutionVerificationRequired(): void;
  /** Return a serializable snapshot for health/ops. */
  getSnapshot(): RuntimeDiagnosticsSnapshot;
  /** Optional: set a log callback for structured diagnostics logs. */
  setLog(logFn: DiagnosticsLogFn | null): void;
  /** Emit a structured log line if log callback is set (e.g. block reason codes). */
  log(level: DiagnosticsLogLevel, message: string, meta?: Record<string, unknown>): void;
  /** Reset all counters (e.g. for tests). */
  reset(): void;
}

export class DefaultRuntimeDiagnosticsCollector implements RuntimeDiagnosticsCollector {
  private marketUpdatesApplied = 0;
  private eventsByType: Record<string, number> = {};
  private decisionTypesByAction: Record<string, number> = {};
  private noopReasonsByCode: Record<string, number> = {};
  private intentsBlockedByMode: Record<string, number> = {};
  private intentsBlockedByGuardrailsCount = 0;
  private reconciliationActionsByKind: Record<string, number> = {};
  private partialFillsApplied = 0;
  private fullFillsApplied = 0;
  private positionUpdatesCount = 0;
  private exposureUpdatesCount = 0;
  private logFn: DiagnosticsLogFn | null = null;
  private reconcileFailureCount = 0;
  private lastReconcileFailureAt: Date | null = null;
  private lastReconcileFailureReason: string | null = null;
  private lastReconcileFailureIntentId: string | null = null;
  private runtimeReconciliationRuns = 0;
  private runtimeReconciliationFailures = 0;
  private lastRuntimeReconciliationAt: Date | null = null;
  private lastRuntimeReconciliationStatus: "ok" | "failure" | null = null;
  private driftDetectionsCount = 0;
  private repairsAttemptedCount = 0;
  private repairsAppliedCount = 0;
  private schedulerQueueHighWaterMark = 0;
  private schedulerDroppedEvents = 0;
  private schedulerCoalescedEvents = 0;
  private schedulerLastEvaluationLatencyMs: number | null = null;
  private schedulerOverloadPeriodCount = 0;
  private submitAmbiguousCount = 0;
  private cancelAmbiguousCount = 0;
  private replaceAmbiguousCount = 0;
  private executionVerificationRequiredCount = 0;

  recordSubmitAmbiguous(): void {
    this.submitAmbiguousCount += 1;
  }

  recordCancelAmbiguous(): void {
    this.cancelAmbiguousCount += 1;
  }

  recordReplaceAmbiguous(): void {
    this.replaceAmbiguousCount += 1;
  }

  recordExecutionVerificationRequired(): void {
    this.executionVerificationRequiredCount += 1;
  }

  recordMarketUpdatesApplied(n: number): void {
    if (n > 0) this.marketUpdatesApplied += n;
  }

  recordEvent(event: RuntimeEvent): void {
    const type = event.type as string;
    safeIncr(this.eventsByType, type);

    switch (type) {
      case "bot.decision.evaluated": {
        const p = event.payload as { action?: string; reason?: string };
        const action = typeof p?.action === "string" ? p.action : "unknown";
        safeIncr(this.decisionTypesByAction, action);
        if (action === "NOOP" && typeof p?.reason === "string" && p.reason.trim()) {
          safeIncr(this.noopReasonsByCode, p.reason.trim());
        }
        break;
      }
      case "order.intent.created":
        break;
      case "order.partial_fill":
      case "order.filled":
        break;
      case "order.stale":
        break;
      case "risk.limit_hit":
        break;
      case "risk.kill_switch_changed":
        break;
      case "market.stale":
        break;
      case "market.recovered":
        break;
      default:
        break;
    }
  }

  recordReconciliationAction(kind: string): void {
    safeIncr(this.reconciliationActionsByKind, kind);
  }

  recordIntentBlockedByMode(mode: string): void {
    safeIncr(this.intentsBlockedByMode, mode);
  }

  recordIntentBlockedByGuardrails(): void {
    this.intentsBlockedByGuardrailsCount += 1;
  }

  private intentsBlockedByFreshnessCount = 0;
  private freshnessBlockReasonCounts: Record<string, number> = {};

  recordIntentBlockedByFreshness(reasonCodes: string[]): void {
    this.intentsBlockedByFreshnessCount += 1;
    for (const code of reasonCodes) {
      if (code) safeIncr(this.freshnessBlockReasonCounts, code, 1);
    }
  }

  recordReconcileFailure(reason: string, intentId?: string | null): void {
    this.reconcileFailureCount += 1;
    this.lastReconcileFailureAt = new Date();
    this.lastReconcileFailureReason = reason ?? null;
    this.lastReconcileFailureIntentId = intentId ?? null;
  }

  /**
   * Call when a runtime reconciliation tick completes successfully.
   * Resets failure streak so runtime safety / degraded logic reflect *current* health, not lifetime totals.
   */
  recordRuntimeReconciliationRun(): void {
    this.runtimeReconciliationRuns += 1;
    this.runtimeReconciliationFailures = 0;
    this.lastRuntimeReconciliationAt = new Date();
    this.lastRuntimeReconciliationStatus = "ok";
  }

  recordRuntimeReconciliationFailure(): void {
    this.runtimeReconciliationFailures += 1;
    this.lastRuntimeReconciliationAt = new Date();
    this.lastRuntimeReconciliationStatus = "failure";
  }

  recordDriftDetected(): void {
    this.driftDetectionsCount += 1;
  }

  recordRepairAttempted(count = 1): void {
    this.repairsAttemptedCount += count;
  }

  recordRepairApplied(count = 1): void {
    this.repairsAppliedCount += count;
  }

  recordSchedulerCoalesced(): void {
    this.schedulerCoalescedEvents += 1;
  }

  recordSchedulerDropped(): void {
    this.schedulerDroppedEvents += 1;
  }

  recordSchedulerEvaluationLatency(ms: number): void {
    this.schedulerLastEvaluationLatencyMs = ms;
  }

  recordSchedulerOverload(): void {
    this.schedulerOverloadPeriodCount += 1;
  }

  recordSchedulerHighWaterMark(mark: number): void {
    if (mark > this.schedulerQueueHighWaterMark) this.schedulerQueueHighWaterMark = mark;
  }

  recordPositionUpdate(): void {
    this.positionUpdatesCount += 1;
  }

  recordExposureUpdate(): void {
    this.exposureUpdatesCount += 1;
  }

  recordPartialFillApplied(): void {
    this.partialFillsApplied += 1;
  }

  recordFullFillApplied(): void {
    this.fullFillsApplied += 1;
  }

  getSnapshot(): RuntimeDiagnosticsSnapshot {
    const asOf = new Date().toISOString();
    const eventsByType = { ...this.eventsByType };
    const materialEventsEmitted = Object.values(eventsByType).reduce((a, b) => a + b, 0);
    const botEvaluations = eventsByType["bot.decision.evaluated"] ?? 0;
    const orderIntentsGenerated = eventsByType["order.intent.created"] ?? 0;
    const fillsHandled =
      (eventsByType["order.partial_fill"] ?? 0) + (eventsByType["order.filled"] ?? 0);
    const staleOrderDetections = eventsByType["order.stale"] ?? 0;
    const riskBlocks = eventsByType["risk.limit_hit"] ?? 0;
    const killSwitchChanges = eventsByType["risk.kill_switch_changed"] ?? 0;
    const degradedModeEntries = eventsByType["market.stale"] ?? 0;
    const degradedModeExits = eventsByType["market.recovered"] ?? 0;

    return {
      asOf,
      marketUpdatesApplied: this.marketUpdatesApplied,
      materialEventsEmitted,
      eventsByType,
      botEvaluations,
      decisionTypesByAction: { ...this.decisionTypesByAction },
      noopReasonsByCode: { ...this.noopReasonsByCode },
      orderIntentsGenerated,
      intentsBlockedByMode: { ...this.intentsBlockedByMode },
      intentsBlockedByGuardrails: this.intentsBlockedByGuardrailsCount,
      reconciliationActionsByKind: { ...this.reconciliationActionsByKind },
      fillsHandled,
      partialFillsApplied: this.partialFillsApplied,
      fullFillsApplied: this.fullFillsApplied,
      positionUpdates: this.positionUpdatesCount,
      exposureUpdates: this.exposureUpdatesCount,
      staleOrderDetections,
      riskBlocks,
      killSwitchChanges,
      degradedModeEntries,
      degradedModeExits,
      intentsBlockedByFreshness: this.intentsBlockedByFreshnessCount,
      freshnessBlockReasonCounts: { ...this.freshnessBlockReasonCounts },
      reconcileFailureCount: this.reconcileFailureCount,
      lastReconcileFailureAt: this.lastReconcileFailureAt?.toISOString() ?? null,
      lastReconcileFailureReason: this.lastReconcileFailureReason,
      lastReconcileFailureIntentId: this.lastReconcileFailureIntentId,
      runtimeReconciliationRuns: this.runtimeReconciliationRuns,
      runtimeReconciliationFailures: this.runtimeReconciliationFailures,
      lastRuntimeReconciliationAt: this.lastRuntimeReconciliationAt?.toISOString() ?? null,
      lastRuntimeReconciliationStatus: this.lastRuntimeReconciliationStatus,
      driftDetectionsCount: this.driftDetectionsCount,
      repairsAttemptedCount: this.repairsAttemptedCount,
      repairsAppliedCount: this.repairsAppliedCount,
      schedulerQueueHighWaterMark: this.schedulerQueueHighWaterMark,
      schedulerDroppedEvents: this.schedulerDroppedEvents,
      schedulerCoalescedEvents: this.schedulerCoalescedEvents,
      schedulerLastEvaluationLatencyMs: this.schedulerLastEvaluationLatencyMs,
      schedulerOverloadPeriodCount: this.schedulerOverloadPeriodCount,
      submitAmbiguousCount: this.submitAmbiguousCount,
      cancelAmbiguousCount: this.cancelAmbiguousCount,
      replaceAmbiguousCount: this.replaceAmbiguousCount,
      executionVerificationRequiredCount: this.executionVerificationRequiredCount,
    };
  }

  setLog(logFn: DiagnosticsLogFn | null): void {
    this.logFn = logFn;
  }

  /** Emit a structured log line if log callback is set. */
  log(level: DiagnosticsLogLevel, message: string, meta?: Record<string, unknown>): void {
    if (this.logFn) this.logFn(level, message, meta);
  }

  reset(): void {
    this.marketUpdatesApplied = 0;
    this.eventsByType = {};
    this.decisionTypesByAction = {};
    this.noopReasonsByCode = {};
    this.intentsBlockedByMode = {};
    this.intentsBlockedByGuardrailsCount = 0;
    this.intentsBlockedByFreshnessCount = 0;
    this.freshnessBlockReasonCounts = {};
    this.reconciliationActionsByKind = {};
    this.partialFillsApplied = 0;
    this.fullFillsApplied = 0;
    this.positionUpdatesCount = 0;
    this.exposureUpdatesCount = 0;
    this.reconcileFailureCount = 0;
    this.lastReconcileFailureAt = null;
    this.lastReconcileFailureReason = null;
    this.lastReconcileFailureIntentId = null;
    this.runtimeReconciliationRuns = 0;
    this.runtimeReconciliationFailures = 0;
    this.lastRuntimeReconciliationAt = null;
    this.lastRuntimeReconciliationStatus = null;
    this.driftDetectionsCount = 0;
    this.repairsAttemptedCount = 0;
    this.repairsAppliedCount = 0;
    this.schedulerQueueHighWaterMark = 0;
    this.schedulerDroppedEvents = 0;
    this.schedulerCoalescedEvents = 0;
    this.schedulerLastEvaluationLatencyMs = null;
    this.schedulerOverloadPeriodCount = 0;
    this.submitAmbiguousCount = 0;
    this.cancelAmbiguousCount = 0;
    this.replaceAmbiguousCount = 0;
    this.executionVerificationRequiredCount = 0;
  }
}
