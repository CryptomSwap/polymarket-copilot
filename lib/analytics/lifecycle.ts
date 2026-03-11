/**
 * Recommendation lifecycle event logging. Analytics only; no autonomous trading.
 * TODO: Future post-trade journaling can consume these events.
 */

import { prisma } from "@/lib/db";

export type LifecycleEventType =
  | "SHOWN"
  | "REVIEWED"
  | "APPROVED"
  | "REJECTED"
  | "PREVIEWED"
  | "INTENT_CREATED"
  | "ORDER_PLACED"
  | "ORDER_CANCELLED"
  | "FILLED"
  | "SKIPPED";

export interface LogLifecycleEventParams {
  recommendationId: string;
  funderAddress: string;
  eventType: LifecycleEventType;
  metadata?: Record<string, unknown>;
}

/**
 * Log a single lifecycle event. Fire-and-forget; does not throw.
 */
export async function logLifecycleEvent(params: LogLifecycleEventParams): Promise<void> {
  try {
    await prisma.recommendationLifecycleEvent.create({
      data: {
        recommendationId: params.recommendationId,
        funderAddress: params.funderAddress.toLowerCase(),
        eventType: params.eventType,
        metadata: params.metadata ? (JSON.parse(JSON.stringify(params.metadata)) as object) : undefined,
      },
    });
  } catch {
    // analytics only; do not fail the request
  }
}

/**
 * Log SHOWN when recommendation detail page is viewed.
 */
export async function logShown(recommendationId: string, funderAddress: string): Promise<void> {
  await logLifecycleEvent({
    recommendationId,
    funderAddress,
    eventType: "SHOWN",
    metadata: { source: "detail_page" },
  });
}

/**
 * Log REVIEWED / APPROVED / REJECTED when review status is set.
 */
export async function logReviewStatus(
  recommendationId: string,
  funderAddress: string,
  status: string
): Promise<void> {
  const eventType =
    status === "APPROVED" ? "APPROVED" : status === "REJECTED" ? "REJECTED" : "REVIEWED";
  await logLifecycleEvent({
    recommendationId,
    funderAddress,
    eventType,
    metadata: { reviewStatus: status },
  });
}

/**
 * Log PREVIEWED when order preview is requested for a recommendation.
 */
export async function logPreviewed(
  recommendationId: string,
  funderAddress: string,
  metadata?: { marketId?: string; side?: string; size?: string; price?: string }
): Promise<void> {
  await logLifecycleEvent({
    recommendationId,
    funderAddress,
    eventType: "PREVIEWED",
    metadata: metadata ?? {},
  });
}

/**
 * Log INTENT_CREATED when an OrderIntent is created with a recommendationId.
 */
export async function logIntentCreated(
  recommendationId: string,
  funderAddress: string,
  orderIntentId: string,
  metadata?: { side?: string; size?: string; limitPrice?: string }
): Promise<void> {
  await logLifecycleEvent({
    recommendationId,
    funderAddress,
    eventType: "INTENT_CREATED",
    metadata: { orderIntentId, ...metadata },
  });
}

/**
 * Log ORDER_PLACED when an order is successfully placed (ExecutedOrder created).
 */
export async function logOrderPlaced(
  recommendationId: string,
  funderAddress: string,
  orderIntentId: string,
  executedOrderId: string,
  metadata?: { polymarketOrderId?: string; side?: string; size?: string; price?: string }
): Promise<void> {
  await logLifecycleEvent({
    recommendationId,
    funderAddress,
    eventType: "ORDER_PLACED",
    metadata: { orderIntentId, executedOrderId, ...metadata },
  });
}

/**
 * Log ORDER_CANCELLED when an order linked to a recommendation is cancelled.
 */
export async function logOrderCancelled(
  recommendationId: string,
  funderAddress: string,
  metadata?: { polymarketOrderId?: string }
): Promise<void> {
  await logLifecycleEvent({
    recommendationId,
    funderAddress,
    eventType: "ORDER_CANCELLED",
    metadata: metadata ?? {},
  });
}

/**
 * Log FILLED when we detect an order was filled (e.g. from user sync). Optional; can be called from execution-outcomes builder.
 */
export async function logFilled(
  recommendationId: string,
  funderAddress: string,
  metadata?: { executedOrderId?: string; size?: string; price?: string }
): Promise<void> {
  await logLifecycleEvent({
    recommendationId,
    funderAddress,
    eventType: "FILLED",
    metadata: metadata ?? {},
  });
}

/**
 * Log SKIPPED when user explicitly skips or does not act on a recommendation. Optional; call from UI or inferred later.
 */
export async function logSkipped(
  recommendationId: string,
  funderAddress: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  await logLifecycleEvent({
    recommendationId,
    funderAddress,
    eventType: "SKIPPED",
    metadata: metadata ?? {},
  });
}
