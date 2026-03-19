/**
 * Stream Watchdog: evaluates data freshness, reconnect churn, and suggests degraded/kill-switch.
 * Does not mutate kill switch; caller applies result.
 */

import type { StreamConnectionState } from "./stream-connection-state";
import type { StreamWatchdogConfig } from "./stream-watchdog-config";

export interface StreamWatchdogInputs {
  marketConnection: StreamConnectionState | null;
  userConnection: StreamConnectionState | null;
  trackedAssetCount: number;
  openOrderCount: number;
  config: StreamWatchdogConfig;
  /** When set and recent, counts as user data freshness (avoids false kill-switch when WS is silent but user_sync REST succeeded). */
  lastSuccessfulUserTruthFetchAt?: Date | null;
}

export interface StreamWatchdogResult {
  reasons: string[];
  degraded: boolean;
  /** Caller should call killSwitch.setGlobalStop when true. */
  triggerKillSwitch: boolean;
  killSwitchReason: string | null;
}

export function evaluateStreamWatchdog(inputs: StreamWatchdogInputs): StreamWatchdogResult {
  const { marketConnection, userConnection, trackedAssetCount, openOrderCount, config, lastSuccessfulUserTruthFetchAt } = inputs;
  const reasons: string[] = [];
  let triggerKillSwitch = false;
  let killSwitchReason: string | null = null;
  const now = Date.now();

  const marketOpen = marketConnection?.status === "open";
  const userOpen = userConnection?.status === "open";

  const marketDataAt = marketConnection?.lastDataEventAt ?? null;
  const userDataAt = userConnection?.lastDataEventAt ?? null;
  const userTruthAt = lastSuccessfulUserTruthFetchAt ?? null;
  const userTruthFresh =
    userTruthAt != null && now - userTruthAt.getTime() <= config.userDataDegradedThresholdMs;
  const effectiveUserDataAt =
    userDataAt ?? (userTruthFresh ? userTruthAt : null);
  const marketHeartbeatAt = marketConnection?.lastHeartbeatAt ?? null;
  const userHeartbeatAt = userConnection?.lastHeartbeatAt ?? null;

  // Market data silence
  if (marketOpen && trackedAssetCount > 0) {
    if (!marketDataAt) {
      reasons.push("market_data_silence");
      if (config.marketDataKillSwitchThresholdMs > 0) {
        triggerKillSwitch = true;
        killSwitchReason = "market_data_silence";
      }
    } else {
      const age = now - marketDataAt.getTime();
      if (age > config.marketDataWarnThresholdMs) {
        reasons.push("market_data_warn");
      }
      if (age > config.marketDataDegradedThresholdMs) {
        reasons.push("market_data_stale");
      }
      if (config.marketDataKillSwitchThresholdMs > 0 && age > config.marketDataKillSwitchThresholdMs) {
        reasons.push("market_data_kill_switch");
        triggerKillSwitch = true;
        killSwitchReason = killSwitchReason ?? "market_data_silence_severe";
      }
    }
  }

  // User data silence: WS lastDataEventAt or recent successful user_sync (REST orders/trades fetch) counts as fresh
  if (userOpen) {
    if (!effectiveUserDataAt) {
      if (openOrderCount > 0) {
        reasons.push("user_data_silence_with_orders");
        if (config.userDataKillSwitchWithOrdersThresholdMs > 0) {
          triggerKillSwitch = true;
          killSwitchReason = killSwitchReason ?? "user_data_silence_with_working_orders";
        }
      }
    } else {
      const age = now - effectiveUserDataAt.getTime();
      if (age > config.userDataDegradedThresholdMs) {
        reasons.push("user_data_stale");
      }
      if (openOrderCount > 0 && config.userDataKillSwitchWithOrdersThresholdMs > 0 && age > config.userDataKillSwitchWithOrdersThresholdMs) {
        reasons.push("user_data_kill_switch_with_orders");
        triggerKillSwitch = true;
        killSwitchReason = killSwitchReason ?? "user_data_silence_with_working_orders";
      }
    }
  }

  // Reconnect churn
  const marketAttempts = marketConnection?.reconnectAttempts ?? 0;
  const userAttempts = userConnection?.reconnectAttempts ?? 0;
  if (marketAttempts >= config.reconnectChurnAttemptsThreshold || userAttempts >= config.reconnectChurnAttemptsThreshold) {
    reasons.push("reconnect_churn");
  }

  const degraded = reasons.length > 0;
  let watchdogState: "ok" | "degraded" | "kill_switch" = "ok";
  if (triggerKillSwitch) watchdogState = "kill_switch";
  else if (degraded) watchdogState = "degraded";

  return {
    reasons,
    degraded,
    triggerKillSwitch,
    killSwitchReason,
  };
}

/**
 * Derive reported watchdog state: only "kill_switch" when both the watchdog previously triggered
 * and the kill switch is still active. After clear, report "degraded" or "ok" from current reasons.
 */
export function deriveWatchdogState(
  lastWatchdogKillSwitchTriggered: boolean,
  killSwitchActive: boolean,
  watchdogReasonsLength: number
): "ok" | "degraded" | "kill_switch" {
  return lastWatchdogKillSwitchTriggered && killSwitchActive
    ? "kill_switch"
    : watchdogReasonsLength > 0
      ? "degraded"
      : "ok";
}
