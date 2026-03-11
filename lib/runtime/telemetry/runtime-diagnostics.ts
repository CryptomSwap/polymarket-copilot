/**
 * Runtime diagnostics: counters and optional structured logging for observability.
 * Used by health/debug endpoints and ops; must not block the hot path.
 */

import type { RuntimeEvent } from "../events/runtime-events";

export type DiagnosticsLogLevel = "info" | "warn" | "error";
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
  /** Order intents generated (order.intent.created). */
  orderIntentsGenerated: number;
  /** Intents blocked by runtime mode (observe_only, disabled, live). Key = mode. */
  intentsBlockedByMode: Record<string, number>;
  /** Intents blocked by guardrails (risk/limit). */
  intentsBlockedByGuardrails: number;
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
}

const ZERO_SNAPSHOT = (): RuntimeDiagnosticsSnapshot => ({
  asOf: new Date().toISOString(),
  marketUpdatesApplied: 0,
  materialEventsEmitted: 0,
  eventsByType: {},
  botEvaluations: 0,
  decisionTypesByAction: {},
  orderIntentsGenerated: 0,
  intentsBlockedByMode: {},
  intentsBlockedByGuardrails: 0,
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
  /** Record a reconcileIntents failure (unhandled rejection or throw). */
  recordReconcileFailure(reason: string, intentId?: string | null): void;
  /** Record a position store update (applyFill). */
  recordPositionUpdate(): void;
  /** Record an exposure update. */
  recordExposureUpdate(): void;
  /** Record a partial fill applied to positions. */
  recordPartialFillApplied(): void;
  /** Record a full fill applied to positions. */
  recordFullFillApplied(): void;
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

  recordMarketUpdatesApplied(n: number): void {
    if (n > 0) this.marketUpdatesApplied += n;
  }

  recordEvent(event: RuntimeEvent): void {
    const type = event.type as string;
    safeIncr(this.eventsByType, type);

    switch (type) {
      case "bot.decision.evaluated": {
        const p = event.payload as { action?: string };
        const action = typeof p?.action === "string" ? p.action : "unknown";
        safeIncr(this.decisionTypesByAction, action);
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

  recordReconcileFailure(reason: string, intentId?: string | null): void {
    this.reconcileFailureCount += 1;
    this.lastReconcileFailureAt = new Date();
    this.lastReconcileFailureReason = reason ?? null;
    this.lastReconcileFailureIntentId = intentId ?? null;
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
      reconcileFailureCount: this.reconcileFailureCount,
      lastReconcileFailureAt: this.lastReconcileFailureAt?.toISOString() ?? null,
      lastReconcileFailureReason: this.lastReconcileFailureReason,
      lastReconcileFailureIntentId: this.lastReconcileFailureIntentId,
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
    this.intentsBlockedByMode = {};
    this.intentsBlockedByGuardrailsCount = 0;
    this.reconciliationActionsByKind = {};
    this.partialFillsApplied = 0;
    this.fullFillsApplied = 0;
    this.positionUpdatesCount = 0;
    this.exposureUpdatesCount = 0;
    this.reconcileFailureCount = 0;
    this.lastReconcileFailureAt = null;
    this.lastReconcileFailureReason = null;
    this.lastReconcileFailureIntentId = null;
  }
}
