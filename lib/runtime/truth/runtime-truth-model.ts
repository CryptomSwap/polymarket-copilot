/**
 * Runtime Truth Model – Exchange-authoritative hierarchy of truth
 *
 * Hierarchy (highest to lowest):
 * 1. Exchange authoritative pull state (REST snapshots: open orders, recent fills)
 * 2. Durable local journals / ledgers (fill ledger, order journal)
 * 3. Runtime in-memory state (order store, position store)
 * 4. Websocket event flow – low-latency transport only, NOT sole truth
 *
 * Concepts:
 * - Open orders: truth = exchange GET /data/orders snapshot; WS acks/fills are transport.
 * - Fills: truth = exchange GET /data/trades (and durable fill ledger for replay).
 * - Runtime positions: derived from fills + ledger; reconciled against exchange/ledger.
 * - Exposure: derived from positions + open orders; gated by exchange truth freshness.
 * - Stream freshness: WS lastDataEventAt is transport health, not sufficient for execution correctness.
 * - Reconciliation state: comparison of exchange snapshot vs runtime vs ledger; drift triggers repair recommendations.
 *
 * Order admission is blocked when:
 * - Exchange truth is stale beyond threshold.
 * - Exchange truth unavailable while working orders exist.
 * - Runtime cannot verify current order state safely.
 * No auto-repair when truth is uncertain (paper-safe).
 */

import type { RuntimeOrderState } from "../order-manager/order-manager";
import type { RuntimePositionState } from "../positions/runtime-position-store";
import type { ExchangeOpenOrder } from "../reconciliation/runtime-reconciliation-types";

// ---------------------------------------------------------------------------
// Snapshots (typed, timestamped)
// ---------------------------------------------------------------------------

/** Normalized open order from exchange; stable internal shape. */
export interface NormalizedExchangeOpenOrder {
  id: string;
  market: string;
  asset_id: string;
  side: string;
  original_size: string;
  size_matched: string;
  price: string;
  status: string;
}

/** Snapshot of open orders from exchange (authoritative pull). */
export interface ExchangeOpenOrdersSnapshot {
  orders: NormalizedExchangeOpenOrder[];
  fetchedAt: Date;
  source: "exchange_pull";
  fetchDiagnostics?: {
    attempts: number;
    perAttemptTimeoutMs?: number;
    lastErrorType?: "timeout" | "aborted" | "auth" | "fetch_error" | "unknown";
  } | null;
}

/** Normalized fill/trade from exchange (recent trades API). */
export interface NormalizedExchangeFill {
  id: string;
  market: string;
  asset_id: string;
  side: string;
  size: string;
  price: string;
  match_time?: string;
  outcome?: string;
}

/** Snapshot of recent fills from exchange (authoritative pull). */
export interface ExchangeRecentFillsSnapshot {
  fills: NormalizedExchangeFill[];
  fetchedAt: Date;
  source: "exchange_pull";
  fetchDiagnostics?: {
    attempts: number;
    perAttemptTimeoutMs?: number;
    lastErrorType?: "timeout" | "aborted" | "auth" | "fetch_error" | "unknown";
  } | null;
}

/** Snapshot of runtime order state (in-memory store). */
export interface RuntimeOrderStateSnapshot {
  orders: RuntimeOrderState[];
  at: Date;
  source: "runtime_memory";
}

/** Snapshot of runtime position state (in-memory store). */
export interface RuntimePositionStateSnapshot {
  positions: RuntimePositionState[];
  at: Date;
  source: "runtime_memory";
}

/** Result of comparing exchange snapshot vs runtime vs ledger. */
export interface RuntimeTruthComparisonResult {
  exchangeOrdersSnapshotAt: Date | null;
  exchangeFillsSnapshotAt: Date | null;
  runtimeOrdersAt: Date | null;
  runtimePositionsAt: Date | null;
  /** Exchange order IDs missing in runtime. */
  missingLocalOrderIds: string[];
  /** Runtime working orders whose exchange ID not on exchange. */
  missingExchangeOrderIds: string[];
  /** Fill drift: local filledSize vs exchange size_matched. */
  fillDriftCount: number;
  driftDetected: boolean;
  comparedAt: Date;
}

