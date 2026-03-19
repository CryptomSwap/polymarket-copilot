/**
 * Stream Watchdog thresholds: single config for data freshness, degraded, and kill-switch.
 * Used by StreamRuntime watchdog to avoid false-green (heartbeat alive but no real data).
 */

export interface StreamWatchdogConfig {
  /** Market: warn when no real data for this long (ms). */
  marketDataWarnThresholdMs: number;
  /** Market: mark stream degraded when no real data for this long (ms). */
  marketDataDegradedThresholdMs: number;
  /** Market: trigger kill switch when no real data for this long (ms). 0 = disabled. */
  marketDataKillSwitchThresholdMs: number;
  /** User: mark stream degraded when no real data for this long (ms). */
  userDataDegradedThresholdMs: number;
  /** User: trigger kill switch when no real data for this long AND working orders exist (ms). 0 = disabled. */
  userDataKillSwitchWithOrdersThresholdMs: number;
  /** Reconnect churn: consider churning when reconnect attempts in last window exceed this. */
  reconnectChurnAttemptsThreshold: number;
  /** Reconnect churn: time window (ms) for counting reconnect attempts. */
  reconnectChurnWindowMs: number;
  /** How often the watchdog runs (ms). */
  watchdogIntervalMs: number;
}

export const DEFAULT_STREAM_WATCHDOG_CONFIG: StreamWatchdogConfig = {
  marketDataWarnThresholdMs: 30_000,
  marketDataDegradedThresholdMs: 60_000,
  marketDataKillSwitchThresholdMs: 180_000,
  userDataDegradedThresholdMs: 90_000,
  userDataKillSwitchWithOrdersThresholdMs: 120_000,
  reconnectChurnAttemptsThreshold: 5,
  reconnectChurnWindowMs: 120_000,
  watchdogIntervalMs: 15_000,
};
