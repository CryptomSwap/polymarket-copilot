/**
 * Shared canonical position view model and UI display helper.
 * Single boundary for position display logic; used by portfolio, market detail, and any position consumer.
 * Prevents drift in unresolved/resolved fallback logic across pages.
 */

import {
  DEFAULT_NEAR_RESOLUTION_HOURS,
  DEFAULT_STALE_SYNC_HOURS,
} from "@/lib/portfolio/canonical-position-insight";

// --- Shared canonical position view model (flat, API + UI boundary) ---

export interface PositionView {
  /** Canonical SyncedMarket.id when resolved; null if unresolved. */
  syncedMarketId: string | null;
  /** Raw upstream market ref (CLOB/condition id from fills); null if unknown. */
  rawMarketRef: string | null;
  assetId: string;
  /** From catalog when resolved; null otherwise. */
  marketSlug: string | null;
  /** Display title (from catalog or raw). */
  marketTitle: string | null;
  category: string | null;
  theme: string | null;
  /** How position was resolved: marketId | conditionId | assetId | unresolved. */
  resolutionSource: "marketId" | "conditionId" | "assetId" | "unresolved";
  isResolved: boolean;
  isStale: boolean;
  isNearResolution: boolean;
  endDate: string | null;
  lastSyncedAt: string | null;
  /** Existing position metrics (for consumers that need them). */
  size?: string;
  avgEntry?: string;
  marketValue?: string;
  unrealizedPnl?: string;
  realizedPnl?: string;
  outcome?: string;
  side?: string;
}

// --- UI display state (derived from PositionView) ---

export interface PositionDisplayState {
  displayTitle: string;
  displaySubtitle: string;
  canLinkToMarket: boolean;
  href: string;
  badges: {
    unresolved: boolean;
    stale: boolean;
    soon: boolean;
  };
}

function strOrEmpty(s: string | null | undefined): string {
  if (s == null) return "";
  const t = String(s).trim();
  return t;
}

function lastSyncedAtToMs(lastSyncedAt: string | null | undefined): number {
  if (lastSyncedAt == null) return 0;
  try {
    const t = typeof lastSyncedAt === "string" ? new Date(lastSyncedAt).getTime() : (lastSyncedAt as Date).getTime();
    return Number.isFinite(t) ? t : 0;
  } catch {
    return 0;
  }
}

/**
 * Derives UI-safe display state from a canonical position view.
 * Single source of truth for title, subtitle, link, and unresolved/stale/soon badges.
 */
export function getPositionDisplayState(
  position: PositionView,
  options?: {
    nearResolutionHours?: number;
    staleSyncHours?: number;
  }
): PositionDisplayState {
  const nearResolutionHours = options?.nearResolutionHours ?? DEFAULT_NEAR_RESOLUTION_HOURS;
  const staleSyncHours = options?.staleSyncHours ?? DEFAULT_STALE_SYNC_HOURS;

  const title = strOrEmpty(position.marketTitle) || "Unknown market";
  const slug = strOrEmpty(position.marketSlug);
  const canLink = position.resolutionSource !== "unresolved" && slug.length > 0;
  const href = canLink ? `/markets/${encodeURIComponent(slug)}` : "";

  const subtitleParts: string[] = [];
  if (position.resolutionSource === "unresolved") {
    subtitleParts.push("Market not yet resolved in catalog");
  } else {
    const catTheme = [position.category, position.theme].filter(Boolean).join(" · ");
    if (catTheme) subtitleParts.push(catTheme);
  }
  const displaySubtitle = subtitleParts.length > 0 ? subtitleParts.join(" · ") : "—";

  const lastSyncMs = lastSyncedAtToMs(position.lastSyncedAt);
  const stale = position.lastSyncedAt != null && Date.now() - lastSyncMs > staleSyncHours * 60 * 60 * 1000;

  return {
    displayTitle: title,
    displaySubtitle,
    canLinkToMarket: canLink,
    href,
    badges: {
      unresolved: position.resolutionSource === "unresolved",
      stale: position.isStale ?? stale,
      soon: position.isNearResolution ?? false,
    },
  };
}

