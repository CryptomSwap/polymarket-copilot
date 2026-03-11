/**
 * Backtest data: load price snapshots and market metadata for replay.
 * Single source of truth: MarketPriceSnapshot ordered by time.
 */

import { prisma } from "@/lib/db";

export interface PriceSnapshotRow {
  marketId: string;
  assetId: string;
  price: number;
  liquidity: number;
  capturedAt: Date;
}

export interface MarketMeta {
  marketId: string;
  endDate: Date | null;
  liquidityNum: number;
}

/**
 * Load all price snapshots in [startDate, endDate] for the given market IDs (or all markets with data).
 * Returns rows sorted by capturedAt ascending.
 */
export async function loadSnapshots(opts: {
  startDate: Date;
  endDate: Date;
  marketIds?: string[];
}): Promise<PriceSnapshotRow[]> {
  const where: { capturedAt: { gte: Date; lte: Date }; marketId?: { in: string[] } } = {
    capturedAt: { gte: opts.startDate, lte: opts.endDate },
  };
  if (opts.marketIds?.length) {
    where.marketId = { in: opts.marketIds };
  }

  const rows = await prisma.marketPriceSnapshot.findMany({
    where,
    orderBy: { capturedAt: "asc" },
    select: {
      marketId: true,
      assetId: true,
      price: true,
      liquidity: true,
      capturedAt: true,
    },
  });

  function parseNum(x: unknown): number {
    if (typeof x === "number" && Number.isFinite(x)) return x;
    if (typeof x === "string") {
      const n = parseFloat(x);
      return Number.isFinite(n) ? n : 0;
    }
    return 0;
  }

  return rows.map((r) => ({
    marketId: r.marketId,
    assetId: r.assetId,
    price: parseNum(r.price),
    liquidity: parseNum(r.liquidity),
    capturedAt: r.capturedAt,
  }));
}

/**
 * Load market metadata (endDate, liquidityNum) for given market IDs.
 * Used for hours-to-resolution and liquidity fallback when snapshot has no liquidity.
 */
export async function loadMarketMeta(marketIds: string[]): Promise<Map<string, MarketMeta>> {
  if (marketIds.length === 0) return new Map();
  const markets = await prisma.syncedMarket.findMany({
    where: { id: { in: marketIds } },
    select: { id: true, endDate: true, liquidityNum: true },
  });
  const map = new Map<string, MarketMeta>();
  for (const m of markets) {
    map.set(m.id, {
      marketId: m.id,
      endDate: m.endDate,
      liquidityNum: m.liquidityNum ?? 0,
    });
  }
  return map;
}
