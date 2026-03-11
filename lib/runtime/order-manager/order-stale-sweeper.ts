/**
 * Stale order sweeper: identifies orders that need maintenance (no ack, too old,
 * far from desired posture, unknown status) and produces cancel/recommendations.
 * Paper mode: emits order.stale and can apply cancel via lifecycle handler.
 */

import type { RuntimeEventBus } from "../events/runtime-event-bus";
import { createRuntimeEventId } from "../events/runtime-events";
import type { OrderStalePayload } from "../events/runtime-events";
import type { OrderIntent } from "./order-manager";
import type { RuntimeOrderState } from "./order-manager";
import type { OrderLifecycleStore } from "./order-lifecycle-store";
import type { OrderLifecycleHandler } from "./order-lifecycle-handler";

export type StaleReason =
  | "pending_submit_no_ack"
  | "working_too_old"
  | "far_from_desired_posture"
  | "unknown_status"
  | "inconsistent";

export interface StaleOrderRecommendation {
  clientOrderId: string;
  action: "cancel" | "mark_stale";
  reason: StaleReason;
  detail?: string;
  order: RuntimeOrderState;
}

export interface OrderStaleSweeperConfig {
  /** Treat pending_submit with no ack after this ms as stale (default 30_000). */
  pendingSubmitAckThresholdMs?: number;
  /** Treat working/partially_filled with no activity after this ms as stale (default 120_000). */
  workingStaleMs?: number;
  /** If true, compare working orders to desired intents and mark far-from-posture (default false). */
  checkDesiredPosture?: boolean;
  /** Price tolerance for "matches desired" (default 1e-6). */
  priceTolerance?: number;
  /** Size tolerance for "matches desired" (default 1e-6). */
  sizeTolerance?: number;
}

const DEFAULT_PENDING_ACK_MS = 30_000;
const DEFAULT_WORKING_STALE_MS = 120_000;
const PRICE_EPS = 1e-6;
const SIZE_EPS = 1e-6;

export interface OrderStaleSweeper {
  /** Run sweep; return recommendations. */
  sweep(now?: Date): StaleOrderRecommendation[];
  /** Run sweep, emit order.stale events, and optionally apply cancel via handler (paper mode). */
  sweepAndApply(now?: Date): StaleOrderRecommendation[];
}

export interface DefaultOrderStaleSweeperOptions {
  store: OrderLifecycleStore;
  eventBus?: RuntimeEventBus;
  /** If set, sweepAndApply will call applyCancelAck for cancel recommendations (paper mode). */
  lifecycleHandler?: OrderLifecycleHandler;
  config?: OrderStaleSweeperConfig;
  /** Optional: return current intents for "far from desired posture" check. */
  getDesiredIntents?(): OrderIntent[];
}

/**
 * Identifies stale orders and produces recommendations. Can emit order.stale and
 * apply cancels in paper mode via lifecycle handler.
 */
export class DefaultOrderStaleSweeper implements OrderStaleSweeper {
  private readonly store: OrderLifecycleStore;
  private readonly eventBus?: RuntimeEventBus;
  private readonly lifecycleHandler?: OrderLifecycleHandler;
  private readonly config: Required<OrderStaleSweeperConfig>;

  constructor(options: DefaultOrderStaleSweeperOptions) {
    this.store = options.store;
    this.eventBus = options.eventBus;
    this.lifecycleHandler = options.lifecycleHandler;
    this.config = {
      pendingSubmitAckThresholdMs: options.config?.pendingSubmitAckThresholdMs ?? DEFAULT_PENDING_ACK_MS,
      workingStaleMs: options.config?.workingStaleMs ?? DEFAULT_WORKING_STALE_MS,
      checkDesiredPosture: options.config?.checkDesiredPosture ?? false,
      priceTolerance: options.config?.priceTolerance ?? PRICE_EPS,
      sizeTolerance: options.config?.sizeTolerance ?? SIZE_EPS,
    };
    this.getDesiredIntents = options.getDesiredIntents;
  }

