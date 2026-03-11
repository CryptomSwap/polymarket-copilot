import type { RuntimeOrderState } from "./order-manager";
import type { OrderIntent } from "./order-manager";

/**
 * Desired-vs-actual reconciliation: compare intents to working orders and produce
 * a minimal action plan (KEEP / PLACE / CANCEL / CANCEL_REPLACE). Idempotent and conservative.
 */

export type ReconcilerActionKind = "KEEP" | "PLACE" | "CANCEL" | "CANCEL_REPLACE";

export interface ReconcilerActionKeep {
  kind: "KEEP";
  order: RuntimeOrderState;
}

export interface ReconcilerActionPlace {
  kind: "PLACE";
  intent: OrderIntent;
}

export interface ReconcilerActionCancel {
  kind: "CANCEL";
  order: RuntimeOrderState;
}

export interface ReconcilerActionCancelReplace {
  kind: "CANCEL_REPLACE";
  cancelOrder: RuntimeOrderState;
  placeIntent: OrderIntent;
}

export type ReconcilerAction =
  | ReconcilerActionKeep
  | ReconcilerActionPlace
  | ReconcilerActionCancel
  | ReconcilerActionCancelReplace;

export interface OrderIntentReconcilerResult {
  actions: ReconcilerAction[];
}

export interface OrderIntentReconciler {
  reconcile(
    intents: OrderIntent[],
    workingOrders: RuntimeOrderState[]
  ): OrderIntentReconcilerResult;
}

/** @deprecated Use ReconcilerAction. */
export type OrderActionKind = "place" | "cancel" | "amend";

/** @deprecated Use ReconcilerAction. */
export interface OrderAction {
  kind: OrderActionKind;
  payload: unknown;
}

const PRICE_EPS = 1e-6;
const SIZE_EPS = 1e-6;

function sameIntent(a: OrderIntent, b: OrderIntent): boolean {
  return (
    a.assetId === b.assetId &&
    a.side === b.side &&
    Math.abs(a.limitPrice - b.limitPrice) < PRICE_EPS &&
    Math.abs(a.size - b.size) < SIZE_EPS
  );
}

function orderMatchesIntent(o: RuntimeOrderState, i: OrderIntent): boolean {
  return (
    o.assetId === i.assetId &&
    o.side === i.side &&
    Math.abs(o.price - i.limitPrice) < PRICE_EPS &&
    Math.abs(o.size - i.size) < SIZE_EPS
  );
}

function intentIdMatch(o: RuntimeOrderState, i: OrderIntent): boolean {
  if (i.intentId && o.intentId) return o.intentId === i.intentId;
  return false;
}

/**
 * Conservative reconciler: match by intentId first, then by (asset, side, price, size).
 * Produces minimal KEEP/PLACE/CANCEL/CANCEL_REPLACE plan.
 */
export class DefaultOrderIntentReconciler implements OrderIntentReconciler {
  reconcile(
    intents: OrderIntent[],
    workingOrders: RuntimeOrderState[]
  ): OrderIntentReconcilerResult {
    const actions: ReconcilerAction[] = [];
    const matchedWorking = new Set<string>();

    for (const intent of intents) {
      const byIntentId = workingOrders.find((o) => intentIdMatch(o, intent));
      const byShape = workingOrders.find(
        (o) => !matchedWorking.has(o.clientOrderId) && orderMatchesIntent(o, intent)
      );
      const existing = byIntentId ?? byShape;

      if (existing) {
        if (byIntentId && (Math.abs(existing.price - intent.limitPrice) >= PRICE_EPS || Math.abs(existing.size - intent.size) >= SIZE_EPS)) {
          actions.push({ kind: "CANCEL_REPLACE", cancelOrder: existing, placeIntent: intent });
          matchedWorking.add(existing.clientOrderId);
        } else {
          actions.push({ kind: "KEEP", order: existing });
          matchedWorking.add(existing.clientOrderId);
        }
      } else {
        actions.push({ kind: "PLACE", intent });
      }
    }

    for (const order of workingOrders) {
      if (matchedWorking.has(order.clientOrderId)) continue;
      const stillDesired = intents.some((i) => orderMatchesIntent(order, i) || intentIdMatch(order, i));
      if (!stillDesired) {
        actions.push({ kind: "CANCEL", order });
      }
    }

    return { actions };
  }
}
