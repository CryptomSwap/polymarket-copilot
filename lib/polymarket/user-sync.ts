/**
 * Polymarket user sync: fetch open orders, trades (fills), build position snapshots; upsert to DB.
 * Read-only; no trading. Uses stored L2 credentials only (no POLYMARKET_SIGNER_PRIVATE_KEY).
 * Positions are reconstructed from fills when no direct positions endpoint is used.
 */

import { prisma } from "@/lib/db";
import { getStoredCredentials } from "@/lib/polymarket/auth";
import { fetchOpenOrdersL2, fetchAllTradesL2 } from "@/lib/polymarket/l2-readonly";
import { sizeToShares } from "@/lib/polymarket/portfolio";
import { openOrderSchema, tradeSchema } from "@/types/polymarket";
import { z } from "zod";

export type UserOrderSyncDiagnostics = {
  credentialsAvailable: boolean;
  ordersFetchMethod: string | null;
  ordersFetchedRaw: number;
  ordersAfterNormalization: number;
  ordersPersisted: number;
  ordersSkipped: number;
  ordersFetchSkippedReason: string | null;
};

function logUserSyncOrders(event: string, payload: Record<string, unknown>) {
  console.info("[user-sync][orders]", JSON.stringify({ event, ...payload }));
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface SyncUserResult {
  ordersSynced: number;
  fillsSynced: number;
  positionsSynced: number;
  errors: string[];
  ordersFetchedRaw: number;
  ordersAfterNormalization: number;
  ordersPersisted: number;
  ordersSkipped: number;
  credentialsAvailable: boolean;
  ordersFetchMethod: string | null;
  ordersFetchSkippedReason: string | null;
  /** Pages of trades fetched from CLOB (paginated). */
  fillsPagesFetched: number;
  /** Total UserFill rows in DB for this funder after sync. */
  totalFillsInDb: number;
}

function parseOpenOrder(raw: unknown): z.infer<typeof openOrderSchema> | null {
  const parsed = openOrderSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function parseTrade(raw: unknown): z.infer<typeof tradeSchema> | null {
  const parsed = tradeSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Parse Polymarket timestamp (Unix seconds string/number or ISO string) to Date for Prisma DateTime.
 * Returns null if missing or invalid; schema allows matchTime null.
 */
function parsePolymarketTimestamp(value: string | number | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    const ms = value > 1e12 ? value : value * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const s = String(value).trim();
  if (s === "") return null;
  const num = Number(s);
  if (Number.isFinite(num)) {
    const ms = num > 1e12 ? num : num * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Sync open orders and fills from CLOB using L2 creds only; reconstruct positions from fills.
 * Fetches all pages of trades so derived positions match wallet. Option fullResync clears UserFill for funder before fetching.
 */
export async function syncUser(opts?: { fullResync?: boolean }): Promise<SyncUserResult> {
  const errors: string[] = [];
  let ordersSynced = 0;
  let fillsSynced = 0;
  let positionsSynced = 0;
  const orderDiagnostics: UserOrderSyncDiagnostics = {
    credentialsAvailable: false,
    ordersFetchMethod: null,
    ordersFetchedRaw: 0,
    ordersAfterNormalization: 0,
    ordersPersisted: 0,
    ordersSkipped: 0,
    ordersFetchSkippedReason: null,
  };

  const creds = await getStoredCredentials();
  if (!creds) {
    orderDiagnostics.credentialsAvailable = false;
    orderDiagnostics.ordersFetchSkippedReason = "missing_credentials";
    logUserSyncOrders("fetch_skipped", {
      funderAddress: null,
      credentialsAvailable: orderDiagnostics.credentialsAvailable,
      reason: orderDiagnostics.ordersFetchSkippedReason,
    });
    return {
      ordersSynced: 0,
      fillsSynced: 0,
      positionsSynced: 0,
      errors: ["Credentials missing. Initialize API credentials in Settings first."],
      ordersFetchedRaw: orderDiagnostics.ordersFetchedRaw,
      ordersAfterNormalization: orderDiagnostics.ordersAfterNormalization,
      ordersPersisted: orderDiagnostics.ordersPersisted,
      ordersSkipped: orderDiagnostics.ordersSkipped,
      credentialsAvailable: orderDiagnostics.credentialsAvailable,
      ordersFetchMethod: orderDiagnostics.ordersFetchMethod,
      ordersFetchSkippedReason: orderDiagnostics.ordersFetchSkippedReason,
      fillsPagesFetched: 0,
      totalFillsInDb: 0,
    };
  }
  const funderAddress = creds.funderAddress.toLowerCase();
  orderDiagnostics.credentialsAvailable = true;
  logUserSyncOrders("credentials_available", {
    funderAddress,
    credentialsAvailable: orderDiagnostics.credentialsAvailable,
  });

  const l2Creds = {
    apiKey: creds.apiKey,
    secret: creds.secret,
    passphrase: creds.passphrase,
    funderAddress: creds.funderAddress,
    polyAddress: creds.polyAddress,
  };

  function isClobUnauthorized(msg: string): boolean {
    return msg.includes("401") || msg.includes("Unauthorized") || msg.includes("Invalid api key");
  }

  // Fetch open orders (L2 only)
  try {
    orderDiagnostics.ordersFetchMethod = "authenticated_clob_get_orders";
    logUserSyncOrders("fetch_start", {
      funderAddress,
      credentialsAvailable: orderDiagnostics.credentialsAvailable,
      ordersFetchMethod: orderDiagnostics.ordersFetchMethod,
    });

    const list = await fetchOpenOrdersL2(l2Creds);
    orderDiagnostics.ordersFetchedRaw = Array.isArray(list) ? list.length : 0;
    logUserSyncOrders("fetch_result", {
      funderAddress,
      credentialsAvailable: orderDiagnostics.credentialsAvailable,
      ordersFetchMethod: orderDiagnostics.ordersFetchMethod,
      ordersFetchedRaw: orderDiagnostics.ordersFetchedRaw,
    });
    for (const row of list) {
      const order = parseOpenOrder(row);
      if (!order) {
        orderDiagnostics.ordersSkipped += 1;
        continue;
      }
      orderDiagnostics.ordersAfterNormalization += 1;
      try {
        await prisma.userOrder.upsert({
          where: {
            funderAddress_orderId: { funderAddress, orderId: order.id },
          },
          create: {
            funderAddress,
            orderId: order.id,
            market: String(order.market ?? "").trim(),
            assetId: String(order.asset_id ?? "").trim(),
            side: order.side,
            originalSize: order.original_size,
            sizeMatched: order.size_matched,
            price: order.price,
            status: order.status,
            outcome: order.outcome ?? undefined,
          },
          update: {
            market: String(order.market ?? "").trim(),
            assetId: String(order.asset_id ?? "").trim(),
            side: order.side,
            originalSize: order.original_size,
            sizeMatched: order.size_matched,
            price: order.price,
            status: order.status,
            outcome: order.outcome ?? undefined,
            syncedAt: new Date(),
          },
        });
        orderDiagnostics.ordersPersisted += 1;
        ordersSynced++;
      } catch (e) {
        orderDiagnostics.ordersSkipped += 1;
        errors.push(e instanceof Error ? e.message : "Order upsert failed");
      }
    }
    logUserSyncOrders("normalize_result", {
      funderAddress,
      ordersFetchedRaw: orderDiagnostics.ordersFetchedRaw,
      ordersAfterNormalization: orderDiagnostics.ordersAfterNormalization,
      ordersSkipped: orderDiagnostics.ordersSkipped,
    });
    logUserSyncOrders("persist_result", {
      funderAddress,
      ordersAfterNormalization: orderDiagnostics.ordersAfterNormalization,
      ordersPersisted: orderDiagnostics.ordersPersisted,
      ordersSkipped: orderDiagnostics.ordersSkipped,
    });
  } catch (e) {
    const msg = toErrorMessage(e);
    errors.push(isClobUnauthorized(msg) ? "Credentials rejected by CLOB (invalid or expired). Re-initialize credentials in Settings." : `Orders fetch failed: ${msg}`);
    logUserSyncOrders("fetch_failed", {
      funderAddress,
      credentialsAvailable: orderDiagnostics.credentialsAvailable,
      ordersFetchMethod: orderDiagnostics.ordersFetchMethod,
      message: msg,
    });
  }

  // Fetch all trades (fills) via pagination so positions match wallet. Only clear existing fills after a successful fetch (fullResync).
  let fillsPagesFetched = 0;
  const trades: Array<{ id: string; market: string; asset_id: string; side: string; size: string; price: string; match_time?: string; outcome?: string }> = [];
  const seenTradeIds = new Set<string>();
  try {
    const { trades: rawTrades, pagesFetched } = await fetchAllTradesL2(l2Creds);
    fillsPagesFetched = pagesFetched;
    if (opts?.fullResync && rawTrades.length >= 0) {
      try {
        await prisma.userFill.deleteMany({ where: { funderAddress } });
      } catch (e) {
        errors.push(e instanceof Error ? e.message : "Failed to clear UserFill for full resync");
      }
    }
    for (const row of rawTrades) {
      const t = parseTrade(row);
      if (!t) continue;
      if (seenTradeIds.has(t.id)) continue;
      seenTradeIds.add(t.id);
      trades.push({
        id: t.id,
        market: t.market,
        asset_id: t.asset_id,
        side: t.side,
        size: t.size,
        price: t.price,
        match_time: t.match_time,
        outcome: t.outcome,
      });
      try {
        const matchTime = parsePolymarketTimestamp(t.match_time);
        await prisma.userFill.upsert({
          where: {
            funderAddress_tradeId: { funderAddress, tradeId: t.id },
          },
          create: {
            funderAddress,
            tradeId: t.id,
            market: String(t.market ?? "").trim(),
            assetId: String(t.asset_id ?? "").trim(),
            side: t.side,
            size: t.size,
            price: t.price,
            matchTime,
            outcome: t.outcome ?? undefined,
          },
          update: {
            market: String(t.market ?? "").trim(),
            assetId: String(t.asset_id ?? "").trim(),
            side: t.side,
            size: t.size,
            price: t.price,
            matchTime,
            outcome: t.outcome ?? undefined,
            syncedAt: new Date(),
          },
        });
        fillsSynced++;
      } catch (e) {
        errors.push(e instanceof Error ? e.message : "Fill upsert failed");
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to fetch trades";
    if (!errors.some((err) => err.includes("Credentials rejected by CLOB"))) {
      errors.push(isClobUnauthorized(msg) ? "Credentials rejected by CLOB (invalid or expired). Re-initialize credentials in Settings." : msg);
    }
  }

  // Best-effort positions from fills: aggregate by assetId (size signed by side). Normalize CLOB size (6 decimals) to display shares.
  const positionByAsset = new Map<
    string,
    { size: string; totalCost: string; count: number; market?: string; outcome?: string }
  >();
  for (const t of trades) {
    const mult = t.side === "BUY" ? 1 : -1;
    const sizeShares = sizeToShares(parseFloat(t.size), t.size) * mult;
    const cost = sizeShares * parseFloat(t.price);
    const existing = positionByAsset.get(t.asset_id);
    const newSize = (existing ? parseFloat(existing.size) : 0) + sizeShares;
    const newCost = (existing ? parseFloat(existing.totalCost) : 0) + cost;
    const newCount = (existing?.count ?? 0) + 1;
    positionByAsset.set(t.asset_id, {
      size: String(newSize),
      totalCost: String(newCost),
      count: newCount,
      market: t.market,
      outcome: t.outcome,
    });
  }

  for (const [assetId, pos] of Array.from(positionByAsset.entries())) {
    const sizeNum = parseFloat(pos.size);
    if (sizeNum === 0) continue;
    try {
      const avgPrice = sizeNum !== 0 ? String(Math.abs(parseFloat(pos.totalCost) / sizeNum)) : undefined;
      await prisma.userPosition.upsert({
        where: {
          funderAddress_assetId: { funderAddress, assetId },
        },
        create: {
          funderAddress,
          assetId,
          market: pos.market ?? undefined,
          outcome: pos.outcome ?? undefined,
          size: pos.size,
          avgPrice: avgPrice ?? undefined,
        },
        update: {
          market: pos.market ?? undefined,
          outcome: pos.outcome ?? undefined,
          size: pos.size,
          avgPrice: avgPrice ?? undefined,
          syncedAt: new Date(),
        },
      });
      positionsSynced++;
    } catch (e) {
      errors.push(e instanceof Error ? e.message : "Position upsert failed");
    }
  }

  const totalFillsInDb = await prisma.userFill.count({ where: { funderAddress } });

  return {
    ordersSynced,
    fillsSynced,
    positionsSynced,
    errors,
    ordersFetchedRaw: orderDiagnostics.ordersFetchedRaw,
    ordersAfterNormalization: orderDiagnostics.ordersAfterNormalization,
    ordersPersisted: orderDiagnostics.ordersPersisted,
    ordersSkipped: orderDiagnostics.ordersSkipped,
    credentialsAvailable: orderDiagnostics.credentialsAvailable,
    ordersFetchMethod: orderDiagnostics.ordersFetchMethod,
    ordersFetchSkippedReason: orderDiagnostics.ordersFetchSkippedReason,
    fillsPagesFetched,
    totalFillsInDb,
  };
}
