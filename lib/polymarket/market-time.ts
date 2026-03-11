/**
 * Market time-to-resolution helpers. Uses existing SyncedMarket.endDate.
 */

export interface MarketWithEndDate {
  id: string;
  endDate: Date | null;
}

/**
 * Time from now to market resolution in hours. Null if no endDate.
 */
export function getTimeToResolutionHours(market: MarketWithEndDate): number | null {
  if (!market.endDate) return null;
  const now = Date.now();
  const end = new Date(market.endDate).getTime();
  if (end <= now) return 0;
  return (end - now) / (60 * 60 * 1000);
}

/**
 * Batch: map market id -> time to resolution in hours.
 */
export function getTimeToResolutionHoursByMarkets(
  markets: MarketWithEndDate[]
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const m of markets) {
    out[m.id] = getTimeToResolutionHours(m);
  }
  return out;
}
