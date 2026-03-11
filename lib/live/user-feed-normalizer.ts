/**
 * Normalization layer: raw Polymarket user WebSocket (order/fill) events
 * → lifecycle inputs (ack, partial fill, fill, cancel, reject) + position fill.
 * Additive; existing persist/drift/onStreamEvent paths unchanged.
 * Caller resolves exchangeOrderId → clientOrderId via OrderLifecycleStore.getByExternalId.
 */

import type { NormalizedFillInput } from "@/lib/runtime/positions/runtime-position-updater";

const LOG_PREFIX = "[user-feed-normalizer]";

function safeNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function safeSide(v: unknown): "BUY" | "SELL" | null {
  if (typeof v !== "string") return null;
  const u = v.toUpperCase();
  return u === "BUY" || u === "SELL" ? u : null;
}

function parseTimestamp(v: unknown): Date {
  if (v instanceof Date) return v;
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v * 1000);
  if (typeof v === "string") {
    const n = parseFloat(v);
    if (Number.isFinite(n)) return new Date(n * 1000);
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? new Date() : d;
  }
  return new Date();
}

/** Normalized lifecycle event keyed by exchange order id; caller resolves to clientOrderId. */
export type NormalizedUserFeedLifecycleKind = "ack" | "partial_fill" | "fill" | "cancel" | "reject";

export interface NormalizedUserFeedLifecycleBase {
  kind: NormalizedUserFeedLifecycleKind;
  /** Polymarket order id (exchange side). Resolve to clientOrderId via store.getByExternalId. */
  exchangeOrderId: string;
  at: Date;
}

export interface NormalizedUserFeedAck extends NormalizedUserFeedLifecycleBase {
  kind: "ack";
}

export interface NormalizedUserFeedPartialFill extends NormalizedUserFeedLifecycleBase {
  kind: "partial_fill";
  fillSize: number;
  fillPrice: number;
}

export interface NormalizedUserFeedFill extends NormalizedUserFeedLifecycleBase {
  kind: "fill";
  totalFilledSize: number;
  avgPrice: number;
}

export interface NormalizedUserFeedCancel extends NormalizedUserFeedLifecycleBase {
  kind: "cancel";
  reason?: string;
}

export interface NormalizedUserFeedReject extends NormalizedUserFeedLifecycleBase {
  kind: "reject";
  reason: string;
}

export type NormalizedUserFeedLifecycle =
  | NormalizedUserFeedAck
  | NormalizedUserFeedPartialFill
  | NormalizedUserFeedFill
  | NormalizedUserFeedCancel
  | NormalizedUserFeedReject;

export interface NormalizedUserFeedResult {
  funderAddress: string;
  lifecycle: NormalizedUserFeedLifecycle | null;
  /** For fills: apply to runtime position store even when order not in our lifecycle store. */
  positionFill: NormalizedFillInput | null;
}

/**
 * Normalize a raw user-feed message into lifecycle + optional position fill.
 * Returns null if message type is unknown or payload is malformed.
 * Does not resolve exchangeOrderId → clientOrderId (caller does that).
 */
export function normalizeUserFeedMessage(
  funderAddress: string,
  data: unknown
): NormalizedUserFeedResult | null {
  if (data == null || typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;
  const rawType = typeof obj.type === "string" ? obj.type : "";
  const type = rawType.toUpperCase();
  const eventType = (typeof obj.event_type === "string" ? obj.event_type : rawType).toLowerCase();
  const payload = (obj.payload && typeof obj.payload === "object" ? obj.payload : obj) as Record<string, unknown>;

  const assetId = typeof payload.asset_id === "string" ? payload.asset_id : typeof obj.asset_id === "string" ? obj.asset_id : undefined;
  const marketId = typeof payload.market === "string" ? payload.market : typeof obj.market === "string" ? obj.market : undefined;
  const outcome = typeof payload.outcome === "string" ? payload.outcome : "";
  const at = parseTimestamp(payload.timestamp ?? payload.matchtime ?? payload.last_update ?? obj.timestamp);

  // ----- order events (PLACEMENT, UPDATE, CANCELLATION) -----
  if (type === "PLACEMENT" || type === "ORDER" || eventType === "order") {
    const orderSubType = (typeof payload.type === "string" ? payload.type : type).toUpperCase();
    const exchangeOrderId = typeof payload.id === "string" ? payload.id : typeof obj.id === "string" ? obj.id : undefined;
    if (!exchangeOrderId) {
      console.warn(LOG_PREFIX, "order event missing id", { type: orderSubType, keys: Object.keys(payload).slice(0, 8) });
      return null;
    }

    if (orderSubType === "PLACEMENT" || orderSubType === "ORDER") {
      return {
        funderAddress,
        lifecycle: { kind: "ack", exchangeOrderId, at },
        positionFill: null,
      };
    }
    if (orderSubType === "CANCELLATION") {
      return {
        funderAddress,
        lifecycle: { kind: "cancel", exchangeOrderId, at },
        positionFill: null,
      };
    }
    if (orderSubType === "UPDATE") {
      const sizeMatched = safeNum(payload.size_matched ?? payload.sizeMatched);
      const price = safeNum(payload.price);
      if (sizeMatched != null && sizeMatched >= 0 && price != null) {
        return {
          funderAddress,
          lifecycle: {
            kind: "partial_fill",
            exchangeOrderId,
            at,
            /** Cumulative size matched so far; consumer must compute delta from store filledSize. */
            fillSize: sizeMatched,
            fillPrice: price,
          },
          positionFill: null,
        };
      }
    }
    return null;
  }

  // ----- trade events (fill) -----
  if (type === "TRADE" || eventType === "trade" || eventType === "fill" || type === "FILL") {
    const status = (typeof payload.status === "string" ? payload.status : "").toUpperCase();
    const makerOrders = Array.isArray(payload.maker_orders) ? payload.maker_orders : [];
    const firstMaker = makerOrders.length > 0 && makerOrders[0] && typeof makerOrders[0] === "object" ? (makerOrders[0] as Record<string, unknown>) : null;
    const exchangeOrderId =
      typeof payload.taker_order_id === "string"
        ? payload.taker_order_id
        : typeof payload.order_id === "string"
          ? payload.order_id
          : firstMaker && typeof firstMaker.order_id === "string"
            ? firstMaker.order_id
            : undefined;
    const size = safeNum(payload.size ?? payload.matched_amount ?? firstMaker?.matched_amount);
    const price = safeNum(payload.price ?? firstMaker?.price);
    const side = safeSide(payload.side);

    if (!assetId || !marketId || size == null || size <= 0 || price == null || !side) {
      console.warn(LOG_PREFIX, "trade/fill missing required fields", { assetId: !!assetId, marketId: !!marketId, size, price, side });
      return null;
    }

    const positionFill: NormalizedFillInput = {
      funderAddress,
      assetId,
      marketId,
      outcome,
      side,
      size,
      price,
      filledAt: at,
    };

    if (status === "CONFIRMED" || status === "MATCHED" || status === "MINED") {
      return {
        funderAddress,
        lifecycle: exchangeOrderId
          ? { kind: "fill", exchangeOrderId, at, totalFilledSize: size, avgPrice: price }
          : null,
        positionFill,
      };
    }
    if (status === "FAILED") {
      return {
        funderAddress,
        lifecycle: exchangeOrderId ? { kind: "reject", exchangeOrderId, at, reason: "trade_failed" } : null,
        positionFill: null,
      };
    }
    return { funderAddress, lifecycle: null, positionFill };
  }

  return null;
}
