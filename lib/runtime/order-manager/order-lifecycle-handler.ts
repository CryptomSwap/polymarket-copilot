/**
 * Order lifecycle handler: applies normalized ack/partial fill/full fill/cancel/reject
 * to the store and emits order.* events. Position updater can subscribe to order.filled.
 * No live exchange; call from paper or future exchange webhook seam.
 * When journalAppend is provided, each transition is durably journaled (append-only).
 */

import type { RuntimeEventBus } from "../events/runtime-event-bus";
import { createRuntimeEventId } from "../events/runtime-events";
import type { AppendOrderLifecycleEventParams } from "../journal/order-lifecycle-journal";
import { ORDER_LIFECYCLE_EVENT_TYPES } from "../journal/order-lifecycle-journal";
import type {
  OrderAckPayload,
  OrderPartialFillPayload,
  OrderFilledPayload,
  OrderCanceledPayload,
  OrderRejectedPayload,
} from "../events/runtime-events";
import type {
  OrderAckInput,
  OrderPartialFillInput,
  OrderFullFillInput,
  OrderCancelAckInput,
  OrderRejectInput,
} from "./order-manager";
import type { OrderLifecycleStore } from "./order-lifecycle-store";

const EVENT_SOURCE = "order_manager" as const;

export interface OrderLifecycleHandlerOptions {
  store: OrderLifecycleStore;
  eventBus?: RuntimeEventBus;
  /** When set, each lifecycle transition is appended to the order lifecycle journal (append-only). */
  journalAppend?: (params: AppendOrderLifecycleEventParams) => void | Promise<void>;
}

export interface OrderLifecycleHandler {
  applyAck(input: OrderAckInput): void;
  applyPartialFill(input: OrderPartialFillInput): void;
  applyFullFill(input: OrderFullFillInput): void;
  applyCancelAck(input: OrderCancelAckInput): void;
  applyRejection(input: OrderRejectInput): void;
}

/**
 * Applies normalized lifecycle events to the store and emits order.* events.
 * On full/partial fill, emits order.partial_fill or order.filled so position updater can react.
 */
export class DefaultOrderLifecycleHandler implements OrderLifecycleHandler {
  private readonly options: OrderLifecycleHandlerOptions;

  constructor(options: OrderLifecycleHandlerOptions) {
    this.options = options;
  }

  applyAck(input: OrderAckInput): void {
    const { store, eventBus, journalAppend } = this.options;
    const order = store.get(input.clientOrderId);
    if (!order) return;
    store.applyAck(input.clientOrderId, input.exchangeOrderId);
    if (journalAppend) {
      void journalAppend({
        funderAddress: order.funderAddress,
        clientOrderId: input.clientOrderId,
        exchangeOrderId: input.exchangeOrderId,
        intentId: order.intentId,
        assetId: order.assetId,
        marketId: order.marketId,
        side: order.side,
        eventType: ORDER_LIFECYCLE_EVENT_TYPES.ACK,
        payloadJson: JSON.stringify({ exchangeOrderId: input.exchangeOrderId }),
        occurredAt: input.acknowledgedAt,
      }).catch(() => {});
    }
    if (eventBus) {
      const payload: OrderAckPayload = {
        funderAddress: order.funderAddress,
        runtimeOrderId: order.clientOrderId,
        externalOrderId: input.exchangeOrderId,
        assetId: order.assetId,
        acknowledgedAt: input.acknowledgedAt,
      };
      eventBus.publish({
        id: createRuntimeEventId(),
        type: "order.ack",
        source: EVENT_SOURCE,
        occurredAt: input.acknowledgedAt,
        payload,
      });
    }
  }

  applyPartialFill(input: OrderPartialFillInput): void {
    const { store, eventBus, journalAppend } = this.options;
    const order = store.get(input.clientOrderId);
    if (!order || input.fillSize <= 0) return;
    const prevFilled = order.filledSize;
    store.applyPartialFill(input.clientOrderId, input.fillSize, input.fillPrice);
    const updated = store.get(input.clientOrderId);
    if (!updated) return;
    if (journalAppend) {
      void journalAppend({
        funderAddress: order.funderAddress,
        clientOrderId: input.clientOrderId,
        exchangeOrderId: order.exchangeOrderId,
        intentId: order.intentId,
        assetId: order.assetId,
        marketId: order.marketId,
        side: order.side,
        eventType: ORDER_LIFECYCLE_EVENT_TYPES.PARTIAL_FILL,
        payloadJson: JSON.stringify({
          fillSize: input.fillSize,
          fillPrice: input.fillPrice,
          exchangeFillId: input.exchangeFillId,
        }),
        occurredAt: input.filledAt,
      }).catch(() => {});
    }
    if (eventBus) {
      const payload: OrderPartialFillPayload = {
        funderAddress: order.funderAddress,
        runtimeOrderId: order.clientOrderId,
        externalOrderId: order.exchangeOrderId ?? "",
        assetId: order.assetId,
        filledSize: updated.filledSize,
        remainingSize: updated.remainingSize,
        fillPrice: input.fillPrice,
        filledAt: input.filledAt,
        exchangeFillId: input.exchangeFillId ?? undefined,
      };
      eventBus.publish({
        id: createRuntimeEventId(),
        type: "order.partial_fill",
        source: EVENT_SOURCE,
        occurredAt: input.filledAt,
        payload,
      });
    }
    if (updated.status === "filled" && eventBus) {
      this.emitFilled(order, updated.filledSize, input.fillPrice, input.filledAt, input.exchangeFillId);
    }
  }

