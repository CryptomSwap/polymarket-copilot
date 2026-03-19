/**
 * Polymarket Data API: current positions as source of truth for open holdings.
 * GET https://data-api.polymarket.com/positions?user=<address>
 * Public endpoint; no auth required. Use for open quantity; keep trade-derived data for cost basis / PnL.
 */

const DATA_API_BASE = "https://data-api.polymarket.com";

export interface OfficialPosition {
  asset: string;
  conditionId?: string;
  size: number;
  avgPrice?: number;
  initialValue?: number;
  currentValue?: number;
  cashPnl?: number;
  percentPnl?: number;
  totalBought?: number;
  realizedPnl?: number;
  curPrice?: number;
  title?: string;
  slug?: string;
  outcome?: string;
  outcomeIndex?: number;
  endDate?: string;
  redeemable?: boolean;
  mergeable?: boolean;
  proxyWallet?: string;
  [key: string]: unknown;
}

export interface FetchOfficialPositionsResult {
  positions: OfficialPosition[];
  addressUsed: string;
  status: number;
  error: string | null;
}

/** Result of staleness check for open-set filtering. Exclude only when reason is non-null. */
export interface StaleResolvedCheck {
  exclude: boolean;
  reason: string | null;
}

const PAST_DATE_TITLE = /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})(?:,?\s*(\d{4}))?\b/i;
const MONTH_NAMES: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3, may: 4, jun: 5, june: 5,
  jul: 6, july: 6, aug: 7, august: 7, sep: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

function isTitlePastDated(title: string | null | undefined): boolean {
  if (!title || typeof title !== "string") return false;
  const m = title.match(PAST_DATE_TITLE);
  if (!m) return false;
  const monthStr = m[1].toLowerCase();
  const day = parseInt(m[2], 10);
  const year = m[3] != null ? parseInt(m[3], 10) : new Date().getFullYear();
  const month = MONTH_NAMES[monthStr];
  if (month == null || !Number.isFinite(day)) return false;
  const d = new Date(year, month, day);
  if (!Number.isFinite(d.getTime())) return false;
  return d.getTime() <= Date.now();
}

/**
 * Decide if an official position should be excluded from the open set as stale/resolved.
 * Uses multiple signals; excludes only when they agree to avoid dropping legitimate open markets.
 * - redeemable === true: single strong signal (market resolved, user can redeem).
 * - Zero value + missing/past-dated context: (curPrice == 0 and currentValue == 0) and (blank endDate or title indicates past date).
 */
export function isOfficialPositionStaleResolved(o: OfficialPosition): StaleResolvedCheck {
  if (o.redeemable === true) {
    return { exclude: true, reason: "redeemable" };
  }
  const curPrice = typeof o.curPrice === "number" && Number.isFinite(o.curPrice) ? o.curPrice : null;
  const currentValue = typeof o.currentValue === "number" && Number.isFinite(o.currentValue) ? o.currentValue : null;
  const zeroPrice = curPrice != null && curPrice === 0;
  const zeroValue = currentValue != null && currentValue === 0;
  if (!zeroPrice || !zeroValue) {
    return { exclude: false, reason: null };
  }
  const endDate = o.endDate != null ? String(o.endDate).trim() : "";
  const hasNoEndDate = endDate === "";
  const titlePastDated = isTitlePastDated(o.title);
  if (hasNoEndDate && titlePastDated) {
    return { exclude: true, reason: "zero_value_blank_endDate_past_dated_title" };
  }
  if (hasNoEndDate) {
    return { exclude: true, reason: "zero_value_blank_endDate" };
  }
  if (titlePastDated) {
    return { exclude: true, reason: "zero_value_past_dated_title" };
  }
  return { exclude: false, reason: null };
}

/**
 * Ensure address is 0x-prefixed for Data API (expects 0x + 40 hex).
 */
function toQueryAddress(funderAddress: string): string {
  const s = String(funderAddress ?? "").trim().toLowerCase();
  if (!s) return "";
  if (s.startsWith("0x")) return s.length === 42 ? s : s.slice(0, 42);
  return "0x" + s.slice(0, 40);
}

/**
 * Fetch current positions for a user from Polymarket Data API.
 * Paginates with limit 500 until no more results.
 */
