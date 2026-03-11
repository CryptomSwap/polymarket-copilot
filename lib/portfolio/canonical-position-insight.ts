/**
 * Canonical position insight: pure, reusable per-position signals for UI and intelligence.
 * Consumes timing + quality (e.g. from CanonicalPositionView) and returns derived flags.
 * No side effects; safe to use from API routes and dashboard.
 */

// --- Input: minimal shape (compatible with CanonicalPositionTiming + CanonicalPositionQuality) ---

export interface CanonicalPositionInsightTimingInput {
  hoursToResolution?: number | null;
  lastSyncedAt?: string | Date | null;
}

export interface CanonicalPositionInsightQualityInput {
  hasFullMarketMetadata?: boolean;
  hasPriceContext?: boolean;
  warnings?: string[];
}

export interface ComputeCanonicalPositionInsightOptions {
  /** Hours until resolution to consider "near resolution". Default 72. */
  nearResolutionHours?: number;
  /** Hours since last sync to consider "stale". Default 24. */
  staleSyncHours?: number;
}

// --- Output ---

export interface CanonicalPositionInsight {
  nearResolution: boolean;
  staleSync: boolean;
  unresolvedCatalog: boolean;
  hasPriceContext: boolean;
  warnings: string[];
}

// --- Default thresholds (shared by UI and intelligence) ---

export const DEFAULT_NEAR_RESOLUTION_HOURS = 72;
export const DEFAULT_STALE_SYNC_HOURS = 24;

// --- Pure computation ---

function lastSyncedAtToMs(lastSyncedAt: string | Date | null | undefined): number {
  if (lastSyncedAt == null) return 0;
  try {
    const t = typeof lastSyncedAt === "string" ? new Date(lastSyncedAt).getTime() : lastSyncedAt.getTime();
    return Number.isFinite(t) ? t : 0;
  } catch {
    return 0;
  }
}

/**
 * Compute per-position insight signals from canonical timing and quality.
 * Pure function: same inputs + options => same output. Safe for API and UI.
 */
export function computeCanonicalPositionInsight(
  timing: CanonicalPositionInsightTimingInput | null | undefined,
  quality: CanonicalPositionInsightQualityInput | null | undefined,
  options?: ComputeCanonicalPositionInsightOptions
): CanonicalPositionInsight {
  const nearResolutionHours = options?.nearResolutionHours ?? DEFAULT_NEAR_RESOLUTION_HOURS;
  const staleSyncHours = options?.staleSyncHours ?? DEFAULT_STALE_SYNC_HOURS;

  const hoursToResolution = timing?.hoursToResolution ?? null;
  const lastSyncedAt = timing?.lastSyncedAt ?? null;

  const nearResolution =
    hoursToResolution != null &&
    Number.isFinite(hoursToResolution) &&
    hoursToResolution <= nearResolutionHours;

  const lastSyncMs = lastSyncedAtToMs(lastSyncedAt);
  const staleSync =
    lastSyncMs > 0 &&
    Date.now() - lastSyncMs > staleSyncHours * 60 * 60 * 1000;

  const unresolvedCatalog = !(quality?.hasFullMarketMetadata ?? false);
  const hasPriceContext = quality?.hasPriceContext ?? false;
  const warnings = Array.isArray(quality?.warnings) ? [...quality.warnings] : [];

  return {
    nearResolution,
    staleSync,
    unresolvedCatalog,
    hasPriceContext,
    warnings,
  };
}
