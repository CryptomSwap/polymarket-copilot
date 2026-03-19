import type { OrderIntent } from "./order-manager";
import type { OrderLifecycleStore } from "./order-lifecycle-store";
import type { OrderIntentReconciler, ReconcilerAction } from "./order-intent-reconciler";
import type { OrderManager } from "./order-manager";
import type { OrderExchangeAdapter } from "./order-exchange-adapter";
import type { OrderLifecycleHandler } from "./order-lifecycle-handler";
import type { RuntimeEventBus } from "../events/runtime-event-bus";
import type { RuntimeDiagnosticsCollector } from "../telemetry/runtime-diagnostics";
import { assertNoLiveOrderPlacement } from "../runtime-config";
import { assertLiveTradingNotPermittedUnlessReadinessPassed } from "@/lib/live-readiness";
import { createRuntimeEventId } from "../events/runtime-events";
import type { OrderSubmittedEvent } from "../events/runtime-events";
import type { AppendOrderLifecycleEventParams } from "../journal/order-lifecycle-journal";
import { ORDER_LIFECYCLE_EVENT_TYPES } from "../journal/order-lifecycle-journal";
import type { FailureContainmentStateManager } from "../execution/execution-failure-containment";

/**
 * Paper/simulation OrderManager: reconciles intents vs store, applies actions via the
 * exchange adapter (default paper), then updates store from adapter results. No live exchange.
 * When lifecycleHandler is provided, acks/rejects/cancels go through it so order.ack,
 * order.rejected, order.canceled are emitted.
 */

/** Params for durable execution ledger when an order is placed and acked. */
export interface OnOrderPlacedParams {
  orderIntentId: string;
  clientOrderId: string;
  exchangeOrderId: string;
  funderAddress: string;
  assetId: string;
  marketId: string;
  side: string;
  size: number;
  price: number;
  /** When this place is part of a replace flow (cancel-replace). */
  replaceContext?: { replaceRequestId: string; oldExecutedOrderId: string };
}

/** Result of starting a cancel in the ledger (executedOrderId + cancelRequestId). */
export interface OnCancelStartedResult {
  executedOrderId: string;
  cancelRequestId: string;
}