// ---------------------------------------------------------------------------
// Truth freshness and stale reasons
// ---------------------------------------------------------------------------

/** Degraded reason codes when exchange truth is stale or unavailable. */
export const EXCHANGE_TRUTH_STALE_REASONS = {
  EXCHANGE_TRUTH_STALE: "exchange_truth_stale",
  EXCHANGE_TRUTH_UNAVAILABLE: "exchange_truth_unavailable",
  EXCHANGE_TRUTH_ORDERS_STALE: "exchange_truth_orders_stale",
  EXCHANGE_TRUTH_FILLS_STALE: "exchange_truth_fills_stale",
} as const;

export type ExchangeTruthStaleReason =
  (typeof EXCHANGE_TRUTH_STALE_REASONS)[keyof typeof EXCHANGE_TRUTH_STALE_REASONS];

/** Which subsystem's truth source is used (authoritative vs runtime vs unknown). */
export type TruthSourceKind = "exchange_pull" | "runtime_memory" | "durable_ledger" | "unknown";

export interface TruthSourceBySubsystem {
  orders: TruthSourceKind;
  fills: TruthSourceKind;
  positions: TruthSourceKind;
  exposure: TruthSourceKind;
}

/** Truth freshness state: timestamps and health. */
export interface TruthFreshnessState {
  lastExchangeOrdersSnapshotAt: Date | null;
  lastExchangeFillsSnapshotAt: Date | null;
  exchangeTruthHealthy: boolean;
  exchangeTruthStaleReasonCodes: ExchangeTruthStaleReason[];
}

/** Status summary for health/operator. */
export interface TruthModelStatus {
  exchangeTruthHealthy: boolean;
  lastExchangeOrdersSnapshotAt: string | null;
  lastExchangeFillsSnapshotAt: string | null;
  truthSourceBySubsystem: TruthSourceBySubsystem;
  staleReasonCodes: ExchangeTruthStaleReason[];
}

// ---------------------------------------------------------------------------
// Defaults and thresholds
// ---------------------------------------------------------------------------

/** Max age (ms) of orders snapshot to consider exchange orders truth "fresh". */
export const DEFAULT_ORDERS_TRUTH_STALE_MS = 120_000; // 2 min

/** Max age (ms) of fills snapshot to consider exchange fills truth "fresh". */
export const DEFAULT_FILLS_TRUTH_STALE_MS = 180_000; // 3 min

// ---------------------------------------------------------------------------
// Computations
// ---------------------------------------------------------------------------

/**
 * Compute exchange truth health and stale reason codes from last snapshot timestamps.
 * When credentials are missing or pull failed, pass null timestamps and optional error.
 */
