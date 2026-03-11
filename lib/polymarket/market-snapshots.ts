/**
 * Market price snapshots: capture per-outcome price, volume, liquidity during sync or recompute.
 * Used for momentum and price-change metrics. Read-only after capture; no trading.
 */

import { prisma } from "@/lib/db";

export interface SnapshotRow {
  marketId: string;
  assetId: string;
  outcome: string;
  price: string;
  volume: string;
  liquidity: string;
  capturedAt: Date;
}

function parseNum(x: unknown): number {
  if (typeof x === "number" && Number.isFinite(x)) return x;
  if (typeof x === "string") {
    const n = parseFloat(x);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function toStr(n: number): string {
  return String(Number.isFinite(n) ? n : 0);
}

/**
 * Extract outcome price and optional volume/liquidity from market raw JSON.
 */
function extractFromRaw(
  raw: Record<string, unknown> | null,
  outcomeIndex: number
): { price: number; volume: number; liquidity: number } {
  let price = 0.5;
  let volume = 0;
  let liquidity = 0;
  if (raw) {
    const prices = raw.outcomePrices ?? raw.prices;
    if (Array.isArray(prices)) price = parseNum(prices[outcomeIndex]);
    else if (typeof prices === "string") {
      try {
        const arr = JSON.parse(prices) as unknown[];
        price = parseNum(arr[outcomeIndex]);
      } catch {
        // keep default
      }
    }
    volume = parseNum(raw.volume ?? raw.volumeNum ?? 0);
    liquidity = parseNum(raw.liquidity ?? raw.liquidityNum ?? 0);
  }
  return { price, volume, liquidity };
}

/**
 * Capture snapshots for all assets of the given markets (or all active synced markets if not provided).
 * Call during market sync or before recommendation recompute.
 */
export async function captureMarketSnapshots(opts?: {
  marketIds?: string[];
}): Promise<{ captured: number; errors: string[] }> {
  const errors: string[] = [];
  const capturedAt = new Date();

  const markets = await prisma.syncedMarket.findMany({
    where: opts?.marketIds?.length
      ? { id: { in: opts.marketIds }, status: "active" }
      : { status: "active" },
    include: { assets: true },
    take: 500,
  });

  let captured = 0;
  for (const m of markets) {
    let rawJson: Record<string, unknown> | null = null;
    if (m.raw) {
      try {
        rawJson = JSON.parse(m.raw) as Record<string, unknown>;
      } catch {
        rawJson = null;
      }
    }
    const volume = m.volumeNum ?? 0;
    const liquidity = m.liquidityNum ?? 0;

    for (const a of m.assets) {
      const { price } = extractFromRaw(rawJson, a.outcomeIndex ?? 0);
      try {
        await prisma.marketPriceSnapshot.create({
          data: {
            marketId: m.id,
            assetId: a.tokenId,
            outcome: a.outcome,
            price: toStr(price),
            volume: toStr(volume),
            liquidity: toStr(liquidity),
            capturedAt,
          },
        });
        captured++;
      } catch (e) {
        errors.push(e instanceof Error ? e.message : "Snapshot create failed");
      }
    }
  }

  return { captured, errors };
}
