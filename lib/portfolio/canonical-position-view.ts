/**
 * Canonical enriched position view: stable shape for backend-to-UI consumption.
 * Centralizes market enrichment, economics, timing, and data quality signals.
 * Reuses resolution/enrichment from portfolio and intelligence; no duplicate mapping logic.
 */

function hoursToEnd(endDate: Date | null | undefined): number | null {
  if (!endDate) return null;
  const end = new Date(endDate).getTime();
  const now = Date.now();
  if (end <= now) return null;
  return (end - now) / (1000 * 60 * 60);
}

// --- Input types (what we get from existing flows) ---

/** Raw position row (DerivedPosition or equivalent). */
export interface PositionRowInput {
  funderAddress: string;
  marketId: string;
  assetId: string;
  marketTitle: string;
  outcome: string;
  side: string;
  size: string;
  /** Null when basis is unavailable (do not use "0" for unknown). */
  avgEntry: string | null;
  lastPrice: string;
  /** Null when basis is unavailable. */
  costBasis: string | null;
  marketValue: string;
  /** Null when basis is unavailable (do not leak stale derived PnL). */
  unrealizedPnl: string | null;
  realizedPnl: string;
  reservedOrderSize?: string;
  reservedOrderValue?: string;
  category: string | null;
  theme: string | null;
  openedAt: Date | null;
}

/** Enrichment from batch resolution (id, slug, endDate, matchedBy, optional conditionId/status). */
export interface PositionEnrichmentInput {
  marketId: string;
  marketTitle: string;
  marketSlug: string | null;
  category: string | null;
  theme: string | null;
  endDate: string | Date | null;
  matchedBy: "marketId" | "conditionId" | "assetId" | null;
  /** When available from SyncedMarket (e.g. extended enrichment). */
  conditionId?: string | null;
  /** When available from SyncedMarket. */
  status?: string | null;
}

/** Optional timing: lastFillAt and lastSyncedAt are not on DerivedPosition; callers can pass if known. */
export interface PositionTimingInput {
  firstFillAt?: Date | null;
  lastFillAt?: Date | null;
  lastSyncedAt?: Date | null;
}

// --- Canonical view model (output) ---

export interface CanonicalPositionMarket {
  id: string | null;
  conditionId: string | null;
  slug: string | null;
  title: string;
  category: string | null;
  theme: string | null;
  endDate: string | null;
  status: string | null;
}

export interface CanonicalPositionToken {
  assetId: string;
  outcome: string;
  side: string;
}

export interface CanonicalPositionEconomics {
  quantity: string;
  /** Null when basis is unavailable. */
  avgEntry: string | null;
  markPrice: string;
  /** @deprecated Use currentValue. Kept for backward compatibility. */
  exposure: string;
  /** Current mark-to-market value = quantity * markPrice (Polymarket wallet "Value"). */
  currentValue: string;
  /** Null when basis is unavailable. */
  costBasis: string | null;
  /** Max payout if outcome wins = quantity * 1.00 (Polymarket wallet "To win"). */
  maxPayout: string;
  /** Null when basis is unavailable. */
  unrealizedPnl: string | null;
  realizedPnl: string;
}

export interface CanonicalPositionTiming {
  firstFillAt: string | null;
  lastFillAt: string | null;
  hoursToResolution: number | null;
  lastSyncedAt: string | null;
}

/** Canonical resolution source: how the position was linked to a synced market, or "unresolved". */
export type ResolutionSource = "marketId" | "conditionId" | "assetId" | "unresolved";

/**
 * Quality semantics:
 * - isResolved: true when the position is linked to a canonical market record (matchedBy != null).
 * - resolutionSource: matchedBy ?? "unresolved" — single field for API/UI.
 * - unresolvedReason: set when !isResolved; canonical reason string for diagnostics/UI.
 * - hasCompleteDisplayMetadata (isCatalogComplete): true only when all required display fields present.
 * - marketEndDatePassed: true when the market's end date is in the past (for "Resolved" time display).
 *
 * Completeness criteria (all required for hasCompleteDisplayMetadata):
 * - canonical market id (non-empty, from resolved enrichment)
 * - title (non-empty)
 * - slug (non-empty)
 * - category (non-empty)
 * - theme (non-empty)
 * - endDate (non-null)
 */
export interface CanonicalPositionQuality {
  /** True when position is linked to a canonical market record (matchedBy != null). */
  isResolved: boolean;
  matchedBy: "marketId" | "conditionId" | "assetId" | null;
  /** Canonical: matchedBy ?? "unresolved". Use this for counts and UI. */
  resolutionSource: ResolutionSource;
  /** When !isResolved, canonical reason (e.g. "No canonical synced market resolution"). */
  unresolvedReason: string | null;
  /** True only when all required display fields are present (id, title, slug, category, theme, endDate). Alias: isCatalogComplete. */
  hasCompleteDisplayMetadata: boolean;
  /** True when the market's end date is in the past. Use for "Resolved" in time-to-resolution display. */
  marketEndDatePassed: boolean;
  hasPriceContext: boolean;
  warnings: string[];
}

export interface CanonicalPositionView {
  market: CanonicalPositionMarket;
  token: CanonicalPositionToken;
  economics: CanonicalPositionEconomics;
  timing: CanonicalPositionTiming;
  quality: CanonicalPositionQuality;
  /** Stable composite id for UI (funder-assetId). */
  id: string;
}

