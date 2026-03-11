/**
 * Alert Engine v1 types. Deterministic, threshold-based portfolio and recommendation alerts.
 */

export const COPILOT_ALERT_TYPES = [
  "CONCENTRATION_BREACH",
  "NEW_ADD_OPPORTUNITY",
  "NEAR_RESOLUTION_REVIEW",
  "HELD_MARKET_SIGNAL_FLIP",
  "DATA_HEALTH",
] as const;

export type CopilotAlertType = (typeof COPILOT_ALERT_TYPES)[number];

export const COPILOT_ALERT_SEVERITIES = ["info", "warning", "critical"] as const;

export type CopilotAlertSeverity = (typeof COPILOT_ALERT_SEVERITIES)[number];

export interface CopilotAlertPayload {
  type: CopilotAlertType;
  severity: CopilotAlertSeverity;
  title: string;
  message: string;
  marketId?: string | null;
  recommendationId?: string | null;
  assetId?: string | null;
  metadata?: Record<string, unknown> | null;
  /** Stable key for dedupe: same (funder, type, dedupeKey) => do not create duplicate. */
  dedupeKey: string;
}

export interface CopilotAlertRow {
  id: string;
  funderAddress: string;
  type: string;
  severity: string;
  title: string;
  message: string;
  marketId: string | null;
  recommendationId: string | null;
  assetId: string | null;
  metadata: Record<string, unknown> | null;
  isRead: boolean;
  dedupeKey: string;
  createdAt: Date;
  updatedAt: Date;
}
