/**
 * Runtime reconciliation service: fetch exchange open orders (authoritative pull), compare with
 * runtime order lifecycle store. Truth hierarchy: exchange snapshot > durable ledger > runtime memory.
 * This comparison is explicit: authoritative exchange snapshot vs runtime stores; fill ledger is
 * used separately for replay/rebuild. Paper-safe: emits diagnostics, produces repair recommendations,
 * optionally applies in-memory repairs only. Does NOT place or cancel orders on the exchange.
 */

import { getStoredCredentials } from "@/lib/polymarket/auth";
import { fetchOpenOrdersL2 } from "@/lib/polymarket/l2-readonly";
import { runWithAbortScope } from "@/lib/ops/cancellation";
import { retryWithBackoff } from "@/lib/ops/retry";
import type { OrderLifecycleStore } from "../order-manager/order-lifecycle-store";
import type { RuntimeOrderState } from "../order-manager/order-manager";
import {
  type RuntimeReconciliationResult,
  type ExchangeOpenOrder,
  type RepairRecommendation,
  EMPTY_RECONCILIATION_RESULT,
} from "./runtime-reconciliation-types";
import { openOrderSchema } from "@/types/polymarket";
import type { AppendOrderLifecycleEventParams } from "../journal/order-lifecycle-journal";
import { ORDER_LIFECYCLE_EVENT_TYPES } from "../journal/order-lifecycle-journal";

const OPEN_STATUSES = ["working", "partially_filled", "pending_cancel"] as const;

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

function parseNum(s: string | null | undefined): number {
  if (s == null || s === "") return 0;
  const n = parseFloat(String(s).trim());
  return Number.isFinite(n) ? n : 0;
}

/**
 * Pure comparison: given exchange order ids and local open orders, compute missing local, missing exchange, and stale working.
 * Used by runRuntimeReconciliation and by tests without needing to mock fetch.
 */
export function compareRuntimeWithExchange(
  exchangeOrderIds: Set<string>,
  localOpenOrders: RuntimeOrderState[]
): {
  missingLocalOrders: string[];
  missingExchangeOrders: RuntimeOrderState[];
  staleWorkingOrders: RuntimeOrderState[];
} {
  const localByExchangeId = new Map<string, RuntimeOrderState>();
  for (const o of localOpenOrders) {
    if (o.exchangeOrderId) localByExchangeId.set(o.exchangeOrderId, o);
  }
  const missingLocalOrders: string[] = [];
  for (const id of exchangeOrderIds) {
    if (!localByExchangeId.has(id)) missingLocalOrders.push(id);
  }
  const missingExchangeOrders: RuntimeOrderState[] = [];
  const staleWorkingOrders: RuntimeOrderState[] = [];
  for (const o of localOpenOrders) {
    if (!o.exchangeOrderId) continue;
    if (o.status === "pending_submit") continue;
    if (!exchangeOrderIds.has(o.exchangeOrderId)) {
      missingExchangeOrders.push(o);
      if (o.status === "working" || o.status === "partially_filled") staleWorkingOrders.push(o);
    }
  }
  return { missingLocalOrders, missingExchangeOrders, staleWorkingOrders };
}

export interface RuntimeReconciliationInput {
  funderAddress: string;
  orderStore: OrderLifecycleStore;
  /** If true, apply in-memory repairs: mark local working orders as canceled when absent on exchange. */
  applyRepairs?: boolean;
  /** When set, repair_recommended and repair_applied are journaled. */
  journalAppend?: (params: AppendOrderLifecycleEventParams) => void | Promise<void>;
  /** When set, called for each applied repair so durable ledger can reflect status (e.g. ExecutedOrder CANCELED). */
  onRepairApplied?: (params: { exchangeOrderId: string; repairKind: string }) => void | Promise<void>;
  /** Optional: cancellation/timeout propagated from caller. */
  signal?: AbortSignal;
  /** Optional: hard timeout for the exchange fetch (ms). */
  exchangeFetchTimeoutMs?: number;
}

/**
 * Run one reconciliation: fetch open orders from exchange, compare with orderStore, detect drift, optionally apply repairs.
 */
