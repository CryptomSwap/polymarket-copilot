/**
 * Alert Engine v1 types. Deterministic, threshold-based portfolio and recommendation alerts.
 * Feed types: unified alert feed (drift + engine) for UI consumption.
 */

// --- Alert feed (merged drift + engine for GET /api/alerts/feed) ---

export type AlertFeedSource = "drift" | "engine";

export const ALERT_FEED_SEVERITIES = ["info", "warning", "critical"] as const;
export type AlertFeedSeverity = (typeof ALERT_FEED_SEVERITIES)[number];

/** Feed alert type: drift uses DriftAlert.alertType; engine uses IntelligenceFlagCode. */
export type AlertFeedType =
  | string
  | "HIGH_CONCENTRATION"
  | "NEAR_RESOLUTION_CLUSTER"
  | "STALE_SYNC_CLUSTER"
  | "UNRESOLVED_CATALOG_POSITIONS"
  | "LARGE_LOSS"
  | "LARGE_GAIN";

export interface AlertFeedItem {
  id: string;
  type: AlertFeedType;
  severity: AlertFeedSeverity;
  title: string;
  message: string;
  source: AlertFeedSource;
  /** When source is "drift", present. Used for resolve API. */
  driftAlertId?: string | null;
  entityRefs?: {
    assetId?: string | null;
    marketId?: string | null;
    polymarketOrderId?: string | null;
  };
  createdAt: string;
  asOf?: string;
}

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
