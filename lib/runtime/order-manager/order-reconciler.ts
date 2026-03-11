import type { OrderIntent } from "./order-manager";
import type { OrderManager } from "./order-manager";
import type { OrderExchangeAdapter } from "./order-exchange-adapter";
import type { OrderIntentReconciler } from "./order-intent-reconciler";
import type { OrderLifecycleStore } from "./order-lifecycle-store";

/**
 * High-level order reconciliation coordinator.
 * Gathers working orders from store, runs reconciler, then runs exchange adapter (or paper path).
 */

export interface OrderReconcilerOptions {
  orderManager: OrderManager;
  intentReconciler: OrderIntentReconciler;
  exchangeAdapter: OrderExchangeAdapter;
  /** Required to pass working orders into the reconciler. */
  store: OrderLifecycleStore;
}

export class OrderReconciler {
  private readonly opts: OrderReconcilerOptions;

  constructor(opts: OrderReconcilerOptions) {
    this.opts = opts;
  }

  /**
   * Entry point for desired order intents from the bot runtime.
   * Gathers working orders per (funder, asset), runs reconciler, executes adapter, then notifies order manager.
   */
  async reconcile(intents: OrderIntent[]): Promise<void> {
    const { store, intentReconciler, orderManager } = this.opts;
    if (intents.length === 0) return;

    const seen = new Set<string>();
    const workingOrders: ReturnType<OrderLifecycleStore["getAll"]> = [];
    for (const i of intents) {
      const key = `${i.funderAddress}:${i.assetId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      workingOrders.push(...store.listOpenByAsset(i.funderAddress, i.assetId));
    }

    intentReconciler.reconcile(intents, workingOrders);
    await orderManager.reconcileIntents(intents);
  }
}