export async function fetchOfficialPositions(funderAddress: string): Promise<FetchOfficialPositionsResult> {
  const addressUsed = toQueryAddress(funderAddress);
  if (!addressUsed || addressUsed.length < 42) {
    return { positions: [], addressUsed: funderAddress, status: 0, error: "Invalid or missing user address" };
  }

  const all: OfficialPosition[] = [];
  let offset = 0;
  const limit = 500;
  let status = 0;
  let error: string | null = null;

  try {
    for (;;) {
      const params = new URLSearchParams({ user: addressUsed, limit: String(limit), offset: String(offset) });
      const url = `${DATA_API_BASE}/positions?${params.toString()}`;
      const res = await fetch(url, {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      status = res.status;
      if (!res.ok) {
        const body = await res.text();
        error = `Data API error ${res.status}: ${body.slice(0, 200)}`;
        break;
      }
      const data = await res.json();
      const page = Array.isArray(data) ? data : [];
      for (const row of page) {
        if (row && typeof row === "object" && typeof row.asset === "string") {
          const num = (v: unknown): number | undefined => {
            if (v == null) return undefined;
            if (typeof v === "number" && Number.isFinite(v)) return v;
            const n = parseFloat(String(v).trim());
            return Number.isFinite(n) ? n : undefined;
          };
          const curPrice = num(row.curPrice);
          const currentValue = num(row.currentValue);
          all.push({
            ...row,
            asset: String(row.asset).trim(),
            conditionId: row.conditionId,
            size: typeof row.size === "number" ? row.size : parseFloat(String(row.size)) || 0,
            avgPrice: num(row.avgPrice),
            initialValue: num(row.initialValue),
            currentValue,
            cashPnl: num(row.cashPnl),
            percentPnl: num(row.percentPnl),
            totalBought: num(row.totalBought),
            realizedPnl: num(row.realizedPnl),
            curPrice,
            title: row.title,
            slug: row.slug,
            outcome: row.outcome,
            outcomeIndex: row.outcomeIndex,
            endDate: row.endDate,
            redeemable: row.redeemable,
            mergeable: row.mergeable,
            proxyWallet: row.proxyWallet,
          });
        }
      }
      if (page.length < limit) break;
      offset += limit;
      if (offset >= 10000) break;
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return { positions: all, addressUsed, status: status || 200, error };
}

/**
 * Normalized basis/PnL from an official position when values exist and pass binary-contract sanity.
 * Used so portfolio merge can prefer official basis over derived when the API provides it.
 */
export interface OfficialBasisSnapshot {
  costBasis: number;
  avgEntry: number;
  unrealizedPnl: number;
  /** currentValue from API if present, else size * curPrice */
  currentValue: number;
}

/**
 * Extract basis and PnL from an official position if present and sane for binary contracts.
 * Sanity: 0 <= avgEntry <= 1, 0 <= costBasis <= size (plus small tolerance).
 * Returns null if official has no usable basis (missing or invalid).
 */
export function getOfficialBasisIfSane(o: OfficialPosition): OfficialBasisSnapshot | null {
  const size = typeof o.size === "number" && Number.isFinite(o.size) ? o.size : 0;
  if (size <= 0) return null;

  const initialValue = typeof o.initialValue === "number" && Number.isFinite(o.initialValue) ? o.initialValue : null;
  const avgPrice = typeof o.avgPrice === "number" && Number.isFinite(o.avgPrice) ? o.avgPrice : null;
  const currentValue =
    typeof o.currentValue === "number" && Number.isFinite(o.currentValue)
      ? o.currentValue
      : (typeof o.curPrice === "number" && Number.isFinite(o.curPrice) ? size * o.curPrice : null);
  const cashPnl = typeof o.cashPnl === "number" && Number.isFinite(o.cashPnl) ? o.cashPnl : null;

  let costBasis: number;
  let avgEntry: number;

  if (initialValue != null && initialValue >= 0 && initialValue <= size * 1.0001) {
    costBasis = initialValue;
    avgEntry = initialValue / size;
  } else if (avgPrice != null && avgPrice >= 0 && avgPrice <= 1.0001) {
    avgEntry = avgPrice;
    costBasis = size * avgEntry;
  } else {
    return null;
  }

  const maxCostBasis = size * 1.0001;
  if (costBasis < 0 || costBasis > maxCostBasis || avgEntry < 0 || avgEntry > 1.0001) return null;

  const effectiveCurrentValue = currentValue != null ? currentValue : (o.curPrice != null && Number.isFinite(o.curPrice) ? size * o.curPrice : costBasis);
  const unrealizedPnl =
    cashPnl != null ? cashPnl : (effectiveCurrentValue - costBasis);

  return {
    costBasis,
    avgEntry,
    unrealizedPnl,
    currentValue: effectiveCurrentValue,
  };
}

/**
 * Map official positions by asset id (token id) for lookup.
 * Stores both raw and lowercase key so lookup is case-insensitive.
 */
export function officialPositionsByAsset(positions: OfficialPosition[]): Map<string, OfficialPosition> {
  const map = new Map<string, OfficialPosition>();
  for (const p of positions) {
    const key = String(p.asset ?? "").trim();
    if (!key) continue;
    map.set(key, p);
    const low = key.toLowerCase();
    if (low !== key) map.set(low, p);
  }
  return map;
}
