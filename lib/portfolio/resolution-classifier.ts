/**
 * Canonical unresolved-position semantics for portfolio.
 * Single source of truth for classification and counts; used by intelligence, positions route, and diagnostics.
 *
 * Canonical definition:
 * - Unresolved position = no canonical synced market resolution (position was not matched to a SyncedMarket
 *   by marketId, conditionId, or assetId). Equivalently: quality.isResolved === false, or quality.matchedBy == null.
 * - Resolved position = linked to a canonical market record (matchedBy !== null).
 *
 * All summary/diagnostic unresolved counts MUST be derived from the same classification (view.quality.isResolved)
 * to avoid drift between intelligence summary, intelligence diagnostics, and positions diagnostics.
 */

import type { CanonicalPositionQuality, ResolutionSource } from "./canonical-position-view";

/** Canonical reason when a position is unresolved (no synced market match). */
export const UNRESOLVED_REASON = "No canonical synced market resolution" as const;

/** Minimal quality shape for classification (e.g. from view.quality or API payload). */
export interface ResolutionQualityLike {
  isResolved?: boolean;
  matchedBy?: "marketId" | "conditionId" | "assetId" | null;
  resolutionSource?: ResolutionSource | string | null;
}

/**
 * Classify a single position as resolved or unresolved using canonical semantics.
 * Unresolved = not linked to a canonical synced market (matchedBy == null).
 */
export function isPositionUnresolved(quality: ResolutionQualityLike | null | undefined): boolean {
  if (quality == null) return true;
  return !(quality.isResolved === true);
}

/**
 * Get canonical resolution source from quality. Use for counts and UI.
 */
export function getResolutionSource(quality: ResolutionQualityLike | null | undefined): ResolutionSource {
  if (quality?.resolutionSource === "marketId" || quality?.resolutionSource === "conditionId" || quality?.resolutionSource === "assetId") {
    return quality.resolutionSource;
  }
  if (quality?.matchedBy != null) return quality.matchedBy;
  return "unresolved";
}

/**
 * Canonical unresolved and resolved counts from an array of position quality objects.
 * Use this everywhere we need summary/diagnostic counts so they stay aligned.
 */
export function getResolutionCounts(
  qualities: (ResolutionQualityLike | null | undefined)[]
): { unresolvedCount: number; resolvedCount: number; total: number } {
  const total = qualities.length;
  const unresolvedCount = qualities.filter((q) => isPositionUnresolved(q)).length;
  const resolvedCount = total - unresolvedCount;
  return { unresolvedCount, resolvedCount, total };
}