/** Result of starting a replace in the ledger (executedOrderId + replaceRequestId). */
export interface OnReplaceStartedResult {
  executedOrderId: string;
  replaceRequestId: string;
}

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
  /** When set, reconciliation actions and local_order_created / cancel_requested are journaled. */
  journalAppend?: (params: AppendOrderLifecycleEventParams) => void | Promise<void>;
  /** When set, ambiguous submit/cancel/replace outcomes are recorded and asset is frozen. */
  failureContainment?: FailureContainmentStateManager;
  /** When set, called after an order is placed and acked; use to persist ExecutedOrder to execution ledger. */
  onOrderPlaced?: (params: OnOrderPlacedParams) => void | Promise<void>;
  /** When set, called before cancel is sent; use to persist CancelRequest and append CANCEL_REQUESTED. */
  onCancelStarted?: (params: { exchangeOrderId: string }) => Promise<OnCancelStartedResult | null>;
  /** When set, called after cancel completes; use to append CANCELED/CANCEL_FAILED and mark request status. */
  onCancelCompleted?: (params: {
    executedOrderId: string;
    cancelRequestId: string;
    success: boolean;
    ambiguous?: boolean;
  }) => Promise<void>;
  /** When set, called before replace (cancel) is sent; use to persist ReplaceRequest and append REPLACE_REQUESTED. */
  onReplaceStarted?: (params: { exchangeOrderId: string }) => Promise<OnReplaceStartedResult | null>;
  /** When set, called after replace cancel completes; use to append REPLACE_FAILED or continue to place. */
  onReplaceCancelCompleted?: (params: {
    executedOrderId: string;
    replaceRequestId: string;
    cancelSuccess: boolean;
    ambiguous?: boolean;
  }) => Promise<void>;
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
    assertLiveTradingNotPermittedUnlessReadinessPassed();
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
    const journalAppend = this.options.journalAppend;
    const failureContainment = this.options.failureContainment;
    const onOrderPlaced = this.options.onOrderPlaced;
    const onCancelStarted = this.options.onCancelStarted;
    const onCancelCompleted = this.options.onCancelCompleted;
    const onReplaceStarted = this.options.onReplaceStarted;
    const onReplaceCancelCompleted = this.options.onReplaceCancelCompleted;
    for (const action of actions) {
      diagnostics?.recordReconciliationAction(action.kind);
      if (journalAppend) {
        const now = new Date();
        if (action.kind === "KEEP") {
          void journalAppend({
            funderAddress: action.order.funderAddress,
            clientOrderId: action.order.clientOrderId,
            exchangeOrderId: action.order.exchangeOrderId,
            intentId: action.order.intentId,
            assetId: action.order.assetId,
            marketId: action.order.marketId,
            side: action.order.side,
            eventType: ORDER_LIFECYCLE_EVENT_TYPES.RECONCILE_KEEP,
            occurredAt: now,
          });
        } else if (action.kind === "PLACE") {
          void journalAppend({
            funderAddress: action.intent.funderAddress,
            assetId: action.intent.assetId,
            marketId: action.intent.marketId,
            side: action.intent.side,
            intentId: action.intent.intentId ?? null,
            eventType: ORDER_LIFECYCLE_EVENT_TYPES.RECONCILE_PLACE,
            payloadJson: JSON.stringify({ size: action.intent.size, limitPrice: action.intent.limitPrice }),
            occurredAt: now,
          });
        } else if (action.kind === "CANCEL") {
          void journalAppend({
            funderAddress: action.order.funderAddress,
            clientOrderId: action.order.clientOrderId,
            exchangeOrderId: action.order.exchangeOrderId,
            intentId: action.order.intentId,
            assetId: action.order.assetId,
            marketId: action.order.marketId,
            side: action.order.side,
            eventType: ORDER_LIFECYCLE_EVENT_TYPES.RECONCILE_CANCEL,
            occurredAt: now,
          });
        } else if (action.kind === "CANCEL_REPLACE") {
          void journalAppend({
            funderAddress: action.cancelOrder.funderAddress,
            clientOrderId: action.cancelOrder.clientOrderId,
            exchangeOrderId: action.cancelOrder.exchangeOrderId,
            intentId: action.cancelOrder.intentId,
            assetId: action.cancelOrder.assetId,
            marketId: action.cancelOrder.marketId,
            side: action.cancelOrder.side,
            eventType: ORDER_LIFECYCLE_EVENT_TYPES.RECONCILE_CANCEL_REPLACE,
            payloadJson: JSON.stringify({ placeIntent: action.placeIntent }),
            occurredAt: now,
          });
        }
      }
      await this.applyAction(
        action,
        store,
        nextId,
        eventBus,
        adapter,
        lifecycleHandler,
        journalAppend,
        failureContainment,
        diagnostics,
        onOrderPlaced,
        onCancelStarted,
        onCancelCompleted,
        onReplaceStarted,
        onReplaceCancelCompleted
      );
    }
  }

  private async applyAction(
    action: ReconcilerAction,
    store: OrderLifecycleStore,
    nextClientOrderId: () => string,
    eventBus: RuntimeEventBus | undefined,
    adapter: OrderExchangeAdapter | undefined,
    lifecycleHandler: OrderLifecycleHandler | undefined,
    journalAppend: ((params: AppendOrderLifecycleEventParams) => void | Promise<void>) | undefined,
    failureContainment: FailureContainmentStateManager | undefined,
    diagnostics: import("../telemetry/runtime-diagnostics").RuntimeDiagnosticsCollector | undefined,
    onOrderPlaced: ((params: OnOrderPlacedParams) => void | Promise<void>) | undefined,
    onCancelStarted:
      | ((params: { exchangeOrderId: string }) => Promise<OnCancelStartedResult | null>)
      | undefined,
    onCancelCompleted:
      | ((params: {
          executedOrderId: string;
          cancelRequestId: string;
          success: boolean;
          ambiguous?: boolean;
        }) => Promise<void>)
      | undefined,
    onReplaceStarted:
      | ((params: { exchangeOrderId: string }) => Promise<OnReplaceStartedResult | null>)
      | undefined,
    onReplaceCancelCompleted:
      | ((params: {
          executedOrderId: string;
          replaceRequestId: string;
          cancelSuccess: boolean;
          ambiguous?: boolean;
        }) => Promise<void>)
      | undefined,
  ): Promise<void> {
    const now = new Date();
    const source = "order_manager" as const;

    switch (action.kind) {
      case "KEEP":
        break;
      case "PLACE": {
        const { intent } = action;
        const clientOrderId = nextClientOrderId();
        let didAck = false;
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
        if (journalAppend) {
          void journalAppend({
            funderAddress: intent.funderAddress,
            clientOrderId,
            assetId: intent.assetId,
            marketId: intent.marketId,
            side: intent.side,
            intentId: intent.intentId ?? null,
            eventType: ORDER_LIFECYCLE_EVENT_TYPES.LOCAL_ORDER_CREATED,
            payloadJson: JSON.stringify({
              clientOrderId,
              price: intent.limitPrice,
              size: intent.size,
              intentId: intent.intentId,
            }),
            occurredAt: now,
          });
        }
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
          const ambiguousOrTimeout = result.timeout === true || result.ambiguous === true;
          if (ambiguousOrTimeout) {
            store.updateStatus(clientOrderId, "submit_ambiguous");
            if (journalAppend) {
              journalAppend({
                funderAddress: intent.funderAddress,
                clientOrderId,
                assetId: intent.assetId,
                marketId: intent.marketId,
                side: intent.side,
                intentId: intent.intentId ?? null,
                eventType: ORDER_LIFECYCLE_EVENT_TYPES.SUBMIT_AMBIGUOUS,
                occurredAt: now,
              });
            }
            failureContainment?.recordSubmitAmbiguous(intent.assetId);
            diagnostics?.recordSubmitAmbiguous();
            diagnostics?.recordExecutionVerificationRequired();
          } else if (result.success && result.exchangeOrderId) {
            exchangeId = result.exchangeOrderId;
            didAck = true;
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
          didAck = true;
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
        if (didAck && intent.intentId && onOrderPlaced) {
          void Promise.resolve(
            onOrderPlaced({
              orderIntentId: intent.intentId,
              clientOrderId,
              exchangeOrderId: exchangeId,
              funderAddress: intent.funderAddress,
              assetId: intent.assetId,
              marketId: intent.marketId,
              side: intent.side,
              size: intent.size,
              price: intent.limitPrice,
            })
          ).catch(() => {});
        }
        break;
      }
      case "CANCEL": {
        const order = action.order;
        const exchangeOrderId = order.exchangeOrderId ?? `paper_${order.clientOrderId}`;
        let cancelLedger: OnCancelStartedResult | null = null;
        if (onCancelStarted) {
          try {
            cancelLedger = await onCancelStarted({ exchangeOrderId });
          } catch {
            // ledger write best-effort; continue with cancel
          }
        }
        if (journalAppend) {
          void journalAppend({
            funderAddress: order.funderAddress,
            clientOrderId: order.clientOrderId,
            exchangeOrderId: order.exchangeOrderId,
            intentId: order.intentId,
            assetId: order.assetId,
            marketId: order.marketId,
            side: order.side,
            eventType: ORDER_LIFECYCLE_EVENT_TYPES.CANCEL_REQUESTED,
            occurredAt: now,
          });
        }
        let cancelSuccess = false;
        let cancelAmbiguous = false;
        if (adapter) {
          const result = await adapter.cancelOrder({
            clientOrderId: order.clientOrderId,
            exchangeOrderId: order.exchangeOrderId ?? undefined,
          });
          const ambiguousOrTimeout = result.timeout === true || result.ambiguous === true;
          if (ambiguousOrTimeout) {
            cancelAmbiguous = true;
            store.updateStatus(order.clientOrderId, "cancel_ambiguous");
            if (journalAppend) {
              journalAppend({
                funderAddress: order.funderAddress,
                clientOrderId: order.clientOrderId,
                exchangeOrderId: order.exchangeOrderId,
                intentId: order.intentId,
                assetId: order.assetId,
                marketId: order.marketId,
                side: order.side,
                eventType: ORDER_LIFECYCLE_EVENT_TYPES.CANCEL_AMBIGUOUS,
                occurredAt: now,
              });
            }
            failureContainment?.recordCancelAmbiguous(order.assetId);
            diagnostics?.recordCancelAmbiguous();
            diagnostics?.recordExecutionVerificationRequired();
          } else if (result.success) {
            cancelSuccess = true;
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
          cancelSuccess = true;
          if (lifecycleHandler) {
            lifecycleHandler.applyCancelAck({
              clientOrderId: order.clientOrderId,
              canceledAt: now,
            });
          } else {
            store.applyCancel(order.clientOrderId);
          }
        }
        if (cancelLedger && onCancelCompleted) {
          void onCancelCompleted({
            executedOrderId: cancelLedger.executedOrderId,
            cancelRequestId: cancelLedger.cancelRequestId,
            success: cancelSuccess,
            ambiguous: cancelAmbiguous,
          }).catch(() => {});
        }
        break;
      }
      case "CANCEL_REPLACE": {
        const order = action.cancelOrder;
        const placeIntent = action.placeIntent;
        const exchangeOrderId = order.exchangeOrderId ?? `paper_${order.clientOrderId}`;
        let replaceLedger: OnReplaceStartedResult | null = null;
        if (onReplaceStarted) {
          try {
            replaceLedger = await onReplaceStarted({ exchangeOrderId });
          } catch {
            // ledger write best-effort
          }
        }
        if (journalAppend) {
          void journalAppend({
            funderAddress: order.funderAddress,
            clientOrderId: order.clientOrderId,
            exchangeOrderId: order.exchangeOrderId,
            intentId: order.intentId,
            assetId: order.assetId,
            marketId: order.marketId,
            side: order.side,
            eventType: ORDER_LIFECYCLE_EVENT_TYPES.CANCEL_REQUESTED,
            occurredAt: now,
          });
        }
        let cancelSucceeded = false;
        let cancelAmbiguous = false;
        if (adapter) {
          const cancelResult = await adapter.cancelOrder({
            clientOrderId: order.clientOrderId,
            exchangeOrderId: order.exchangeOrderId ?? undefined,
          });
          const cancelAmbiguousOrTimeout = cancelResult.timeout === true || cancelResult.ambiguous === true;
          if (cancelAmbiguousOrTimeout) {
            cancelAmbiguous = true;
            store.updateStatus(order.clientOrderId, "replace_ambiguous");
            if (journalAppend) {
              journalAppend({
                funderAddress: order.funderAddress,
                clientOrderId: order.clientOrderId,
                exchangeOrderId: order.exchangeOrderId,
                intentId: order.intentId,
                assetId: order.assetId,
                marketId: order.marketId,
                side: order.side,
                eventType: ORDER_LIFECYCLE_EVENT_TYPES.REPLACE_AMBIGUOUS,
                occurredAt: now,
              });
            }
            failureContainment?.recordReplaceAmbiguous(order.assetId);
            diagnostics?.recordReplaceAmbiguous();
            diagnostics?.recordExecutionVerificationRequired();
          } else if (cancelResult.success) {
            cancelSucceeded = true;
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
          cancelSucceeded = true;
          if (lifecycleHandler) {
            lifecycleHandler.applyCancelAck({
              clientOrderId: order.clientOrderId,
              canceledAt: now,
            });
          } else {
            store.applyCancel(order.clientOrderId);
          }
        }
        if (replaceLedger && onReplaceCancelCompleted) {
          void onReplaceCancelCompleted({
            executedOrderId: replaceLedger.executedOrderId,
            replaceRequestId: replaceLedger.replaceRequestId,
            cancelSuccess: cancelSucceeded,
            ambiguous: cancelAmbiguous,
          }).catch(() => {});
        }
        if (!cancelSucceeded && adapter) {
          break;
        }
        let replaceDidAck = false;
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
        if (journalAppend) {
          void journalAppend({
            funderAddress: placeIntent.funderAddress,
            clientOrderId,
            assetId: placeIntent.assetId,
            marketId: placeIntent.marketId,
            side: placeIntent.side,
            intentId: placeIntent.intentId ?? null,
            eventType: ORDER_LIFECYCLE_EVENT_TYPES.LOCAL_ORDER_CREATED,
            payloadJson: JSON.stringify({
              clientOrderId,
              price: placeIntent.limitPrice,
              size: placeIntent.size,
              intentId: placeIntent.intentId,
            }),
            occurredAt: now,
          });
        }
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
          const replaceSubmitAmbiguous = result.timeout === true || result.ambiguous === true;
          if (replaceSubmitAmbiguous) {
            store.updateStatus(clientOrderId, "submit_ambiguous");
            if (journalAppend) {
              journalAppend({
                funderAddress: placeIntent.funderAddress,
                clientOrderId,
                assetId: placeIntent.assetId,
                marketId: placeIntent.marketId,
                side: placeIntent.side,
                intentId: placeIntent.intentId ?? null,
                eventType: ORDER_LIFECYCLE_EVENT_TYPES.SUBMIT_AMBIGUOUS,
                payloadJson: JSON.stringify({ context: "replace_ambiguous" }),
                occurredAt: now,
              });
            }
            failureContainment?.recordSubmitAmbiguous(placeIntent.assetId);
            failureContainment?.recordReplaceAmbiguous(placeIntent.assetId);
            diagnostics?.recordSubmitAmbiguous();
            diagnostics?.recordReplaceAmbiguous();
            diagnostics?.recordExecutionVerificationRequired();
          } else if (result.success && result.exchangeOrderId) {
            replaceExchangeId = result.exchangeOrderId;
            replaceDidAck = true;
            if (lifecycleHandler) {
              lifecycleHandler.applyAck({
                clientOrderId,
                exchangeOrderId: result.exchangeOrderId,
                acknowledgedAt: now,
              });
            } else {
              store.applyAck(clientOrderId, result.exchangeOrderId);
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
          replaceDidAck = true;
          if (lifecycleHandler) {
            lifecycleHandler.applyAck({
              clientOrderId,
              exchangeOrderId: replaceExchangeId,
              acknowledgedAt: now,
            });
          } else {
            store.applyAck(clientOrderId, replaceExchangeId);
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
        }
        if (replaceDidAck && placeIntent.intentId && onOrderPlaced) {
          void Promise.resolve(
            onOrderPlaced({
              orderIntentId: placeIntent.intentId,
              clientOrderId,
              exchangeOrderId: replaceExchangeId,
              funderAddress: placeIntent.funderAddress,
              assetId: placeIntent.assetId,
              marketId: placeIntent.marketId,
              side: placeIntent.side,
              size: placeIntent.size,
              price: placeIntent.limitPrice,
              replaceContext: replaceLedger
                ? {
                    replaceRequestId: replaceLedger.replaceRequestId,
                    oldExecutedOrderId: replaceLedger.executedOrderId,
                  }
                : undefined,
            })
          ).catch(() => {});
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