  applyFullFill(input: OrderFullFillInput): void {
    const { store, eventBus, journalAppend } = this.options;
    const order = store.get(input.clientOrderId);
    if (!order) return;
    const remaining = order.remainingSize;
    if (remaining > 0) {
      store.applyFill(input.clientOrderId, remaining, input.avgPrice);
    }
    const updated = store.get(input.clientOrderId);
    if (updated && journalAppend && remaining > 0) {
      void journalAppend({
        funderAddress: order.funderAddress,
        clientOrderId: input.clientOrderId,
        exchangeOrderId: order.exchangeOrderId,
        intentId: order.intentId,
        assetId: order.assetId,
        marketId: order.marketId,
        side: order.side,
        eventType: ORDER_LIFECYCLE_EVENT_TYPES.FILL,
        payloadJson: JSON.stringify({
          totalFilledSize: input.totalFilledSize,
          avgPrice: input.avgPrice,
          exchangeFillId: input.exchangeFillId,
        }),
        occurredAt: input.filledAt,
      }).catch(() => {});
    }
    if (updated && eventBus && remaining > 0) {
      this.emitFilled(order, input.totalFilledSize, input.avgPrice, input.filledAt, input.exchangeFillId);
    }
  }

  private emitFilled(
    order: { funderAddress: string; clientOrderId: string; exchangeOrderId: string | null; assetId: string; marketId: string; side: "BUY" | "SELL" },
    totalFilledSize: number,
    avgPrice: number,
    filledAt: Date,
    exchangeFillId?: string | null
  ): void {
    const { eventBus } = this.options;
    if (!eventBus) return;
    const payload: OrderFilledPayload = {
      funderAddress: order.funderAddress,
      runtimeOrderId: order.clientOrderId,
      externalOrderId: order.exchangeOrderId ?? "",
      assetId: order.assetId,
      marketId: order.marketId,
      side: order.side,
      totalFilledSize,
      avgPrice,
      filledAt,
      exchangeFillId: exchangeFillId ?? undefined,
    };
    eventBus.publish({
      id: createRuntimeEventId(),
      type: "order.filled",
      source: EVENT_SOURCE,
      occurredAt: filledAt,
      payload,
    });
  }

  applyCancelAck(input: OrderCancelAckInput): void {
    const { store, eventBus, journalAppend } = this.options;
    const order = store.get(input.clientOrderId);
    if (!order) return;
    store.applyCancel(input.clientOrderId);
    if (journalAppend) {
      void journalAppend({
        funderAddress: order.funderAddress,
        clientOrderId: input.clientOrderId,
        exchangeOrderId: order.exchangeOrderId,
        intentId: order.intentId,
        assetId: order.assetId,
        marketId: order.marketId,
        side: order.side,
        eventType: ORDER_LIFECYCLE_EVENT_TYPES.CANCELED,
        payloadJson: input.reason != null ? JSON.stringify({ reason: input.reason }) : null,
        occurredAt: input.canceledAt,
      }).catch(() => {});
    }
    if (eventBus) {
      const payload: OrderCanceledPayload = {
        funderAddress: order.funderAddress,
        runtimeOrderId: order.clientOrderId,
        externalOrderId: order.exchangeOrderId ?? "",
        assetId: order.assetId,
        canceledAt: input.canceledAt,
        reason: input.reason,
      };
      eventBus.publish({
        id: createRuntimeEventId(),
        type: "order.canceled",
        source: EVENT_SOURCE,
        occurredAt: input.canceledAt,
        payload,
      });
    }
  }

  applyRejection(input: OrderRejectInput): void {
    const { store, eventBus, journalAppend } = this.options;
    const order = store.get(input.clientOrderId);
    if (!order) return;
    store.applyReject(input.clientOrderId);
    if (journalAppend) {
      void journalAppend({
        funderAddress: order.funderAddress,
        clientOrderId: input.clientOrderId,
        exchangeOrderId: order.exchangeOrderId,
        intentId: order.intentId,
        assetId: order.assetId,
        marketId: order.marketId,
        side: order.side,
        eventType: ORDER_LIFECYCLE_EVENT_TYPES.REJECTED,
        payloadJson: JSON.stringify({ reason: input.reason }),
        occurredAt: input.rejectedAt,
      }).catch(() => {});
    }
    if (eventBus) {
      const payload: OrderRejectedPayload = {
        funderAddress: order.funderAddress,
        runtimeOrderId: order.clientOrderId,
        assetId: order.assetId,
        rejectedAt: input.rejectedAt,
        reason: input.reason,
      };
      eventBus.publish({
        id: createRuntimeEventId(),
        type: "order.rejected",
        source: EVENT_SOURCE,
        occurredAt: input.rejectedAt,
        payload,
      });
    }
  }
}
