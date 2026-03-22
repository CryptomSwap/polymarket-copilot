/**
 * Resolve Polymarket synced market ids for MarketPriceSnapshot queries.
 * PaperTrade / ShadowCandidate may store conditionId while snapshots use SyncedMarket.id (or vice versa).
 */

import { prisma } from "@/lib/db";

const snapshotMarketIdCache = new Map<string, string[]>();

function parseNum(s: string | null | undefined): number | null {
  if (s == null || s === "") return null;
  const n = parseFloat(String(s).trim());
  return Number.isFinite(n) ? n : null;
}

/** Test hook: clear module cache between cases. */
export function clearSnapshotMarketIdLookupCache(): void {
  snapshotMarketIdCache.clear();
}

/**
 * Ids to use when querying MarketPriceSnapshot: raw key plus any SyncedMarket.id matching id or conditionId.
 */
export async function resolveSnapshotMarketIds(marketId: string): Promise<string[]> {
  const key = String(marketId ?? "").trim();
  if (!key) return [];
  const cached = snapshotMarketIdCache.get(key);
  if (cached) return cached;
  const rows = await prisma.syncedMarket.findMany({
    where: { OR: [{ id: key }, { conditionId: key }] },
    select: { id: true },
    take: 5,
  });
  const ids = Array.from(new Set([key, ...rows.map((r) => r.id)]));
  snapshotMarketIdCache.set(key, ids);
  return ids;
}

/** Latest snapshot price at or before `at` (same semantics as historical shadow evaluation). */
export async function getSnapshotPriceAtOrBefore(
  marketId: string,
  assetId: string,
  at: Date
): Promise<number | null> {
  const marketIds = await resolveSnapshotMarketIds(marketId);
  if (marketIds.length === 0) return null;
  const row = await prisma.marketPriceSnapshot.findFirst({
    where: { marketId: { in: marketIds }, assetId, capturedAt: { lte: at } },
    orderBy: { capturedAt: "desc" },
  });
  if (!row) return null;
  return parseNum(row.price);
}

export type PaperCloseExitPriceSource = "lte" | "gte_after_horizon" | "latest_any";

export interface PaperCloseExitPriceResult {
  price: number;
  source: PaperCloseExitPriceSource;
  snapshotCapturedAt: string;
}

/**
 * Best-effort exit price for paper 12h close: prefer snapshot at/before horizon, then first after, then latest any.
 */
export async function resolvePaperTradeCloseExitPrice(
  marketId: string,
  assetId: string,
  at: Date
): Promise<PaperCloseExitPriceResult | null> {
  const marketIds = await resolveSnapshotMarketIds(marketId);
  if (marketIds.length === 0) return null;

  const lte = await prisma.marketPriceSnapshot.findFirst({
    where: { marketId: { in: marketIds }, assetId, capturedAt: { lte: at } },
    orderBy: { capturedAt: "desc" },
  });
  if (lte) {
    const p = parseNum(lte.price);
    if (p != null && p > 0) {
      return { price: p, source: "lte", snapshotCapturedAt: lte.capturedAt.toISOString() };
    }
  }

  const gte = await prisma.marketPriceSnapshot.findFirst({
    where: { marketId: { in: marketIds }, assetId, capturedAt: { gte: at } },
    orderBy: { capturedAt: "asc" },
  });
  if (gte) {
    const p = parseNum(gte.price);
    if (p != null && p > 0) {
      return { price: p, source: "gte_after_horizon", snapshotCapturedAt: gte.capturedAt.toISOString() };
    }
  }

  const latest = await prisma.marketPriceSnapshot.findFirst({
    where: { marketId: { in: marketIds }, assetId },
    orderBy: { capturedAt: "desc" },
  });
  if (latest) {
    const p = parseNum(latest.price);
    if (p != null && p > 0) {
      return { price: p, source: "latest_any", snapshotCapturedAt: latest.capturedAt.toISOString() };
    }
  }

  return null;
}
