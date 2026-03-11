/**
 * Execution-focused telemetry metrics, separate from user-facing analytics.
 */

export interface ExecutionMetricsSnapshot {
  asOf: Date;
  /** Count of open runtime orders across all funders. */
  openOrderCount: number;
  /** Count of positions currently tracked in memory. */
  positionCount: number;
  /** Last time an order was submitted. */
  lastOrderSubmittedAt: Date | null;
  /** Last time an order fill was observed. */
  lastFillAt: Date | null;
}

export interface ExecutionMetricsCollector {
  getSnapshot(): ExecutionMetricsSnapshot;
}

