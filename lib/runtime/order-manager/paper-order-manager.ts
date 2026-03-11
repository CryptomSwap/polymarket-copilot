import type { OrderIntent } from "./order-manager";
import type { OrderLifecycleStore } from "./order-lifecycle-store";
import type { OrderIntentReconciler, ReconcilerAction } from "./order-intent-reconciler";
import type { OrderManager } from "./order-manager";
import type { OrderExchangeAdapter } from "./order-exchange-adapter";
import type { OrderLifecycleHandler } from "./order-lifecycle-handler";
import type { RuntimeEventBus } from "../events/runtime-event-bus";
import type { RuntimeDiagnosticsCollector } from "../telemetry/runtime-diagnostics";
import { assertNoLiveOrderPlacement } from "../runtime-config";
import { createRuntimeEventId } from "../events/runtime-events";
import type { OrderSubmittedEvent } from "../events/runtime-events";

/**
 * Paper/simulation OrderManager: reconciles intents vs store, applies actions via the
 * exchange adapter (default paper), then updates store from adapter results. No live exchange.
 * When lifecycleHandler is provided, acks/rejects/cancels go through it so order.ack,
 * order.rejected, order.canceled are emitted.
 */

export interface PaperOrderManagerOptions {
  store: OrderLifecycleStore;
  reconciler: OrderIntentReconciler;
  /** Exchange adapter (default: paper). Manager calls submitOrder/cancelOrder and applies results to store. */
  adapter?: OrderExchangeAdapter;
  eventBus?: RuntimeEventBus;
  /** When set, acks/rejects/cancels are applied via handler (store + event emission). */
  lifecycleHandler?: OrderLifecycleHandler;
  /** Generate a unique client order id for new orders. */
  nextClientOrderId?: () => string;
  /** Optional: record reconciliation actions for diagnostics. */
  diagnostics?: RuntimeDiagnosticsCollector;
}

