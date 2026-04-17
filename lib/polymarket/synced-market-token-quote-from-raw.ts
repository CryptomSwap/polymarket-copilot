/**
 * Best-effort bid/ask for a CLOB token from `SyncedMarket.raw` (Gamma / sync JSON).
 * No network calls; returns nulls when the payload has no matching token quotes.
 *
 * ShadowCandidate / execution quality bid-ask at decision time is separate telemetry;
 * this only reads fields if present on synced market JSON (often sparse).
 */

import { prisma } from "@/lib/db";

function finiteNum(x: unknown): number | null {
  if (typeof x === "number" && Number.isFinite(x)) return x;
  if (typeof x === "string" && x.trim() !== "") {
    const n = parseFloat(x);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function spreadBpsFromBidAsk(bestBid: number | null, bestAsk: number | null): number | null {
  if (bestBid == null || bestAsk == null || bestAsk <= bestBid) return null;
  const mid = (bestBid + bestAsk) / 2;
  if (mid <= 0 || !Number.isFinite(mid)) return null;
  return ((bestAsk - bestBid) / mid) * 10_000;
}

function readBidAskFromTokenObject(o: Record<string, unknown>): {
  bestBid: number | null;
  bestAsk: number | null;
} {
  const bestBid = finiteNum(
    o.bestBid ?? o.best_bid ?? o.bid ?? o.bestBuy ?? o.best_buy
  );
  const bestAsk = finiteNum(
    o.bestAsk ?? o.best_ask ?? o.ask ?? o.bestSell ?? o.best_sell
  );
  return { bestBid, bestAsk };
}

/**
 * Parse `SyncedMarket.raw` for `tokenId` (CLOB / asset id). Tries `tokens[]` and aligned `clobTokenIds` patterns.
 */
export function tryBidAskSpreadBpsFromSyncedMarketRaw(
  rawJson: string | null | undefined,
  tokenId: string
): { bestBid: number | null; bestAsk: number | null; spreadBps: number | null } {
  const empty = { bestBid: null, bestAsk: null, spreadBps: null };
  const tid = String(tokenId ?? "").trim();
  if (!tid || !rawJson?.trim()) return empty;

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(rawJson) as Record<string, unknown>;
  } catch {
    return empty;
  }

  const tokens = raw.tokens;
  if (Array.isArray(tokens)) {
    for (const item of tokens) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      const id = String(o.token_id ?? o.tokenId ?? o.asset_id ?? "").trim();
      if (id !== tid) continue;
      const { bestBid, bestAsk } = readBidAskFromTokenObject(o);
      return {
        bestBid,
        bestAsk,
        spreadBps: spreadBpsFromBidAsk(bestBid, bestAsk),
      };
    }
  }

  let clobIds: unknown[] | null = null;
  const ct = raw.clobTokenIds;
  if (Array.isArray(ct)) clobIds = ct;
  else if (typeof ct === "string") {
    try {
      const p = JSON.parse(ct) as unknown;
      if (Array.isArray(p)) clobIds = p;
    } catch {
      clobIds = null;
    }
  }
  if (clobIds) {
    const idx = clobIds.findIndex((x) => String(x).trim() === tid);
    if (idx >= 0) {
      const pickArr = (k: string): unknown[] | null => {
        const v = raw[k];
        return Array.isArray(v) ? v : null;
      };
      const bids = pickArr("bestBids") ?? pickArr("best_bids") ?? pickArr("bids");
      const asks = pickArr("bestAsks") ?? pickArr("best_asks") ?? pickArr("asks");
      if (bids && asks && idx < bids.length && idx < asks.length) {
        const bestBid = finiteNum(bids[idx]);
        const bestAsk = finiteNum(asks[idx]);
        return {
          bestBid,
          bestAsk,
          spreadBps: spreadBpsFromBidAsk(bestBid, bestAsk),
        };
      }
    }
  }

  return empty;
}

/**
 * One batched `SyncedMarket` read per tick: map each `paperTrade.marketId` hint to `raw` JSON (or null).
 * Matches `SyncedMarket.id` or `SyncedMarket.conditionId` to the hint string.
 */
export async function loadSyncedMarketRawByMarketHints(
  marketIds: string[]
): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>();
  const keys = [...new Set(marketIds.map((k) => String(k ?? "").trim()).filter(Boolean))];
  for (const k of keys) map.set(k, null);
  if (keys.length === 0) return map;

  const or = keys.flatMap((k) => [{ id: k }, { conditionId: k }]);
  const rows = await prisma.syncedMarket.findMany({
    where: { OR: or },
    select: { id: true, conditionId: true, raw: true },
  });
  for (const k of keys) {
    const hit = rows.find((r) => r.id === k || r.conditionId === k);
    if (hit) map.set(k, hit.raw ?? null);
  }
  return map;
}
