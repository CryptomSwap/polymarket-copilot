/**
 * Runtime exposure update: compute gross/net exposure and working order count from
 * position and order stores and push into the risk engine. Call before guardrails/reconciliation
 * so risk state is fresh. No Prisma; in-memory only.
 *
 * Net exposure: sum of signed notionals (LONG = +exposureNotional, SHORT = -exposureNotional).
 * Assumption: single-funder view; multi-funder net would require per-funder aggregation.
 */

import type { RuntimeRiskEngine } from "./risk/runtime-risk-engine";
import type { RuntimePositionStore } from "./positions/runtime-position-store";
import type { OrderLifecycleStore } from "./order-manager/order-lifecycle-store";
import type { RuntimeOrderStatus } from "./order-manager/order-manager";

const OPEN_ORDER_STATUSES: RuntimeOrderStatus[] = [
  "pending_submit",
  "working",
  "partially_filled",
  "pending_cancel",
];

export interface ExposureSnapshot {
  grossExposure: number;
  netExposure: number;
  workingOrderCount: number;
}

/**
 * Read-only: compute gross exposure, net exposure, and working order count from stores.
 * Does not update the risk engine. Use for health/dashboard snapshots.
 * Net exposure = sum over positions of (side === "LONG" ? exposureNotional : -exposureNotional).
 */
export function getExposureFromStores(
  positionStore: RuntimePositionStore,
  orderStore: OrderLifecycleStore
): ExposureSnapshot {
  const positions = positionStore.getAll();
  let grossExposure = 0;
  let netExposure = 0;
  for (const p of positions) {
    const notional = p.exposureNotional ?? 0;
    grossExposure += notional;
    netExposure += p.side === "LONG" ? notional : -notional;
  }
  const allOrders = orderStore.getAll();
  const workingOrderCount = allOrders.filter((o) =>
    OPEN_ORDER_STATUSES.includes(o.status)
  ).length;
  return { grossExposure, netExposure, workingOrderCount };
}

/**
 * Compute gross exposure, net exposure, and working order count from stores and call
 * riskEngine.updateExposure(). Call before guardrails/reconciliation so risk state is fresh.
 */
export function updateRiskExposureFromStores(
  riskEngine: RuntimeRiskEngine,
  positionStore: RuntimePositionStore,
  orderStore: OrderLifecycleStore
): void {
  const { grossExposure, netExposure, workingOrderCount } = getExposureFromStores(
    positionStore,
    orderStore
  );
  riskEngine.updateExposure(grossExposure, netExposure, workingOrderCount);
}
