/**
 * Startup rebuild helpers: reconstruct order lifecycle and position stores from exchange/ledger truth.
 * Used by StreamRuntime before allowing normal automated flow. No DB projections mixed with execution-plane state.
 * When journalAppend is provided, each rebuilt order is journaled as rebuild_imported.
 */

import type { OrderLifecycleStore } from "../order-manager/order-lifecycle-store";
import type { RuntimePositionStore } from "../positions/runtime-position-store";
import type { RuntimePositionUpdater } from "../positions/runtime-position-updater";
import type { RuntimeRiskEngine } from "../risk/runtime-risk-engine";
import { updateRiskExposureFromStores } from "../runtime-exposure";
import { openOrderSchema } from "@/types/polymarket";
/** Minimal fill shape for position rebuild; compatible with UnappliedFillEntry and UnappliedFillRow. */
export interface LedgerFillForRebuild {
  funderAddress: string;
  assetId: string;
  marketId: string;
  side: string;
  size: number;
  price: number;
  filledAt: Date;
  outcome: string;
}
import type { AppendOrderLifecycleEventParams } from "../journal/order-lifecycle-journal";
import { ORDER_LIFECYCLE_EVENT_TYPES } from "../journal/order-lifecycle-journal";

export interface ExchangeOpenOrderForRebuild {
  id: string;
  market: string;
  asset_id: string;
  side: string;
  original_size: string;
  size_matched: string;
  price: string;
  status: string;
}

function parseNum(s: string | null | undefined): number {
  if (s == null || s === "") return 0;
  const n = parseFloat(String(s).trim());
  return Number.isFinite(n) ? n : 0;
}

/**
 * Rebuild in-memory order lifecycle store from exchange open orders.
 * Clears the store and repopulates with one working order per exchange order (clientOrderId = "rebuild:" + exchangeId).
 * When journalAppend is provided, each order is journaled as rebuild_imported.
 */
export function rebuildOrderStoreFromTruth(
  orderStore: OrderLifecycleStore,
  exchangeOrders: ExchangeOpenOrderForRebuild[],
  funderAddress: string,
  journalAppend?: (params: AppendOrderLifecycleEventParams) => void | Promise<void>
): void {
  orderStore.clear();
  const funder = funderAddress.toLowerCase();
  const now = new Date();
  for (const ex of exchangeOrders) {
    const clientOrderId = `rebuild:${ex.id}`;
    const size = parseNum(ex.original_size);
    const sizeMatched = parseNum(ex.size_matched);
    const price = parseNum(ex.price);
    if (size <= 0) continue;
    orderStore.create({
      clientOrderId,
      funderAddress: funder,
      assetId: ex.asset_id,
      marketId: ex.market,
      side: ex.side as "BUY" | "SELL",
      price,
      size,
    });
    orderStore.applyAck(clientOrderId, ex.id);
    if (sizeMatched > 0) {
      orderStore.applyPartialFill(clientOrderId, sizeMatched, price);
    }
    if (journalAppend) {
      const result = journalAppend({
        funderAddress: funder,
        clientOrderId,
        exchangeOrderId: ex.id,
        assetId: ex.asset_id,
        marketId: ex.market,
        side: ex.side,
        eventType: ORDER_LIFECYCLE_EVENT_TYPES.REBUILD_IMPORTED,
        payloadJson: JSON.stringify({
          clientOrderId,
          price,
          size,
          sizeMatched,
          exchangeOrderId: ex.id,
        }),
        occurredAt: now,
      });
      void Promise.resolve(result).catch(() => {});
    }
  }
}

/**
 * Rebuild in-memory runtime position store from durable fill ledger entries.
 * Clears the position store and applies each fill in order (by filledAt).
 */
export function rebuildPositionStoreFromTruth(
  positionStore: RuntimePositionStore,
  positionUpdater: RuntimePositionUpdater,
  ledgerFills: LedgerFillForRebuild[]
): void {
  positionStore.clear();
  for (const entry of ledgerFills) {
    const filledAt = entry.filledAt instanceof Date ? entry.filledAt : new Date(entry.filledAt as unknown as string | number);
    positionUpdater.applyFill({
      funderAddress: entry.funderAddress,
      assetId: entry.assetId,
      marketId: entry.marketId,
      outcome: entry.outcome ?? "",
      side: entry.side as "BUY" | "SELL",
      size: entry.size,
      price: entry.price,
      filledAt,
    });
  }
}

/**
 * Recompute risk exposure from current position and order stores and push into risk engine.
 */
export function recomputeRiskExposure(
  riskEngine: RuntimeRiskEngine,
  positionStore: RuntimePositionStore,
  orderStore: OrderLifecycleStore
): void {
  updateRiskExposureFromStores(riskEngine, positionStore, orderStore);
}

/**
 * No-op helper for clarity at call site: "finalize" means runtime is ready for normal flow.
 * Caller (StreamRuntime) sets phase to "ready" and starts automation after rebuild completes.
 */
export function finalizeRuntimeReadiness(): void {
  // Caller sets status to "ready" and enables automation; this is a semantic marker.
}

/** Parse raw CLOB order into ExchangeOpenOrderForRebuild; returns null if invalid. */
export function parseExchangeOrderForRebuild(raw: unknown): ExchangeOpenOrderForRebuild | null {
  const parsed = openOrderSchema.safeParse(raw);
  if (!parsed.success) return null;
  const d = parsed.data;
  return {
    id: d.id,
    market: d.market,
    asset_id: d.asset_id,
    side: d.side,
    original_size: d.original_size,
    size_matched: d.size_matched,
    price: d.price,
    status: d.status,
  };
}
