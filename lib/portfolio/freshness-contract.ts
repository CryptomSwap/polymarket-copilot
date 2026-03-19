/**
 * Canonical freshness contract for portfolio APIs and UI.
 * Single semantics so routes and UI do not conflate fresh / cached / unknown.
 *
 * Contract:
 * - freshnessMs = 0       => fresh fetch (just fetched)
 * - freshnessMs > 0       => cached (age in ms at response time)
 * - freshnessMs = null    => unknown / unavailable
 *
 * freshnessState is derived from freshnessMs only; no magic null-as-fresh.
 */

export type FreshnessState = "fresh" | "cached" | "unknown";

/**
 * Derive canonical freshness state from freshnessMs.
 * Do not treat null as fresh — null means unknown.
 */
export function getFreshnessState(freshnessMs: number | null | undefined): FreshnessState {
  if (freshnessMs == null) return "unknown";
  if (freshnessMs === 0) return "fresh";
  return "cached";
}

/**
 * Normalize metadata for API response: use 0 for fresh (not null).
 * Call this when you have fromCache + raw freshnessMs from the live service.
 */
export function normalizeFreshnessForApi(
  fromCache: boolean,
  freshnessMsFromService: number
): { freshnessMs: number | null; freshnessState: FreshnessState } {
  const freshnessMs = fromCache ? freshnessMsFromService : 0;
  return { freshnessMs, freshnessState: getFreshnessState(freshnessMs) };
}

/**
 * When we have no fetch metadata (e.g. derived-only path), use null and unknown.
 */
export function unknownFreshness(): { freshnessMs: null; freshnessState: FreshnessState } {
  return { freshnessMs: null, freshnessState: "unknown" };
}
