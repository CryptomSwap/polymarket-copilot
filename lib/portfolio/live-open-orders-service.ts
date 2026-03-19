/**
 * Live open-orders service: fetch current open/working orders from Polymarket CLOB (L2)
 * with optional short-lived cache and explicit fetch metadata for orderSourceOfTruth / ordersAsOf / ordersFreshnessMs.
 * Aligned with live-portfolio-service (positions). Server-side only.
 */

import { getStoredCredentials } from "@/lib/polymarket/auth";
import { fetchOpenOrdersL2Raw, type L2Creds } from "@/lib/polymarket/l2-readonly";
import { openOrderSchema } from "@/types/polymarket";

/** Default 10s for portfolio UX; use setLiveOpenOrdersCacheTtlMs() to override. */
const DEFAULT_ORDERS_CACHE_TTL_MS = 10_000; // 10s

// ---------------------------------------------------------------------------
// Normalized live order shape (provenance from official CLOB)
// ---------------------------------------------------------------------------

export interface LiveOpenOrder {
  orderId: string;
  marketId: string;
  assetId: string;
  side: string;
  outcome: string | null;
  size: string;
  remainingSize: string;
  price: string;
  status: string;
  createdAt: number | null;
  /** Always "official" when from this service. */
  rowSource: "official";
}

export interface OfficialOrdersFetchMetadata {
  success: boolean;
  status: number;
  error: string | null;
  asOf: Date;
  freshnessMs: number;
  fromCache: boolean;
}

export interface LiveOfficialOpenOrdersResult {
  orders: LiveOpenOrder[];
  metadata: OfficialOrdersFetchMetadata;
}

interface OrdersCacheEntry {
  orders: LiveOpenOrder[];
  asOf: Date;
}

const ordersCache = new Map<string, OrdersCacheEntry>();
let ordersCacheTtlMs = DEFAULT_ORDERS_CACHE_TTL_MS;

export function setLiveOpenOrdersCacheTtlMs(ms: number): void {
  ordersCacheTtlMs = Math.max(0, ms);
}

export function clearLiveOpenOrdersCache(): void {
  ordersCache.clear();
}

function ordersCacheKey(funderAddress: string): string {
  return String(funderAddress ?? "").trim().toLowerCase();
}

function parseNum(s: string | null | undefined): number {
  if (s == null || s === "") return 0;
  const n = parseFloat(String(s).trim());
  return Number.isFinite(n) ? n : 0;
}

function normalizeOrder(raw: unknown): LiveOpenOrder | null {
  const parsed = openOrderSchema.safeParse(raw);
  if (!parsed.success) return null;
  const d = parsed.data;
  const orig = parseNum(d.original_size);
  const matched = parseNum(d.size_matched);
  const remaining = Math.max(0, orig - matched);
  return {
    orderId: d.id,
    marketId: d.market,
    assetId: d.asset_id,
    side: d.side,
    outcome: d.outcome ?? null,
    size: d.original_size,
    remainingSize: String(remaining),
    price: d.price,
    status: d.status,
    createdAt: d.created_at ?? null,
    rowSource: "official",
  };
}

/**
 * Fetch official open orders for the given funder. Uses stored L2 credentials;
 * if no credentials or funder does not match the credential's funder, returns
 * failure metadata and empty list. Uses short-lived in-memory cache when TTL > 0.
 */
export async function getLiveOfficialOpenOrders(
  funderAddress: string
): Promise<LiveOfficialOpenOrdersResult> {
  const key = ordersCacheKey(funderAddress);
  const now = new Date();
  const nowMs = now.getTime();

  if (ordersCacheTtlMs > 0 && key) {
    const hit = ordersCache.get(key);
    if (hit) {
      const age = nowMs - hit.asOf.getTime();
      if (age <= ordersCacheTtlMs) {
        return {
          orders: hit.orders,
          metadata: {
            success: true,
            status: 200,
            error: null,
            asOf: hit.asOf,
            freshnessMs: age,
            fromCache: true,
          },
        };
      }
    }
  }

  const { credential: creds } = await getStoredCredentials();
  if (!creds) {
    const meta: OfficialOrdersFetchMetadata = {
      success: false,
      status: 0,
      error: "No stored credentials",
      asOf: now,
      freshnessMs: 0,
      fromCache: false,
    };
    return { orders: [], metadata: meta };
  }

  const credFunder = (creds.funderAddress ?? "").trim().toLowerCase();
  const requestedFunder = (funderAddress ?? "").trim().toLowerCase();
  if (credFunder && requestedFunder && credFunder !== requestedFunder) {
    const meta: OfficialOrdersFetchMetadata = {
      success: false,
      status: 0,
      error: "Funder does not match credential; cannot fetch orders",
      asOf: now,
      freshnessMs: 0,
      fromCache: false,
    };
    return { orders: [], metadata: meta };
  }

  const l2Creds: L2Creds = {
    apiKey: creds.apiKey,
    secret: creds.secret,
    passphrase: creds.passphrase,
    funderAddress: creds.funderAddress,
    polyAddress: creds.polyAddress,
  };

  const { status, data: rawList, error } = await fetchOpenOrdersL2Raw(l2Creds);
  const asOf = new Date();
  const success = status >= 200 && status < 300 && error == null;
  const orders: LiveOpenOrder[] = [];
  for (const row of Array.isArray(rawList) ? rawList : []) {
    const o = normalizeOrder(row);
    if (o) orders.push(o);
  }

  if (ordersCacheTtlMs > 0 && key && success) {
    ordersCache.set(key, { orders, asOf });
  }

  return {
    orders,
    metadata: {
      success,
      status,
      error: error ?? null,
      asOf,
      freshnessMs: 0,
      fromCache: false,
    },
  };
}