export function computeExchangeTruthFreshness(params: {
  lastExchangeOrdersSnapshotAt: Date | null;
  lastExchangeFillsSnapshotAt: Date | null;
  ordersStaleThresholdMs?: number;
  fillsStaleThresholdMs?: number;
  /** If true, treat as unavailable (e.g. no credentials or fetch error). */
  exchangeTruthUnavailable?: boolean;
}): TruthFreshnessState {
  const ordersStaleMs = params.ordersStaleThresholdMs ?? DEFAULT_ORDERS_TRUTH_STALE_MS;
  const fillsStaleMs = params.fillsStaleThresholdMs ?? DEFAULT_FILLS_TRUTH_STALE_MS;
  const now = Date.now();
  const reasons: ExchangeTruthStaleReason[] = [];

  if (params.exchangeTruthUnavailable) {
    reasons.push(EXCHANGE_TRUTH_STALE_REASONS.EXCHANGE_TRUTH_UNAVAILABLE);
    return {
      lastExchangeOrdersSnapshotAt: params.lastExchangeOrdersSnapshotAt,
      lastExchangeFillsSnapshotAt: params.lastExchangeFillsSnapshotAt,
      exchangeTruthHealthy: false,
      exchangeTruthStaleReasonCodes: reasons,
    };
  }

  const ordersAge = params.lastExchangeOrdersSnapshotAt
    ? now - params.lastExchangeOrdersSnapshotAt.getTime()
    : Infinity;
  const fillsAge = params.lastExchangeFillsSnapshotAt
    ? now - params.lastExchangeFillsSnapshotAt.getTime()
    : Infinity;

  if (ordersAge > ordersStaleMs) {
    reasons.push(EXCHANGE_TRUTH_STALE_REASONS.EXCHANGE_TRUTH_ORDERS_STALE);
  }
  if (fillsAge > fillsStaleMs) {
    reasons.push(EXCHANGE_TRUTH_STALE_REASONS.EXCHANGE_TRUTH_FILLS_STALE);
  }
  if (reasons.length > 0) {
    reasons.push(EXCHANGE_TRUTH_STALE_REASONS.EXCHANGE_TRUTH_STALE);
  }

  return {
    lastExchangeOrdersSnapshotAt: params.lastExchangeOrdersSnapshotAt,
    lastExchangeFillsSnapshotAt: params.lastExchangeFillsSnapshotAt,
    exchangeTruthHealthy: reasons.length === 0,
    exchangeTruthStaleReasonCodes: reasons,
  };
}

/**
 * Build truth source by subsystem from current state.
 * When exchange snapshots are fresh, orders/fills use exchange_pull; else runtime/ledger.
 */
export function getTruthSourceBySubsystem(freshness: TruthFreshnessState): TruthSourceBySubsystem {
  const orders: TruthSourceKind =
    freshness.exchangeTruthHealthy && freshness.lastExchangeOrdersSnapshotAt != null
      ? "exchange_pull"
      : "runtime_memory";
  const fills: TruthSourceKind =
    freshness.exchangeTruthHealthy && freshness.lastExchangeFillsSnapshotAt != null
      ? "exchange_pull"
      : "durable_ledger";
  return {
    orders,
    fills,
    positions: "runtime_memory",
    exposure: "runtime_memory",
  };
}

/**
 * Build TruthModelStatus for health/operator payload.
 */
export function buildTruthModelStatus(params: {
  lastExchangeOrdersSnapshotAt: Date | null;
  lastExchangeFillsSnapshotAt: Date | null;
  exchangeTruthUnavailable?: boolean;
  ordersStaleThresholdMs?: number;
  fillsStaleThresholdMs?: number;
}): TruthModelStatus {
  const freshness = computeExchangeTruthFreshness({
    lastExchangeOrdersSnapshotAt: params.lastExchangeOrdersSnapshotAt,
    lastExchangeFillsSnapshotAt: params.lastExchangeFillsSnapshotAt,
    ordersStaleThresholdMs: params.ordersStaleThresholdMs,
    fillsStaleThresholdMs: params.fillsStaleThresholdMs,
    exchangeTruthUnavailable: params.exchangeTruthUnavailable,
  });
  return {
    exchangeTruthHealthy: freshness.exchangeTruthHealthy,
    lastExchangeOrdersSnapshotAt: params.lastExchangeOrdersSnapshotAt?.toISOString() ?? null,
    lastExchangeFillsSnapshotAt: params.lastExchangeFillsSnapshotAt?.toISOString() ?? null,
    truthSourceBySubsystem: getTruthSourceBySubsystem(freshness),
    staleReasonCodes: freshness.exchangeTruthStaleReasonCodes,
  };
}

/**
 * Convert reconciliation ExchangeOpenOrder to normalized snapshot shape.
 */
export function exchangeOrderToNormalized(o: ExchangeOpenOrder): NormalizedExchangeOpenOrder {
  return {
    id: o.id,
    market: o.market,
    asset_id: o.asset_id,
    side: o.side,
    original_size: o.original_size,
    size_matched: o.size_matched,
    price: o.price,
    status: o.status,
  };
}
