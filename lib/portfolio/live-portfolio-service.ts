/**
 * Live portfolio service: fetch official positions with optional short-lived cache
 * and explicit fetch metadata for sourceOfTruth / asOf / freshnessMs.
 * See docs/LIVE_TRUTH_ARCHITECTURE.md.
 */

import {
  fetchOfficialPositions,
  type FetchOfficialPositionsResult,
} from "@/lib/polymarket/official-positions";

/** Default 0 so official curPrice/currentValue are always fresh; use setLivePortfolioCacheTtlMs() to override. */
const DEFAULT_CACHE_TTL_MS = 0;

export interface OfficialPositionsFetchMetadata {
  /** True when the HTTP/API call succeeded and we have a result (possibly empty). */
  success: boolean;
  /** HTTP status from the API, or 0 if network error. */
  status: number;
  /** Error message when success is false. */
  error: string | null;
  /** When we received the response (or when we gave up). */
  asOf: Date;
  /** Age in ms of the data at fetch time (0 for fresh fetch). */
  freshnessMs: number;
  /** True when result was served from cache. */
  fromCache: boolean;
}

export interface LiveOfficialPositionsResult {
  /** Raw result from fetch (positions, addressUsed, status, error). */
  result: FetchOfficialPositionsResult;
  /** Metadata for response contract (sourceOfTruth, asOf, freshnessMs). */
  metadata: OfficialPositionsFetchMetadata;
}

interface CacheEntry {
  result: FetchOfficialPositionsResult;
  asOf: Date;
}

const cache = new Map<string, CacheEntry>();
let cacheTtlMs = DEFAULT_CACHE_TTL_MS;

/**
 * Set cache TTL in ms. 0 disables cache.
 */
export function setLivePortfolioCacheTtlMs(ms: number): void {
  cacheTtlMs = Math.max(0, ms);
}

/**
 * Clear the in-memory cache (e.g. for tests).
 */
export function clearLivePortfolioCache(): void {
  cache.clear();
}

function cacheKey(funderAddress: string): string {
  return String(funderAddress ?? "").trim().toLowerCase();
}

/**
 * Fetch official positions with optional short-lived cache.
 * Returns result plus metadata so callers can set sourceOfTruth, asOf, freshnessMs
 * and know when official fetch failed (fallback to derived).
 */
export async function getLiveOfficialPositions(
  funderAddress: string
): Promise<LiveOfficialPositionsResult> {
  const key = cacheKey(funderAddress);
  const now = new Date();
  const nowMs = now.getTime();

  if (cacheTtlMs > 0 && key) {
    const hit = cache.get(key);
    if (hit) {
      const age = nowMs - hit.asOf.getTime();
      if (age <= cacheTtlMs) {
        return {
          result: hit.result,
          metadata: {
            success: hit.result.error == null && hit.result.status >= 200 && hit.result.status < 300,
            status: hit.result.status,
            error: hit.result.error,
            asOf: hit.asOf,
            freshnessMs: age,
            fromCache: true,
          },
        };
      }
    }
  }

  const result = await fetchOfficialPositions(funderAddress);
  const asOf = new Date();
  const success = result.error == null && result.status >= 200 && result.status < 300;

  if (cacheTtlMs > 0 && key) {
    cache.set(key, { result, asOf });
  }

  return {
    result,
    metadata: {
      success,
      status: result.status,
      error: result.error,
      asOf,
      freshnessMs: 0,
      fromCache: false,
    },
  };
}

/**
 * Determine response-level sourceOfTruth from fetch metadata and whether we have official positions.
 */
export function getSourceOfTruth(
  metadata: OfficialPositionsFetchMetadata,
  officialPositionsCount: number
): "official" | "derived" | "mixed_fallback" {
  if (!metadata.success) return "derived";
  if (officialPositionsCount > 0) return "official";
  return "official"; // empty open set is still "official" (Polymarket says no positions)
}
