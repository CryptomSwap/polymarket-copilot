import type { RuntimeEventBus } from "../events/runtime-event-bus";
import { createRuntimeEventId } from "../events/runtime-events";
import type { RiskKillSwitchChangedEvent } from "../events/runtime-events";
import type { RuntimeRiskState } from "./runtime-risk-engine";

/**
 * Runtime kill switch: circuit breaker to halt automation globally or per-asset.
 * Order Manager and guardrails should check before submitting orders.
 * Emits risk.kill_switch_changed when global state changes.
 */

export interface KillSwitchState {
  /** Global stop: no automated orders when true. */
  globalEnabled: boolean;
  /** Reason for global stop (e.g. "manual", "connectivity_lost"). */
  globalReason: string | null;
  /** When global was last turned on (stop). */
  globalTriggeredAt: Date | null;
  /** Asset IDs currently halted (no new orders on these). */
  haltedAssetIds: string[];
}

export interface KillSwitch {
  getState(): KillSwitchState;
  /** True if global stop is active. */
  isGlobalStopped(): boolean;
  /** True if the given asset is halted. */
  isAssetHalted(assetId: string): boolean;
  /** Turn global stop on. */
  setGlobalStop(reason?: string): void;
  /** Turn global stop off. */
  clearGlobalStop(): void;
  /** Halt trading for one asset. */
  setAssetHalted(assetId: string): void;
  /** Allow trading for one asset again. */
  clearAssetHalted(assetId: string): void;
  /** Apply current kill switch state into a RuntimeRiskState (for engine sync). */
  applyToRiskState(state: RuntimeRiskState): RuntimeRiskState;
  /**
   * Optional: evaluate and auto-trigger from risk/health (e.g. connectivity loss).
   * Does not replace manual controls.
   */
  evaluate(riskState: RuntimeRiskState): void;
}

const EVENT_SOURCE = "risk_engine" as const;

function emitKillSwitchChanged(
  eventBus: RuntimeEventBus | undefined,
  enabled: boolean,
  reason: string | null
): void {
  if (!eventBus) return;
  const event: RiskKillSwitchChangedEvent = {
    id: createRuntimeEventId(),
    type: "risk.kill_switch_changed",
    source: EVENT_SOURCE,
    occurredAt: new Date(),
    payload: {
      enabled,
      reason,
      changedAt: new Date(),
    },
  };
  eventBus.publish(event);
}

/**
 * In-memory kill switch with optional event bus for risk.kill_switch_changed.
 */
export class InMemoryKillSwitch implements KillSwitch {
  private state: KillSwitchState = {
    globalEnabled: false,
    globalReason: null,
    globalTriggeredAt: null,
    haltedAssetIds: [],
  };
  private readonly eventBus: RuntimeEventBus | undefined;

  constructor(options?: { eventBus?: RuntimeEventBus }) {
    this.eventBus = options?.eventBus;
  }

  getState(): KillSwitchState {
    return {
      ...this.state,
      haltedAssetIds: [...this.state.haltedAssetIds],
    };
  }

  isGlobalStopped(): boolean {
    return this.state.globalEnabled;
  }

  isAssetHalted(assetId: string): boolean {
    return this.state.haltedAssetIds.includes(assetId.trim());
  }

  setGlobalStop(reason?: string): void {
    if (this.state.globalEnabled) return;
    this.state.globalEnabled = true;
    this.state.globalReason = reason ?? "manual";
    this.state.globalTriggeredAt = new Date();
    emitKillSwitchChanged(this.eventBus, true, this.state.globalReason);
  }

  clearGlobalStop(): void {
    if (!this.state.globalEnabled) return;
    this.state.globalEnabled = false;
    const prevReason = this.state.globalReason;
    this.state.globalReason = null;
    this.state.globalTriggeredAt = null;
    emitKillSwitchChanged(this.eventBus, false, prevReason);
  }

  setAssetHalted(assetId: string): void {
    const id = assetId.trim();
    if (!id || this.state.haltedAssetIds.includes(id)) return;
    this.state.haltedAssetIds = [...this.state.haltedAssetIds, id];
  }

  clearAssetHalted(assetId: string): void {
    const id = assetId.trim();
    this.state.haltedAssetIds = this.state.haltedAssetIds.filter((a) => a !== id);
  }

  applyToRiskState(state: RuntimeRiskState): RuntimeRiskState {
    return {
      ...state,
      globalAutomationEnabled: state.globalAutomationEnabled && !this.state.globalEnabled,
      haltedAssetIds: [...this.state.haltedAssetIds],
      evaluatedAt: new Date(state.evaluatedAt.getTime()),
    };
  }

  evaluate(riskState: RuntimeRiskState): void {
    if (riskState.exchangeHealth === "unhealthy" && !this.state.globalEnabled) {
      this.setGlobalStop("exchange_unhealthy");
    }
  }
}
