/**
 * Normalization layer: raw Polymarket market WebSocket payloads → MarketStateEngine update inputs.
 * Additive only; does not replace or change existing stream health/repair logic.
 * Defensive parsing with logging for malformed or unexpected payloads.
 */

import type {
  QuoteUpdateInput,
  TradeUpdateInput,
  DepthUpdateInput,
} from "@/lib/runtime/market-state/market-state-engine";

const LOG_PREFIX = "[market-feed-normalizer]";

function safeNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number.parseFloat(v);
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
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v);
  if (typeof v === "string") {
    const n = Number.parseFloat(v);
    if (Number.isFinite(n)) return new Date(n);
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? new Date() : d;
  }
  return new Date();
}

export type NormalizedMarketUpdate =
  | { kind: "quote"; input: QuoteUpdateInput }
  | { kind: "trade"; input: TradeUpdateInput }
  | { kind: "depth"; input: DepthUpdateInput };

/**
 * Normalize a raw market WebSocket message into engine update(s).
 * Returns empty array if message type is unknown or payload is malformed.
 * Logs (console.warn) for malformed/unexpected payloads; does not throw.
 */
export function normalizeMarketFeedMessage(data: unknown): NormalizedMarketUpdate[] {
  if (data == null || typeof data !== "object") {
    return [];
  }
  const obj = data as Record<string, unknown>;
  const type = (typeof obj.type === "string" ? obj.type : "") || (typeof obj.event_type === "string" ? obj.event_type : "");
  const assetId = typeof obj.asset_id === "string" ? obj.asset_id : undefined;
  const marketId = typeof obj.market === "string" ? obj.market : (typeof obj.marketId === "string" ? obj.marketId : undefined);
  const at = parseTimestamp(obj.timestamp ?? obj.ts ?? obj.occurredAt);

  if (!assetId || assetId.trim() === "") {
    if (type && type !== "book" && type !== "price_change") {
      // book can come with asset_id inside payload
      return [];
    }
  }

  switch (type) {
    case "best_bid_ask": {
      const bestBid = safeNum(obj.best_bid ?? obj.bestBid);
      const bestAsk = safeNum(obj.best_ask ?? obj.bestAsk);
      if (assetId && (bestBid !== null || bestAsk !== null)) {
        return [{ kind: "quote", input: { assetId, marketId: marketId ?? null, bestBid, bestAsk, at } }];
      }
      if (type && !assetId) console.warn(LOG_PREFIX, "best_bid_ask missing asset_id", { type, keys: Object.keys(obj) });
      return [];
    }

    case "last_trade_price": {
      const price = safeNum(obj.price);
      const size = safeNum(obj.size);
      const side = safeSide(obj.side);
      if (assetId && price !== null && size !== null && side) {
        return [{ kind: "trade", input: { assetId, marketId: marketId ?? null, price, size, side, at } }];
      }
      console.warn(LOG_PREFIX, "last_trade_price missing required fields", { assetId: !!assetId, price, size, side });
      return [];
    }

    case "book": {
      const payload = obj.payload && typeof obj.payload === "object" ? (obj.payload as Record<string, unknown>) : obj;
      const aid = typeof payload.asset_id === "string" ? payload.asset_id : assetId;
      const mid = typeof payload.market === "string" ? payload.market : marketId;
      if (!aid) {
        console.warn(LOG_PREFIX, "book missing asset_id", { keys: Object.keys(obj) });
        return [];
      }
      const bids = Array.isArray(payload.bids) ? payload.bids : [];
      const asks = Array.isArray(payload.asks) ? payload.asks : [];
      const firstBid = bids.length > 0 ? bids[0] : null;
      const firstAsk = asks.length > 0 ? asks[0] : null;
      let bestBid: number | null = null;
      let bidTopSize: number | null = null;
      let bestAsk: number | null = null;
      let askTopSize: number | null = null;
      if (firstBid != null && typeof firstBid === "object" && !Array.isArray(firstBid)) {
        const b = firstBid as Record<string, unknown>;
        bestBid = safeNum(b.price ?? b.price_level);
        bidTopSize = safeNum(b.size ?? b.size_raw);
      } else if (Array.isArray(firstBid) && firstBid.length >= 2) {
        bestBid = safeNum(firstBid[0]);
        bidTopSize = safeNum(firstBid[1]);
      }
      if (firstAsk != null && typeof firstAsk === "object" && !Array.isArray(firstAsk)) {
        const a = firstAsk as Record<string, unknown>;
        bestAsk = safeNum(a.price ?? a.price_level);
        askTopSize = safeNum(a.size ?? a.size_raw);
      } else if (Array.isArray(firstAsk) && firstAsk.length >= 2) {
        bestAsk = safeNum(firstAsk[0]);
        askTopSize = safeNum(firstAsk[1]);
      }
      const updates: NormalizedMarketUpdate[] = [];
      if (bestBid !== null || bestAsk !== null) {
        updates.push({ kind: "quote", input: { assetId: aid, marketId: mid ?? null, bestBid, bestAsk, at } });
      }
      if (bidTopSize !== null || askTopSize !== null) {
        updates.push({ kind: "depth", input: { assetId: aid, marketId: mid ?? null, bidTopSize, askTopSize, at } });
      }
      return updates;
    }

    case "price_change": {
      const changes = obj.price_changes ?? obj.price_changes_array;
      const arr: unknown[] = Array.isArray(changes) ? changes : (Array.isArray(obj.payload) ? obj.payload : []);
      if (arr.length === 0) {
        const firstElement = arr[0];
        const single = firstElement ?? (obj as Record<string, unknown>).best_bid ?? (obj as Record<string, unknown>).best_ask;
        if (single != null && typeof single === "object") {
          const s = single as Record<string, unknown>;
          const aid = typeof s.asset_id === "string" ? s.asset_id : assetId;
          const bestBid = safeNum(s.best_bid ?? s.bestBid);
          const bestAsk = safeNum(s.best_ask ?? s.bestAsk);
          if (aid && (bestBid !== null || bestAsk !== null)) {
            return [{ kind: "quote", input: { assetId: aid, marketId: marketId ?? null, bestBid, bestAsk, at } }];
          }
        }
        return [];
      }
      const updates: NormalizedMarketUpdate[] = [];
      for (let i = 0; i < arr.length; i++) {
        const item = arr[i];
        if (item == null || typeof item !== "object") continue;
        const row = item as Record<string, unknown>;
        const aid = typeof row.asset_id === "string" ? row.asset_id : assetId;
        const bestBid = safeNum(row.best_bid ?? row.bestBid);
        const bestAsk = safeNum(row.best_ask ?? row.bestAsk);
        if (aid && (bestBid !== null || bestAsk !== null)) {
          updates.push({ kind: "quote", input: { assetId: aid, marketId: marketId ?? (typeof row.market === "string" ? row.market : null), bestBid, bestAsk, at } });
        }
      }
      return updates;
    }

    default:
      if (type && type !== "pong" && type !== "PONG" && type !== "subscribed") {
        console.warn(LOG_PREFIX, "unexpected message type", { type, assetId: !!assetId, keys: Object.keys(obj).slice(0, 10) });
      }
      return [];
  }
}

/**
 * Apply normalized update(s) to a MarketStateEngine. No-op if engine is null.
 * Use from worker or any consumer that holds an engine reference.
 */
export function feedNormalizedUpdatesToEngine(
  updates: NormalizedMarketUpdate[],
  engine: { applyQuoteUpdate: (i: QuoteUpdateInput) => void; applyTradeUpdate: (i: TradeUpdateInput) => void; applyDepthUpdate: (i: DepthUpdateInput) => void } | null
): void {
  if (!engine) return;
  for (const u of updates) {
    try {
      switch (u.kind) {
        case "quote":
          engine.applyQuoteUpdate(u.input);
          break;
        case "trade":
          engine.applyTradeUpdate(u.input);
          break;
        case "depth":
          engine.applyDepthUpdate(u.input);
          break;
      }
    } catch (err) {
      console.warn(LOG_PREFIX, "engine apply failed", { kind: u.kind, assetId: u.input.assetId, error: String(err) });
    }
  }
}