export async function runRuntimeReconciliation(input: RuntimeReconciliationInput): Promise<RuntimeReconciliationResult> {
  const start = Date.now();
  const asOf = new Date();
  const { funderAddress, orderStore, applyRepairs = false, journalAppend, onRepairApplied } = input;
  let exchangeOpenOrdersFetchDiagnostics: RuntimeReconciliationResult["exchangeOpenOrdersFetchDiagnostics"] = null;

  try {
    const { credential: creds } = await getStoredCredentials();
    if (!creds) {
      return {
        ...EMPTY_RECONCILIATION_RESULT(asOf),
        success: false,
        error: "No stored credentials",
        reconcileDurationMs: Date.now() - start,
      };
    }

    const l2Creds = {
      apiKey: creds.apiKey,
      secret: creds.secret,
      passphrase: creds.passphrase,
      funderAddress: creds.funderAddress,
      polyAddress: creds.polyAddress,
    };

    const perAttemptTimeoutMs =
      (input.exchangeFetchTimeoutMs ?? Number(process.env.EXCHANGE_TRUTH_REQUEST_TIMEOUT_MS ?? "15000")) || 15_000;
    const retriesBudget = Math.min(2, Number(process.env.EXCHANGE_TRUTH_REQUEST_RETRIES ?? "2") || 2); // total attempts <= 3
    let lastAttemptCount = 0;
    let lastErrorType: "timeout" | "aborted" | "auth" | "fetch_error" | "unknown" = "unknown";

    function classifyErr(err: unknown): typeof lastErrorType {
      const msg = err instanceof Error ? err.message : String(err);
      if (/timeout:/i.test(msg) || /ETIMEDOUT|timeout/i.test(msg)) return "timeout";
      if (/aborted:/i.test(msg) || /AbortError/i.test(msg)) return "aborted";
      if (/401|403|Unauthorized|Invalid api key/i.test(msg) || /405|Method Not Allowed/i.test(msg)) return "auth";
      if (/fetch/i.test(msg) || /CLOB GET/i.test(msg) || /ECONNREFUSED|ENOTFOUND|ECONNRESET/i.test(msg)) return "fetch_error";
      return "unknown";
    }

    const rawOrders = await (async () => {
      try {
        const res = await retryWithBackoff({
          label: "runtime_reconciliation_exchange_open_orders",
          signal: input.signal,
          retries: retriesBudget,
          retryOnTimeout: true,
          baseDelayMs: 250,
          maxDelayMs: 2000,
          decide: (err, attempt) => {
            lastAttemptCount = attempt + 1;
            lastErrorType = classifyErr(err);
            const msg = err instanceof Error ? err.message : String(err);
            // Do not retry on obvious auth/method mismatch.
            if (/401|403|Unauthorized|Invalid api key/i.test(msg) || /405|Method Not Allowed/i.test(msg)) {
              return { retry: false, reason: "auth_or_method_mismatch" };
            }
            // Retry only when we still have budget left (retryWithBackoff enforces attempt < retries).
            return { retry: true, backoffMs: Math.min(2000, 250 * Math.pow(2, attempt)) };
          },
          fn: async () => {
            return await runWithAbortScope({
              label: "runtime_reconciliation_fetch_open_orders_attempt",
              parentSignal: input.signal,
              timeoutMs: perAttemptTimeoutMs,
              fn: async (signal) => await fetchOpenOrdersL2(l2Creds, { signal }),
            });
          },
        });
        exchangeOpenOrdersFetchDiagnostics = {
          attempts: res.attempts,
          perAttemptTimeoutMs,
          lastErrorType: undefined,
        };
        return res.value;
      } catch (e) {
        exchangeOpenOrdersFetchDiagnostics = {
          attempts: lastAttemptCount || 1,
          perAttemptTimeoutMs,
          lastErrorType,
        };
        throw e;
      }
    })();
    const exchangeOrders: ExchangeOpenOrder[] = [];
    for (const row of Array.isArray(rawOrders) ? rawOrders : []) {
      const o = parseExchangeOrder(row);
      if (o) exchangeOrders.push(o);
    }
    const exchangeIds = new Set(exchangeOrders.map((o) => o.id));

    const allLocal = orderStore.getAll();
    const localOpen = allLocal.filter(
      (o) => o.status === "working" || o.status === "partially_filled" || o.status === "pending_cancel" || o.status === "pending_submit"
    );
    const { missingLocalOrders, missingExchangeOrders, staleWorkingOrders } = compareRuntimeWithExchange(
      exchangeIds,
      localOpen
    );

    const missingFills: RuntimeReconciliationResult["missingFills"] = [];
    const exchangeById = new Map(exchangeOrders.map((o) => [o.id, o]));
    const localByExchangeId = new Map<string, RuntimeOrderState>();
    for (const o of localOpen) {
      if (o.exchangeOrderId) localByExchangeId.set(o.exchangeOrderId, o);
    }
    for (const o of localOpen) {
      if (!o.exchangeOrderId) continue;
      const ex = exchangeById.get(o.exchangeOrderId);
      if (!ex) continue;
      const localFilled = o.filledSize ?? 0;
      const exchangeMatched = parseNum(ex.size_matched);
      if (Math.abs(localFilled - exchangeMatched) > 1e-6) {
        missingFills.push({
          clientOrderId: o.clientOrderId,
          exchangeOrderId: o.exchangeOrderId,
          assetId: o.assetId,
          marketId: o.marketId,
          side: o.side,
          localStatus: o.status,
          localFilledSize: localFilled,
          exchangeSizeMatched: exchangeMatched,
        });
      }
    }

    const repairRecommendations: RepairRecommendation[] = [];
    for (const o of staleWorkingOrders) {
      repairRecommendations.push({
        kind: "mark_local_canceled",
        clientOrderId: o.clientOrderId,
        exchangeOrderId: o.exchangeOrderId!,
        assetId: o.assetId,
        marketId: o.marketId,
        reason: "Local working order absent on exchange",
      });
      if (journalAppend) {
        void journalAppend({
          funderAddress: o.funderAddress,
          clientOrderId: o.clientOrderId,
          exchangeOrderId: o.exchangeOrderId,
          intentId: o.intentId,
          assetId: o.assetId,
          marketId: o.marketId,
          side: o.side,
          eventType: ORDER_LIFECYCLE_EVENT_TYPES.REPAIR_RECOMMENDED,
          payloadJson: JSON.stringify({ kind: "mark_local_canceled", reason: "Local working order absent on exchange" }),
          occurredAt: asOf,
        }).catch(() => {});
      }
    }
    for (const exchangeId of missingLocalOrders) {
      const ex = exchangeById.get(exchangeId);
      repairRecommendations.push({
        kind: "sync_order_from_exchange",
        exchangeOrderId: exchangeId,
        assetId: ex?.asset_id,
        marketId: ex?.market,
        reason: "Exchange order not in runtime store",
      });
      if (journalAppend) {
        void journalAppend({
          funderAddress,
          exchangeOrderId: exchangeId,
          assetId: ex?.asset_id ?? "",
          marketId: ex?.market ?? "",
          side: ex?.side ?? "",
          eventType: ORDER_LIFECYCLE_EVENT_TYPES.REPAIR_RECOMMENDED,
          payloadJson: JSON.stringify({ kind: "sync_order_from_exchange", reason: "Exchange order not in runtime store" }),
          occurredAt: asOf,
        }).catch(() => {});
      }
    }

    const repairedOrders: string[] = [];
    const repairedExchangeImports = new Set<string>();
    const repairedFillAlign = new Set<string>();
    if (applyRepairs) {
      for (const o of staleWorkingOrders) {
        orderStore.updateStatus(o.clientOrderId, "canceled");
        repairedOrders.push(o.clientOrderId);
        if (journalAppend) {
          void journalAppend({
            funderAddress: o.funderAddress,
            clientOrderId: o.clientOrderId,
            exchangeOrderId: o.exchangeOrderId,
            intentId: o.intentId,
            assetId: o.assetId,
            marketId: o.marketId,
            side: o.side,
            eventType: ORDER_LIFECYCLE_EVENT_TYPES.REPAIR_APPLIED,
            payloadJson: JSON.stringify({ reason: "mark_local_canceled" }),
            occurredAt: asOf,
          }).catch(() => {});
        }
        if (onRepairApplied && o.exchangeOrderId) {
          void Promise.resolve(onRepairApplied({ exchangeOrderId: o.exchangeOrderId, repairKind: "mark_local_canceled" })).catch(() => {});
        }
      }

      // Safe import: when exchange has a working order that runtime lacks, add it to the in-memory store.
      // This has no exchange side effects and reduces false-positive drift after restarts.
      for (const exchangeId of missingLocalOrders) {
        if (localByExchangeId.has(exchangeId)) continue;
        const ex = exchangeById.get(exchangeId);
        if (!ex) continue;
        const size = parseNum(ex.original_size);
        const matched = parseNum(ex.size_matched);
        const price = parseNum(ex.price);
        if (size <= 0) continue;
        const clientOrderId = `reconcile_import:${exchangeId}`;
        try {
          orderStore.create({
            clientOrderId,
            funderAddress: funderAddress.toLowerCase(),
            assetId: ex.asset_id,
            marketId: ex.market,
            side: (String(ex.side).toUpperCase() as "BUY" | "SELL") === "SELL" ? "SELL" : "BUY",
            price,
            size,
          });
          orderStore.applyAck(clientOrderId, exchangeId);
          if (matched > 0) {
            // Apply delta from 0 up to matched.
            orderStore.applyPartialFill(clientOrderId, matched, price);
          }
          repairedOrders.push(clientOrderId);
          repairedExchangeImports.add(exchangeId);
          if (onRepairApplied) {
            void Promise.resolve(onRepairApplied({ exchangeOrderId, repairKind: "sync_order_from_exchange" })).catch(() => {});
          }
        } catch {
          // Fail closed: leave drift detected if import fails.
        }
      }

      // Safe fill alignment: if exchange reports more matched size than runtime, advance local filledSize.
      for (const d of missingFills) {
        const delta = d.exchangeSizeMatched - d.localFilledSize;
        if (delta <= 0) continue;
        try {
          orderStore.applyPartialFill(d.clientOrderId, delta, 0);
          repairedFillAlign.add(d.exchangeOrderId);
        } catch {
          // Ignore; drift will remain until next event/rebuild.
        }
      }
    }

    const remainingMissingLocalOrders = applyRepairs
      ? missingLocalOrders.filter((id) => !repairedExchangeImports.has(id))
      : missingLocalOrders;
    const remainingMissingFills = applyRepairs
      ? missingFills.filter((d) => !repairedFillAlign.has(d.exchangeOrderId))
      : missingFills;

    // If we applied repairs, some missingExchangeOrders may have been canceled.
    // We must compute drift against the remaining mismatches, otherwise driftDetected
    // can stay true forever even as repairs successfully reduce runtime drift signals.
    const repairedOrdersSet = new Set(repairedOrders);
    const remainingMissingExchangeOrders = applyRepairs
      ? missingExchangeOrders.filter((o) => !repairedOrdersSet.has(o.clientOrderId))
      : missingExchangeOrders;

    const driftDetected =
      remainingMissingLocalOrders.length > 0 ||
      remainingMissingExchangeOrders.length > 0 ||
      remainingMissingFills.length > 0;

    return {
      success: true,
      asOf,
      reconcileDurationMs: Date.now() - start,
      missingLocalOrders: remainingMissingLocalOrders,
      missingExchangeOrders: remainingMissingExchangeOrders,
      staleWorkingOrders,
      missingFills: remainingMissingFills,
      repairedOrders,
      repairedPositions: [],
      driftDetected,
      repairRecommendations,
      exchangeOpenOrdersFetchDiagnostics,
    };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return {
      ...EMPTY_RECONCILIATION_RESULT(asOf),
      success: false,
      error,
      reconcileDurationMs: Date.now() - start,
      exchangeOpenOrdersFetchDiagnostics,
    };
  }
}