const DEFAULT_CLIENT_ORDER_ID = (): string =>
  `paper_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;

export class PaperOrderManager implements OrderManager {
  private readonly options: PaperOrderManagerOptions;

  constructor(options: PaperOrderManagerOptions) {
    this.options = options;
  }

  async reconcileIntents(intents: OrderIntent[]): Promise<void> {
    if (intents.length === 0) return;
    assertNoLiveOrderPlacement();
    const adapterHealth = this.options.adapter?.getHealth?.();
    if (adapterHealth?.mode === "live") {
      throw new Error(
        "[PaperOrderManager] Live adapter not allowed. Only paper adapter may execute; real exchange submission is disabled."
      );
    }
    const { store, reconciler, eventBus, adapter } = this.options;
    const nextId = this.options.nextClientOrderId ?? DEFAULT_CLIENT_ORDER_ID;

    const seen = new Set<string>();
    const workingOrders: ReturnType<OrderLifecycleStore["getAll"]> = [];
    for (const i of intents) {
      const key = `${i.funderAddress}:${i.assetId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      workingOrders.push(...store.listOpenByAsset(i.funderAddress, i.assetId));
    }

    const { actions } = reconciler.reconcile(intents, workingOrders);
    const diagnostics = this.options.diagnostics;
    const lifecycleHandler = this.options.lifecycleHandler;
    for (const action of actions) {
      diagnostics?.recordReconciliationAction(action.kind);
      await this.applyAction(action, store, nextId, eventBus, adapter, lifecycleHandler);
    }
  }

  private async applyAction(
    action: ReconcilerAction,
    store: OrderLifecycleStore,
    nextClientOrderId: () => string,
    eventBus: RuntimeEventBus | undefined,
    adapter: OrderExchangeAdapter | undefined,
    lifecycleHandler: OrderLifecycleHandler | undefined
  ): Promise<void> {
    const now = new Date();
    const source = "order_manager" as const;

    switch (action.kind) {
      case "KEEP":
        break;
      case "PLACE": {
        const { intent } = action;
        const clientOrderId = nextClientOrderId();
        store.create({
          clientOrderId,
          funderAddress: intent.funderAddress,
          assetId: intent.assetId,
          marketId: intent.marketId,
          side: intent.side,
          price: intent.limitPrice,
          size: intent.size,
          intentId: intent.intentId ?? null,
          replaceGroupKey: null,
        });
        let exchangeId = `paper_${clientOrderId}`;
        if (adapter) {
          const result = await adapter.submitOrder({
            clientOrderId,
            funderAddress: intent.funderAddress,
            assetId: intent.assetId,
            marketId: intent.marketId,
            side: intent.side,
            price: intent.limitPrice,
            size: intent.size,
            intentId: intent.intentId ?? null,
          });
          if (result.success && result.exchangeOrderId) {
            exchangeId = result.exchangeOrderId;
            if (lifecycleHandler) {
              lifecycleHandler.applyAck({
                clientOrderId,
                exchangeOrderId: result.exchangeOrderId,
                acknowledgedAt: now,
              });
            } else {
              store.applyAck(clientOrderId, result.exchangeOrderId);
            }
          } else {
            if (lifecycleHandler) {
              lifecycleHandler.applyRejection({
                clientOrderId,
                rejectedAt: now,
                reason: result.error ?? "rejected",
              });
            } else {
              store.applyReject(clientOrderId);
            }
          }
        } else {
          if (lifecycleHandler) {
            lifecycleHandler.applyAck({
              clientOrderId,
              exchangeOrderId: exchangeId,
              acknowledgedAt: now,
            });
          } else {
            store.applyAck(clientOrderId, exchangeId);
          }
        }
        if (eventBus) {
          this.emitSubmitted(eventBus, source, intent, clientOrderId, exchangeId, now);
        }
        break;
      }
      case "CANCEL": {
        const order = action.order;
        if (adapter) {
          const result = await adapter.cancelOrder({
            clientOrderId: order.clientOrderId,
            exchangeOrderId: order.exchangeOrderId,
          });
          if (result.success) {
            if (lifecycleHandler) {
              lifecycleHandler.applyCancelAck({
                clientOrderId: order.clientOrderId,
                canceledAt: now,
              });
            } else {
              store.applyCancel(order.clientOrderId);
            }
          }
        } else {
          if (lifecycleHandler) {
            lifecycleHandler.applyCancelAck({
              clientOrderId: order.clientOrderId,
              canceledAt: now,
            });
          } else {
            store.applyCancel(order.clientOrderId);
          }
        }
        break;
      }
      case "CANCEL_REPLACE": {
        const order = action.cancelOrder;
        if (adapter) {
          const cancelResult = await adapter.cancelOrder({
            clientOrderId: order.clientOrderId,
            exchangeOrderId: order.exchangeOrderId,
          });
          if (cancelResult.success) {
            if (lifecycleHandler) {
              lifecycleHandler.applyCancelAck({
                clientOrderId: order.clientOrderId,
                canceledAt: now,
              });
            } else {
              store.applyCancel(order.clientOrderId);
            }
          }
        } else {
          if (lifecycleHandler) {
            lifecycleHandler.applyCancelAck({
              clientOrderId: order.clientOrderId,
              canceledAt: now,
            });
          } else {
            store.applyCancel(order.clientOrderId);
          }
        }
        const placeIntent = action.placeIntent;
        const clientOrderId = nextClientOrderId();
        store.create({
          clientOrderId,
          funderAddress: placeIntent.funderAddress,
          assetId: placeIntent.assetId,
          marketId: placeIntent.marketId,
          side: placeIntent.side,
          price: placeIntent.limitPrice,
          size: placeIntent.size,
          intentId: placeIntent.intentId ?? null,
          replaceGroupKey: order.replaceGroupKey,
        });
        let replaceExchangeId = `paper_${clientOrderId}`;
        if (adapter) {
          const result = await adapter.submitOrder({
            clientOrderId,
            funderAddress: placeIntent.funderAddress,
            assetId: placeIntent.assetId,
            marketId: placeIntent.marketId,
            side: placeIntent.side,
            price: placeIntent.limitPrice,
            size: placeIntent.size,
            intentId: placeIntent.intentId ?? null,
          });
          if (result.success && result.exchangeOrderId) {
            replaceExchangeId = result.exchangeOrderId;
            if (lifecycleHandler) {
              lifecycleHandler.applyAck({
                clientOrderId,
                exchangeOrderId: result.exchangeOrderId,
                acknowledgedAt: now,
              });
            } else {
              store.applyAck(clientOrderId, result.exchangeOrderId);
            }
          } else {
            if (lifecycleHandler) {
              lifecycleHandler.applyRejection({
                clientOrderId,
                rejectedAt: now,
                reason: result.error ?? "rejected",
              });
            } else {
              store.applyReject(clientOrderId);
            }
          }
        } else {
          if (lifecycleHandler) {
            lifecycleHandler.applyAck({
              clientOrderId,
              exchangeOrderId: replaceExchangeId,
              acknowledgedAt: now,
            });
          } else {
            store.applyAck(clientOrderId, replaceExchangeId);
          }
        }
        if (eventBus) {
          this.emitSubmitted(
            eventBus,
            source,
            placeIntent,
            clientOrderId,
            replaceExchangeId,
            now
          );
        }
        break;
      }
    }
  }

  private emitSubmitted(
    eventBus: RuntimeEventBus,
    source: "order_manager",
    intent: OrderIntent,
    clientOrderId: string,
    exchangeOrderId: string,
    now: Date
  ): void {
    eventBus.publish({
      id: createRuntimeEventId(),
      type: "order.submitted",
      source,
      occurredAt: now,
      payload: {
        funderAddress: intent.funderAddress,
        runtimeOrderId: clientOrderId,
        externalOrderId: exchangeOrderId,
        assetId: intent.assetId,
        marketId: intent.marketId,
        side: intent.side,
        size: intent.size,
        limitPrice: intent.limitPrice,
        submittedAt: now,
      },
    } as OrderSubmittedEvent);
  }
}