  private readonly getDesiredIntents?: () => OrderIntent[];

  sweep(now: Date = new Date()): StaleOrderRecommendation[] {
    const recs: StaleOrderRecommendation[] = [];

    const pendingStale = this.store.getPendingSubmitOlderThan(
      this.config.pendingSubmitAckThresholdMs,
      now
    );
    for (const o of pendingStale) {
      recs.push({
        clientOrderId: o.clientOrderId,
        action: "cancel",
        reason: "pending_submit_no_ack",
        detail: `no ack after ${this.config.pendingSubmitAckThresholdMs}ms`,
        order: o,
      });
    }

    const workingStale = this.store.getWorkingOlderThan(this.config.workingStaleMs, now);
    for (const o of workingStale) {
      recs.push({
        clientOrderId: o.clientOrderId,
        action: "cancel",
        reason: "working_too_old",
        detail: `no activity for ${this.config.workingStaleMs}ms`,
        order: o,
      });
    }

    if (this.config.checkDesiredPosture && this.getDesiredIntents) {
      const intents = this.getDesiredIntents();
      const workingByAsset = new Map<string, RuntimeOrderState[]>();
      for (const o of this.store.getAll()) {
        if (o.status !== "working" && o.status !== "partially_filled") continue;
        const key = `${o.funderAddress}:${o.assetId}`;
        const list = workingByAsset.get(key) ?? [];
        list.push(o);
        workingByAsset.set(key, list);
      }
      for (const i of intents) {
        const key = `${i.funderAddress}:${i.assetId}`;
        const orders = workingByAsset.get(key) ?? [];
        for (const o of orders) {
          const matches = this.orderMatchesIntent(o, i);
          if (!matches && !recs.some((r) => r.clientOrderId === o.clientOrderId)) {
            recs.push({
              clientOrderId: o.clientOrderId,
              action: "cancel",
              reason: "far_from_desired_posture",
              detail: "order does not match current intent",
              order: o,
            });
          }
        }
      }
    }

    const unknownOrInconsistent = this.store.getAll().filter(
      (o) =>
        o.status === "unknown" ||
        (o.status === "pending_submit" && o.exchangeOrderId != null)
    );
    for (const o of unknownOrInconsistent) {
      if (recs.some((r) => r.clientOrderId === o.clientOrderId)) continue;
      recs.push({
        clientOrderId: o.clientOrderId,
        action: "mark_stale",
        reason: o.status === "unknown" ? "unknown_status" : "inconsistent",
        detail: o.status === "unknown" ? "status unknown" : "pending_submit but has exchange id",
        order: o,
      });
    }

    return recs;
  }

  private orderMatchesIntent(o: RuntimeOrderState, i: OrderIntent): boolean {
    return (
      o.assetId === i.assetId &&
      o.side === i.side &&
      Math.abs(o.price - i.limitPrice) <= this.config.priceTolerance &&
      Math.abs(o.remainingSize - i.size) <= this.config.sizeTolerance
    );
  }

  sweepAndApply(now: Date = new Date()): StaleOrderRecommendation[] {
    const recs = this.sweep(now);
    const at = now;

    for (const r of recs) {
      if (this.eventBus) {
        const payload: OrderStalePayload = {
          funderAddress: r.order.funderAddress,
          runtimeOrderId: r.order.clientOrderId,
          externalOrderId: r.order.exchangeOrderId,
          assetId: r.order.assetId,
          staleAt: at,
          reason: `${r.reason}${r.detail ? `: ${r.detail}` : ""}`,
        };
        this.eventBus.publish({
          id: createRuntimeEventId(),
          type: "order.stale",
          source: "order_manager",
          occurredAt: at,
          payload,
        });
      }

      if (r.action === "cancel" && this.lifecycleHandler) {
        this.lifecycleHandler.applyCancelAck({
          clientOrderId: r.clientOrderId,
          canceledAt: at,
          reason: r.reason,
        });
      }
    }

    return recs;
  }
}
