/**
 * Polymarket user sync: fetch open orders, trades (fills), build position snapshots; upsert to DB.
 * Read-only; no trading. Uses stored L2 credentials only (no POLYMARKET_SIGNER_PRIVATE_KEY).
 * Positions are reconstructed from fills when no direct positions endpoint is used.
 */

import { prisma } from "@/lib/db";
import { getStoredCredentials } from "@/lib/polymarket/auth";
import {
  clobGetWithL2Raw,
  GET_DATA_ORDERS,
  DATA_ORDERS_INITIAL_CURSOR,
  GET_TRADES,
} from "@/lib/polymarket/l2-readonly";
import { sizeToShares } from "@/lib/polymarket/portfolio";
import { openOrderSchema, tradeSchema } from "@/types/polymarket";
import { z } from "zod";
import { runWithAbortScope, throwIfAborted } from "@/lib/ops/cancellation";
import { retryWithBackoff } from "@/lib/ops/retry";

export type UserOrderSyncDiagnostics = {
  credentialsAvailable: boolean;
  ordersFetchMethod: string | null;
  /** Helper used for open-orders fetch (same as startup rebuild: clobGetWithL2Raw). */
  ordersFetchHelper: string | null;
  ordersRequestPath: string | null;
  ordersStatus: number | null;
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
  /** Helper used for orders fetch (same as startup rebuild). */
  ordersFetchHelper: string | null;
  ordersRequestPath: string | null;
  ordersStatus: number | null;
  /** Pages of trades fetched from CLOB (paginated). */
  fillsPagesFetched: number;
  /** Total UserFill rows in DB for this funder after sync. */
  totalFillsInDb: number;
  /** Fills/trades fetch diagnostics (endpoint, requestPath, status, body snippet). */
  fillsFetchHelper: string | null;
  fillsEndpoint: string | null;
  fillsRequestPath: string | null;
  fillsStatus: number | null;
  fillsBodySnippet: string | null;
  fillsPaginationAttempted: boolean;
  fillsPagesFetched: number;
  /** When fills fail: auth | method_mismatch | server | other. */
  fillsClassification: string | null;
  /** True when pagination stopped because next_cursor was null/empty/LTE= (end sentinel), not due to error. */
  fillsPaginationTerminatedNormally: boolean;
  /** Last next_cursor value from API (e.g. "LTE=" = end; null = none). */
  fillsLastNextCursorSeen: string | null;
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
export async function syncUser(opts?: {
  fullResync?: boolean;
  /** Hard cap pages fetched per run to keep job bounded; subsequent runs continue freshness. */
  maxTradesPages?: number;
  /** Per-request timeout for CLOB fetches. */
  requestTimeoutMs?: number;
  /** Retries for transient network/server errors (exponential-ish backoff). */
  requestRetries?: number;
  /** Optional cancellation signal from job runner. */
  signal?: AbortSignal;
}): Promise<SyncUserResult> {
  const errors: string[] = [];
  let ordersSynced = 0;
  let fillsSynced = 0;
  let positionsSynced = 0;
  const orderDiagnostics: UserOrderSyncDiagnostics = {
    credentialsAvailable: false,
    ordersFetchMethod: null,
    ordersFetchHelper: null,
    ordersRequestPath: null,
    ordersStatus: null,
    ordersFetchedRaw: 0,
    ordersAfterNormalization: 0,
    ordersPersisted: 0,
    ordersSkipped: 0,
    ordersFetchSkippedReason: null,
  };

  const { credential: creds } = await getStoredCredentials();
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
      ordersFetchHelper: null,
      ordersRequestPath: null,
      ordersStatus: null,
      fillsPagesFetched: 0,
      totalFillsInDb: 0,
      fillsFetchHelper: null,
      fillsEndpoint: null,
      fillsRequestPath: null,
      fillsStatus: null,
      fillsBodySnippet: null,
      fillsPaginationAttempted: false,
      fillsClassification: null,
      fillsPaginationTerminatedNormally: false,
      fillsLastNextCursorSeen: null,
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

  const requestTimeoutMs = Number(opts?.requestTimeoutMs ?? 0) > 0 ? Number(opts?.requestTimeoutMs) : 20_000;
  const requestRetries = Number(opts?.requestRetries ?? 0) >= 0 ? Number(opts?.requestRetries) : 2;
  const maxTradesPages = Number(opts?.maxTradesPages ?? 0) > 0 ? Number(opts?.maxTradesPages) : 3;

  /** Classify CLOB error for user-facing message: 405 = method/endpoint mismatch, 401/403 = auth, 5xx = server. */
  function classifyClobError(msg: string): "auth" | "method_mismatch" | "server" | "other" {
    if (/405|Method Not Allowed/i.test(msg)) return "method_mismatch";
    if (/401|403|Unauthorized|Invalid api key/i.test(msg)) return "auth";
    if (/5\d{2}|Server Error|ECONNREFUSED|ETIMEDOUT/i.test(msg)) return "server";
    return "other";
  }

  async function clobGetAbortableWithRetry(
    endpoint: string,
    params: Record<string, string>
  ): Promise<{ requestPath: string; status: number; body: string; retriesAttempted: number }> {
    const parentSignal = opts?.signal;
    const { value, attempts } = await retryWithBackoff({
      label: `user_sync:${endpoint}`,
      signal: parentSignal,
      retries: requestRetries,
      decide: (err, attempt) => {
        const msg = toErrorMessage(err);
        const cls = classifyClobError(msg);
        if (cls === "auth" || cls === "method_mismatch") return { retry: false, reason: cls };
        return { retry: attempt < requestRetries, backoffMs: Math.min(2500, 250 * Math.pow(2, attempt)) };
      },
      fn: async () => {
        // Per-request deadline that ACTUALLY aborts fetch via AbortController.
        return await runWithAbortScope({
          label: `clob_get:${endpoint}`,
          parentSignal,
          timeoutMs: requestTimeoutMs,
          fn: async (signal) => await clobGetWithL2Raw(l2Creds, endpoint, params, { signal }),
        });
      },
    });
    return { ...value, retriesAttempted: Math.max(0, attempts - 1) };
  }

  // Fetch open orders via same helper as startup rebuild: clobGetWithL2Raw(GET_DATA_ORDERS, next_cursor) — path-only signing
  const ordersFetchHelper = "clobGetWithL2Raw";
  orderDiagnostics.ordersFetchMethod = "authenticated_clob_get_data_orders";
  orderDiagnostics.ordersFetchHelper = ordersFetchHelper;
  logUserSyncOrders("fetch_start", {
    funderAddress,
    credentialsAvailable: orderDiagnostics.credentialsAvailable,
    ordersFetchMethod: orderDiagnostics.ordersFetchMethod,
    ordersFetchHelper,
    endpoint: GET_DATA_ORDERS,
  });

  throwIfAborted(opts?.signal, "user_sync");
  const rawOrders = await clobGetAbortableWithRetry(GET_DATA_ORDERS, { next_cursor: DATA_ORDERS_INITIAL_CURSOR });
  orderDiagnostics.ordersRequestPath = rawOrders.requestPath;
  orderDiagnostics.ordersStatus = rawOrders.status;

  const bodySnippet =
    rawOrders.body && rawOrders.body.length > 200
      ? `${rawOrders.body.slice(0, 200)}...`
      : rawOrders.body || null;
  logUserSyncOrders("fetch_result", {
    funderAddress,
    ordersFetchHelper,
    endpoint: GET_DATA_ORDERS,
    requestPath: rawOrders.requestPath,
    status: rawOrders.status,
    bodySnippet,
    paginationAttempted: false,
    retriesAttempted: rawOrders.retriesAttempted,
  });

  if (rawOrders.status !== 200) {
    const msg = `CLOB GET ${GET_DATA_ORDERS} failed: ${rawOrders.status} ${rawOrders.body ? rawOrders.body.slice(0, 150) : ""}`;
    const classification = classifyClobError(msg);
    if (classification === "auth") {
      errors.push("Credentials rejected by CLOB (invalid or expired). Re-initialize credentials in Settings.");
    } else if (classification === "method_mismatch") {
      errors.push(`Open-orders request failed: method not allowed (405). The app uses GET ${GET_DATA_ORDERS}.`);
    } else if (classification === "server") {
      errors.push("Orders fetch failed: CLOB or network error. Try again later.");
    } else {
      errors.push(`Orders fetch failed: ${msg}`);
    }
    logUserSyncOrders("fetch_failed", {
      funderAddress,
      ordersFetchHelper,
      endpoint: GET_DATA_ORDERS,
      requestPath: rawOrders.requestPath,
      status: rawOrders.status,
      classification,
      message: msg,
    });
  } else {
    let list: unknown[] = [];
    try {
      const parsed = JSON.parse(rawOrders.body || "{}") as { data?: unknown[] };
      list = Array.isArray(parsed?.data) ? parsed.data : [];
    } catch {
      list = [];
    }
    orderDiagnostics.ordersFetchedRaw = list.length;
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
  }

  // Fills/trades: GET /data/trades. First page no params (signed requestPath = "/data/trades"); later pages next_cursor in URL (signed path+query). Same helper as orders: clobGetWithL2Raw.
  const fillsFetchHelper = "clobGetWithL2Raw";
  let fillsPagesFetched = 0;
  let fillsEndpoint: string | null = GET_TRADES;
  let fillsRequestPath: string | null = null;
  let fillsStatus: number | null = null;
  let fillsBodySnippet: string | null = null;
  let fillsPaginationAttempted = false;
  let fillsClassification: string | null = null;
  let fillsLastNextCursorSeen: string | null = null;
  const trades: Array<{ id: string; market: string; asset_id: string; side: string; size: string; price: string; match_time?: string; outcome?: string }> = [];
  const seenTradeIds = new Set<string>();

  /** Polymarket end-of-pagination sentinel (SDK END_CURSOR). Do not request another page with this value. */
  const TRADES_END_CURSOR = "LTE=";
  function parseTradesNextCursor(raw: unknown): string | null {
    if (raw == null) return null;
    if (typeof raw !== "string") return null;
    const s = raw.trim();
    if (s === "" || s === TRADES_END_CURSOR) return null;
    return s;
  }

  logUserSyncOrders("trades_fetch_start", { funderAddress, fillsFetchHelper, fillsEndpoint: GET_TRADES });
  let cursor: string | null = null;
  let fillsFailed = false;
  while (true) {
    const pageNumber = fillsPagesFetched + 1;
    if (pageNumber > maxTradesPages) {
      logUserSyncOrders("trades_fetch_bounded_stop", { funderAddress, pageNumber, maxTradesPages });
      break;
    }
    const isFirstPage = cursor === null;
    const params: Record<string, string> = isFirstPage ? {} : { next_cursor: cursor };
    fillsPaginationAttempted = pageNumber > 1;

    throwIfAborted(opts?.signal, "user_sync:trades_loop");
    const rawTrades = await clobGetAbortableWithRetry(GET_TRADES, params);
    if (fillsRequestPath == null) {
      fillsRequestPath = rawTrades.requestPath;
      fillsStatus = rawTrades.status;
      fillsBodySnippet =
        rawTrades.body && rawTrades.body.length > 200
          ? `${rawTrades.body.slice(0, 200)}...`
          : rawTrades.body || null;
    }
    if (rawTrades.status !== 200) {
      fillsStatus = rawTrades.status;
      fillsRequestPath = rawTrades.requestPath;
      fillsBodySnippet =
        rawTrades.body && rawTrades.body.length > 200
          ? `${rawTrades.body.slice(0, 200)}...`
          : rawTrades.body || null;
      fillsClassification = classifyClobError(
        `CLOB GET ${GET_TRADES} failed: ${rawTrades.status} ${rawTrades.body ? rawTrades.body.slice(0, 150) : ""}`
      );
      logUserSyncOrders("trades_fetch_failed", {
        funderAddress,
        fillsFetchHelper,
        fillsEndpoint: GET_TRADES,
        fillsRequestPath: rawTrades.requestPath,
        fillsStatus: rawTrades.status,
        fillsClassification,
        pageNumber,
        isFirstPage,
      });
      if (fillsClassification === "auth") {
        errors.push("Credentials rejected by CLOB (invalid or expired). Re-initialize credentials in Settings.");
      } else if (fillsClassification === "method_mismatch") {
        errors.push("Trades request failed: method not allowed (405).");
      } else if (fillsClassification === "server") {
        errors.push("Trades fetch failed: CLOB or network error. Try again later.");
      } else {
        errors.push(`Trades fetch failed: GET ${GET_TRADES} returned ${rawTrades.status}.`);
      }
      fillsFailed = true;
      break;
    }
    fillsPagesFetched++;
    let parsed: { data?: unknown[]; next_cursor?: unknown };
    try {
      parsed = JSON.parse(rawTrades.body || "{}") as { data?: unknown[]; next_cursor?: unknown };
    } catch {
      parsed = { data: [] };
    }
    const data = Array.isArray(parsed?.data) ? parsed.data : [];
    fillsLastNextCursorSeen =
      typeof parsed?.next_cursor === "string" ? parsed.next_cursor.trim() || null : null;
    logUserSyncOrders("trades_fetch_page", {
      funderAddress,
      fillsFetchHelper,
      fillsEndpoint: GET_TRADES,
      requestPath: rawTrades.requestPath,
      status: rawTrades.status,
      pageNumber,
      isFirstPage,
      tradeCount: data.length,
    });
    if (isFirstPage && opts?.fullResync) {
      try {
        await prisma.userFill.deleteMany({ where: { funderAddress } });
      } catch (e) {
        errors.push(e instanceof Error ? e.message : "Failed to clear UserFill for full resync");
      }
    }
    for (const row of data) {
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
    const next = parseTradesNextCursor(parsed?.next_cursor);
    if (next == null || data.length === 0) break;
    cursor = next;
  }
  const fillsPaginationTerminatedNormally = !fillsFailed;
  logUserSyncOrders("trades_fetch_result", {
    funderAddress,
    fillsFetchHelper,
    fillsEndpoint: GET_TRADES,
    fillsRequestPath,
    fillsStatus,
    fillsPaginationAttempted,
    fillsPagesFetched,
    fillsClassification,
    fillsPaginationTerminatedNormally,
    fillsLastNextCursorSeen,
    tradeCount: trades.length,
    fillsFailed,
  });

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
    ordersFetchHelper: orderDiagnostics.ordersFetchHelper,
    ordersRequestPath: orderDiagnostics.ordersRequestPath,
    ordersStatus: orderDiagnostics.ordersStatus,
    fillsPagesFetched,
    totalFillsInDb,
    fillsFetchHelper,
    fillsEndpoint,
    fillsRequestPath,
    fillsStatus,
    fillsBodySnippet,
    fillsPaginationAttempted,
    fillsClassification,
    fillsPaginationTerminatedNormally,
    fillsLastNextCursorSeen,
  };
}