// --- Build PositionView from canonical API response shape ---

export interface CanonicalPositionApiShape {
  id?: string;
  market?: {
    id?: string | null;
    slug?: string | null;
    title?: string | null;
    category?: string | null;
    theme?: string | null;
    endDate?: string | null;
  };
  token?: { assetId?: string; outcome?: string; side?: string };
  economics?: {
    quantity?: string;
    avgEntry?: string;
    markPrice?: string;
    exposure?: string;
    currentValue?: string;
    costBasis?: string;
    maxPayout?: string;
    unrealizedPnl?: string;
    realizedPnl?: string;
  };
  timing?: {
    hoursToResolution?: number | null;
    lastSyncedAt?: string | null;
  };
  quality?: {
    isResolved?: boolean;
    matchedBy?: "marketId" | "conditionId" | "assetId" | null;
    hasFullMarketMetadata?: boolean;
  };
  syncedMarketId?: string | null;
  rawMarketRef?: string | null;
  resolutionSource?: string;
}

/**
 * Maps the canonical positions API response item (nested) to the flat PositionView.
 * Use when consuming GET /api/portfolio/positions?canonical=true.
 */
export function toPositionViewFromCanonical(
  item: CanonicalPositionApiShape,
  options?: {
    nearResolutionHours?: number;
    staleSyncHours?: number;
  }
): PositionView {
  const market = item.market ?? {};
  const token = item.token ?? {};
  const economics = item.economics ?? {};
  const timing = item.timing ?? {};
  const quality = item.quality ?? {};

  const syncedMarketId = item.syncedMarketId ?? market.id ?? null;
  const rawMarketRef = item.rawMarketRef ?? null;
  const resolutionSource = (item.resolutionSource ?? quality.matchedBy ?? "unresolved") as PositionView["resolutionSource"];
  const hasFull = quality.hasFullMarketMetadata ?? quality.matchedBy != null;
  const effectiveSource: PositionView["resolutionSource"] =
    resolutionSource === "marketId" || resolutionSource === "conditionId" || resolutionSource === "assetId"
      ? resolutionSource
      : hasFull
        ? "marketId"
        : "unresolved";

  const hoursToRes = timing.hoursToResolution ?? null;
  const nearResolutionHours = options?.nearResolutionHours ?? DEFAULT_NEAR_RESOLUTION_HOURS;
  const staleSyncHours = options?.staleSyncHours ?? DEFAULT_STALE_SYNC_HOURS;
  const isNearResolution =
    hoursToRes != null && Number.isFinite(hoursToRes) && hoursToRes <= nearResolutionHours;
  const lastSyncMs = lastSyncedAtToMs(timing.lastSyncedAt);
  const isStale =
    timing.lastSyncedAt != null &&
    Date.now() - lastSyncMs > staleSyncHours * 60 * 60 * 1000;

  return {
    syncedMarketId: strOrEmpty(syncedMarketId) || null,
    rawMarketRef: strOrEmpty(rawMarketRef) || null,
    assetId: strOrEmpty(token.assetId) || "",
    marketSlug: strOrEmpty(market.slug) || null,
    marketTitle: strOrEmpty(market.title) || null,
    category: strOrEmpty(market.category) || null,
    theme: strOrEmpty(market.theme) || null,
    resolutionSource: effectiveSource,
    isResolved: quality.isResolved ?? false,
    isStale,
    isNearResolution,
    endDate: market.endDate ?? null,
    lastSyncedAt: timing.lastSyncedAt ?? null,
    size: economics.quantity,
    avgEntry: economics.avgEntry,
    marketValue: economics.currentValue ?? economics.exposure,
    unrealizedPnl: economics.unrealizedPnl,
    realizedPnl: economics.realizedPnl,
    outcome: token.outcome,
    side: token.side,
  };
}