/**
 * Determine orderSourceOfTruth from fetch metadata.
 */
export function getOrderSourceOfTruth(metadata: OfficialOrdersFetchMetadata): "official" | "derived" {
  return metadata.success ? "official" : "derived";
}

// ---------------------------------------------------------------------------
// Orders reconciliation diagnostics (official vs local DB)
// ---------------------------------------------------------------------------

export interface LocalOpenOrderRow {
  orderId: string;
  marketId: string;
  assetId: string;
  side: string;
  status: string;
  sizeMatched: string;
  originalSize: string;
  price: string;
}

export interface OrdersReconciliationDiagnostics {
  officialOpenOrdersCount: number;
  localOpenOrdersCount: number;
  countDelta: number;
  ordersMissingLocally: string[];
  ordersMissingOfficially: string[];
  mismatchedStatuses: Array<{ orderId: string; officialStatus: string; localStatus: string }>;
  sampleDiffs: Array<{
    orderId: string;
    source: "missing_locally" | "missing_officially" | "status_mismatch";
    official?: Partial<LiveOpenOrder>;
    local?: Partial<LocalOpenOrderRow>;
    message: string;
  }>;
  asOf: string;
  officialFetchSuccess: boolean;
}

const MAX_SAMPLE_DIFFS = 10;
const MAX_MISSING_IDS = 50;

/**
 * Compare official (live) open orders with local DB (UserOrder) representation.
 * Diagnostics only; no auto-repair.
 */
export function getOrdersReconciliationDiagnostics(
  officialOrders: LiveOpenOrder[],
  localOrders: LocalOpenOrderRow[],
  officialFetchSuccess: boolean,
  asOf: Date
): OrdersReconciliationDiagnostics {
  const officialIds = new Set(officialOrders.map((o) => o.orderId));
  const localById = new Map(localOrders.map((o) => [o.orderId, o]));
  const officialById = new Map(officialOrders.map((o) => [o.orderId, o]));

  const ordersMissingLocally: string[] = [];
  const ordersMissingOfficially: string[] = [];
  const mismatchedStatuses: OrdersReconciliationDiagnostics["mismatchedStatuses"] = [];
  const sampleDiffs: OrdersReconciliationDiagnostics["sampleDiffs"] = [];

  for (const id of officialIds) {
    if (!localById.has(id)) {
      ordersMissingLocally.push(id);
      if (sampleDiffs.filter((d) => d.source === "missing_locally").length < 5) {
        const o = officialById.get(id);
        sampleDiffs.push({
          orderId: id,
          source: "missing_locally",
          official: o
            ? {
                orderId: o.orderId,
                marketId: o.marketId,
                assetId: o.assetId,
                side: o.side,
                status: o.status,
                size: o.size,
                remainingSize: o.remainingSize,
                price: o.price,
              }
            : undefined,
          message: "Order on exchange but not in local UserOrder table",
        });
      }
    }
  }

  for (const loc of localOrders) {
    if (!officialIds.has(loc.orderId)) {
      ordersMissingOfficially.push(loc.orderId);
      if (sampleDiffs.filter((d) => d.source === "missing_officially").length < 5) {
        sampleDiffs.push({
          orderId: loc.orderId,
          source: "missing_officially",
          local: {
            orderId: loc.orderId,
            marketId: loc.marketId,
            assetId: loc.assetId,
            side: loc.side,
            status: loc.status,
            originalSize: loc.originalSize,
            sizeMatched: loc.sizeMatched,
            price: loc.price,
          },
          message: "Order in local UserOrder table but not on exchange",
        });
      }
    } else {
      const off = officialById.get(loc.orderId);
      if (off && off.status !== loc.status) {
        mismatchedStatuses.push({
          orderId: loc.orderId,
          officialStatus: off.status,
          localStatus: loc.status,
        });
        if (sampleDiffs.filter((d) => d.source === "status_mismatch").length < 5) {
          sampleDiffs.push({
            orderId: loc.orderId,
            source: "status_mismatch",
            official: { status: off.status },
            local: { status: loc.status },
            message: `Status mismatch: official=${off.status} local=${loc.status}`,
          });
        }
      }
    }
  }

  const countDelta = officialOrders.length - localOrders.length;
  return {
    officialOpenOrdersCount: officialOrders.length,
    localOpenOrdersCount: localOrders.length,
    countDelta,
    ordersMissingLocally: ordersMissingLocally.slice(0, MAX_MISSING_IDS),
    ordersMissingOfficially: ordersMissingOfficially.slice(0, MAX_MISSING_IDS),
    mismatchedStatuses,
    sampleDiffs: sampleDiffs.slice(0, MAX_SAMPLE_DIFFS),
    asOf: asOf.toISOString(),
    officialFetchSuccess,
  };
}