// --- Helpers: explicit missing, no misleading defaults ---

function numOrNull(s: string | null | undefined): number | null {
  if (s == null || s === "") return null;
  const n = parseFloat(String(s).trim());
  return Number.isFinite(n) ? n : null;
}

function strOrNull(s: string | null | undefined): string | null {
  if (s == null) return null;
  const t = String(s).trim();
  return t === "" ? null : t;
}

function dateToIso(d: Date | string | null | undefined): string | null {
  if (d == null) return null;
  if (typeof d === "string") return d;
  try {
    const t = d.getTime();
    return Number.isFinite(t) ? d.toISOString() : null;
  } catch {
    return null;
  }
}

/**
 * Build the canonical position view from a position row and its enrichment.
 * Missing or partial data is explicit (null); no silent misleading defaults.
 */
export function buildCanonicalPositionView(
  position: PositionRowInput,
  enrichment: PositionEnrichmentInput,
  timing?: PositionTimingInput
): CanonicalPositionView {
  const endDate = enrichment.endDate
    ? typeof enrichment.endDate === "string"
      ? enrichment.endDate
      : enrichment.endDate.toISOString()
    : null;
  const endDateAsDate = endDate ? new Date(endDate) : null;
  const hoursToRes = hoursToEnd(endDateAsDate);

  const hasPriceContext =
    numOrNull(position.lastPrice) != null ||
    (position.avgEntry != null && position.avgEntry !== "" && numOrNull(position.avgEntry) != null);
  /** Linked to a canonical market record. */
  const isResolved = enrichment.matchedBy != null;
  /** Market end date is in the past. */
  const marketEndDatePassed =
    endDateAsDate != null && Number.isFinite(endDateAsDate.getTime()) && endDateAsDate.getTime() <= Date.now();

  const hasCanonicalId = isResolved && strOrNull(enrichment.marketId) != null && String(enrichment.marketId).trim() !== "";
  const hasTitle = (enrichment.marketTitle != null && String(enrichment.marketTitle).trim() !== "") || (position.marketTitle != null && position.marketTitle.trim() !== "");
  const hasSlug = strOrNull(enrichment.marketSlug) != null && String(enrichment.marketSlug).trim() !== "";
  const hasCategory = strOrNull(enrichment.category ?? position.category) != null && String(enrichment.category ?? position.category ?? "").trim() !== "";
  const hasTheme = strOrNull(enrichment.theme ?? position.theme) != null && String(enrichment.theme ?? position.theme ?? "").trim() !== "";
  const hasEndDate = endDate != null && endDate.trim() !== "";
  const hasCompleteDisplayMetadata =
    !!hasCanonicalId && !!hasTitle && !!hasSlug && !!hasCategory && !!hasTheme && !!hasEndDate;

  const warnings: string[] = [];
  if (!isResolved) warnings.push("Market not resolved to catalog; link to market detail unavailable.");
  else {
    if (!hasSlug) warnings.push("Market slug missing.");
    if (!hasCategory) warnings.push("Category missing.");
    if (!hasTheme) warnings.push("Theme missing.");
    if (!hasEndDate) warnings.push("End date missing.");
  }
  if (!hasPriceContext) warnings.push("No price context (lastPrice/avgEntry).");
  if (numOrNull(position.size) === 0) warnings.push("Position size is zero.");

  return {
    id: `${position.funderAddress}-${position.assetId}`,
    market: {
      id: strOrNull(enrichment.matchedBy != null ? enrichment.marketId : null) ?? null,
      conditionId: strOrNull(enrichment.conditionId ?? null) ?? null,
      slug: strOrNull(enrichment.marketSlug) ?? null,
      title: (enrichment.matchedBy != null && enrichment.marketTitle ? String(enrichment.marketTitle).trim() : null) || position.marketTitle?.trim() || "Unknown market",
      category: strOrNull(enrichment.category ?? position.category) ?? null,
      theme: strOrNull(enrichment.theme ?? position.theme) ?? null,
      endDate,
      status: strOrNull(enrichment.status ?? null) ?? null,
    },
    token: {
      assetId: position.assetId,
      outcome: position.outcome,
      side: position.side,
    },
    economics: {
      quantity: position.size,
      avgEntry: strOrNull(position.avgEntry),
      markPrice: position.lastPrice,
      exposure: position.marketValue,
      currentValue: position.marketValue,
      costBasis: strOrNull(position.costBasis),
      maxPayout: String(Math.abs(parseFloat(position.size) || 0)),
      unrealizedPnl: strOrNull(position.unrealizedPnl),
      realizedPnl: position.realizedPnl,
    },
    timing: {
      firstFillAt: dateToIso(timing?.firstFillAt ?? position.openedAt) ?? null,
      lastFillAt: dateToIso(timing?.lastFillAt) ?? null,
      hoursToResolution: hoursToRes,
      lastSyncedAt: dateToIso(timing?.lastSyncedAt) ?? null,
    },
    quality: {
      isResolved,
      matchedBy: enrichment.matchedBy,
      resolutionSource: (enrichment.matchedBy ?? "unresolved") as ResolutionSource,
      unresolvedReason: isResolved ? null : "No canonical synced market resolution",
      hasCompleteDisplayMetadata,
      marketEndDatePassed,
      hasPriceContext,
      warnings,
    },
  };
}
