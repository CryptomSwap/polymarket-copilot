/**
 * Runtime reconciliation: compare runtime order lifecycle state vs exchange truth.
 * Result type and repair recommendation types. Paper-safe: no live execution.
 */

import type { RuntimeOrderState } from "../order-manager/order-manager";

/** Exchange open order (minimal shape from CLOB / openOrderSchema). */
export interface ExchangeOpenOrder {
  id: string;
  market: string;
  asset_id: string;
  side: string;
  original_size: string;
  size_matched: string;
  price: string;
  status: string;
}

/** Single repair recommendation (paper-safe: no exchange submit). */
export type RepairRecommendationKind =
  | "mark_local_canceled"   // Local working order absent on exchange → mark local as canceled
  | "sync_order_from_exchange"; // Exchange has order we don't → optional: add to local (not auto-applied by default)

export interface RepairRecommendation {
  kind: RepairRecommendationKind;
  /** clientOrderId when kind is mark_local_canceled. */
  clientOrderId?: string;
  /** exchangeOrderId. */
  exchangeOrderId: string;
  assetId?: string;
  marketId?: string;
  reason: string;
}

export interface RuntimeReconciliationResult {
  success: boolean;
  error?: string | null;
  asOf: Date;
  reconcileDurationMs: number;
  /** Diagnostics for the exchange truth fetch step (bounded retries + abort/timeout classification). */
  exchangeOpenOrdersFetchDiagnostics?: {
    attempts: number;
    perAttemptTimeoutMs?: number;
    lastErrorType?: "timeout" | "aborted" | "auth" | "fetch_error" | "unknown";
  } | null;
  /** Exchange order ids we have no local open order for (exchange truth only). */
  missingLocalOrders: string[];
  /** Local working/partially_filled orders whose exchange id is not on exchange (stale local). */
  missingExchangeOrders: RuntimeOrderState[];
  /** Same as missingExchangeOrders; alias for clarity. */
  staleWorkingOrders: RuntimeOrderState[];
  /** Local orders with potential fill drift (exchange size_matched > local filledSize or vice versa). */
  missingFills: Array<{
    clientOrderId: string;
    exchangeOrderId: string;
    assetId: string;
    marketId: string;
    side: "BUY" | "SELL";
    localStatus: RuntimeOrderState["status"];
    localFilledSize: number;
    exchangeSizeMatched: number;
  }>;
  /** Orders we applied in-memory repair to (e.g. mark canceled). */
  repairedOrders: string[];
  /** Position-related repairs (none in paper-safe version). */
  repairedPositions: string[];
  /** True if any drift detected (missing local, missing exchange, or fill mismatch). */
  driftDetected: boolean;
  /** Recommended repairs not yet applied. */
  repairRecommendations: RepairRecommendation[];
}

export const EMPTY_RECONCILIATION_RESULT = (asOf: Date): RuntimeReconciliationResult => ({
  success: true,
  asOf,
  reconcileDurationMs: 0,
  missingLocalOrders: [],
  missingExchangeOrders: [],
  staleWorkingOrders: [],
  missingFills: [],
  repairedOrders: [],
  repairedPositions: [],
  driftDetected: false,
  repairRecommendations: [],
});
