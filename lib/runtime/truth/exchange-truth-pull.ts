/**
 * Authoritative pull: fetch open orders and recent fills from exchange, normalize into stable
 * internal shapes, and timestamp. Used to maintain exchange-truth freshness; does not mutate
 * runtime state. Paper-safe: read-only.
 */

import { getStoredCredentials } from "@/lib/polymarket/auth";
import { fetchOpenOrdersL2, fetchTradesL2, type L2Creds } from "@/lib/polymarket/l2-readonly";
import { runWithAbortScope } from "@/lib/ops/cancellation";
import { retryWithBackoff } from "@/lib/ops/retry";
import { openOrderSchema } from "@/types/polymarket";
import { tradeSchema } from "@/types/polymarket";
import type {
  ExchangeOpenOrdersSnapshot,
  ExchangeRecentFillsSnapshot,
  NormalizedExchangeOpenOrder,
  NormalizedExchangeFill,
} from "./runtime-truth-model";
import { exchangeOrderToNormalized } from "./runtime-truth-model";
import type { ExchangeOpenOrder } from "../reconciliation/runtime-reconciliation-types";

function parseExchangeOrder(raw: unknown): ExchangeOpenOrder | null {
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

function parseExchangeFill(raw: unknown): NormalizedExchangeFill | null {
  const parsed = tradeSchema.safeParse(raw);
  if (!parsed.success) return null;
  const d = parsed.data;
  return {
    id: d.id,
    market: d.market,
    asset_id: d.asset_id,
    side: d.side,
    size: d.size,
    price: d.price,
    match_time: d.match_time,
    outcome: d.outcome,
  };
}

/**
 * Fetch open orders from exchange and return a timestamped snapshot.
 * Returns null on missing credentials or fetch error (caller can treat as unavailable).
 */
export async function fetchExchangeOpenOrdersSnapshot(opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<ExchangeOpenOrdersSnapshot | null> {
  const { credential: creds } = await getStoredCredentials();
  if (!creds) return null;

  const l2Creds: L2Creds = {
    apiKey: creds.apiKey,
    secret: creds.secret,
    passphrase: creds.passphrase,
    funderAddress: creds.funderAddress,
    polyAddress: creds.polyAddress,
  };

  try {
    const perAttemptTimeoutMs = opts?.timeoutMs ?? 15_000;
    const retriesBudget = Math.min(2, Number(process.env.EXCHANGE_TRUTH_REQUEST_RETRIES ?? "2") || 2);
    let lastErrorType: "timeout" | "aborted" | "auth" | "fetch_error" | "unknown" = "unknown";
    const { value: rawOrders, attempts } = await retryWithBackoff({
      label: "exchange_truth_open_orders",
      signal: opts?.signal,
      retries: retriesBudget,
      retryOnTimeout: true,
      baseDelayMs: 200,
      maxDelayMs: 1500,
      decide: (err, attempt) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (/timeout:/i.test(msg) || /ETIMEDOUT|timeout/i.test(msg)) lastErrorType = "timeout";
        else if (/aborted:/i.test(msg) || /AbortError/i.test(msg)) lastErrorType = "aborted";
        else if (/401|403|Unauthorized|Invalid api key/i.test(msg) || /405|Method Not Allowed/i.test(msg)) lastErrorType = "auth";
        else if (/fetch/i.test(msg) || /CLOB GET/i.test(msg)) lastErrorType = "fetch_error";
        else lastErrorType = "unknown";

        if (/401|403|Unauthorized|Invalid api key/i.test(msg) || /405|Method Not Allowed/i.test(msg)) {
          return { retry: false, reason: "auth_or_method_mismatch" };
        }
        return { retry: true, backoffMs: Math.min(1500, 200 * Math.pow(2, attempt)) };
      },
      fn: async () => {
        const res = await runWithAbortScope({
          label: "exchange_truth_open_orders_attempt",
          parentSignal: opts?.signal,
          timeoutMs: perAttemptTimeoutMs,
          fn: async (signal) => await fetchOpenOrdersL2(l2Creds, { signal }),
        });
        return res;
      },
    });
    const orders: NormalizedExchangeOpenOrder[] = [];
    for (const row of Array.isArray(rawOrders) ? rawOrders : []) {
      const o = parseExchangeOrder(row);
      if (o) orders.push(exchangeOrderToNormalized(o));
    }
    return {
      orders,
      fetchedAt: new Date(),
      source: "exchange_pull",
      fetchDiagnostics: { attempts, perAttemptTimeoutMs, lastErrorType },
    };
  } catch {
    return null;
  }
}

/**
 * Fetch recent fills (first page of trades) from exchange and return a timestamped snapshot.
 * Returns null on missing credentials or fetch error.
 */
export async function fetchExchangeRecentFillsSnapshot(opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<ExchangeRecentFillsSnapshot | null> {
  const { credential: creds } = await getStoredCredentials();
  if (!creds) return null;

  const l2Creds: L2Creds = {
    apiKey: creds.apiKey,
    secret: creds.secret,
    passphrase: creds.passphrase,
    funderAddress: creds.funderAddress,
    polyAddress: creds.polyAddress,
  };

  try {
    const perAttemptTimeoutMs = opts?.timeoutMs ?? 15_000;
    const retriesBudget = Math.min(2, Number(process.env.EXCHANGE_TRUTH_REQUEST_RETRIES ?? "2") || 2);
    let lastErrorType: "timeout" | "aborted" | "auth" | "fetch_error" | "unknown" = "unknown";
    const { value: rawTrades, attempts } = await retryWithBackoff({
      label: "exchange_truth_recent_fills",
      signal: opts?.signal,
      retries: retriesBudget,
      retryOnTimeout: true,
      baseDelayMs: 200,
      maxDelayMs: 1500,
      decide: (err, attempt) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (/timeout:/i.test(msg) || /ETIMEDOUT|timeout/i.test(msg)) lastErrorType = "timeout";
        else if (/aborted:/i.test(msg) || /AbortError/i.test(msg)) lastErrorType = "aborted";
        else if (/401|403|Unauthorized|Invalid api key/i.test(msg) || /405|Method Not Allowed/i.test(msg)) lastErrorType = "auth";
        else if (/fetch/i.test(msg) || /CLOB GET/i.test(msg)) lastErrorType = "fetch_error";
        else lastErrorType = "unknown";

        if (/401|403|Unauthorized|Invalid api key/i.test(msg) || /405|Method Not Allowed/i.test(msg)) {
          return { retry: false, reason: "auth_or_method_mismatch" };
        }
        return { retry: true, backoffMs: Math.min(1500, 200 * Math.pow(2, attempt)) };
      },
      fn: async () => {
        const res = await runWithAbortScope({
          label: "exchange_truth_recent_fills_attempt",
          parentSignal: opts?.signal,
          timeoutMs: perAttemptTimeoutMs,
          fn: async (signal) => await fetchTradesL2(l2Creds, { signal }),
        });
        return res;
      },
    });
    const fills: NormalizedExchangeFill[] = [];
    for (const row of Array.isArray(rawTrades) ? rawTrades : []) {
      const f = parseExchangeFill(row);
      if (f) fills.push(f);
    }
    return {
      fills,
      fetchedAt: new Date(),
      source: "exchange_pull",
      fetchDiagnostics: { attempts, perAttemptTimeoutMs, lastErrorType },
    };
  } catch {
    return null;
  }
}

/**
 * Fetch both open orders and recent fills in one pass (two API calls).
 * Convenience for periodic truth refresh; returns whichever succeeded (or null for each on error).
 */
export async function fetchExchangeTruthSnapshots(): Promise<{
  orders: ExchangeOpenOrdersSnapshot | null;
  fills: ExchangeRecentFillsSnapshot | null;
}> {
  const [orders, fills] = await Promise.all([
    fetchExchangeOpenOrdersSnapshot(),
    fetchExchangeRecentFillsSnapshot(),
  ]);
  return { orders, fills };
}
