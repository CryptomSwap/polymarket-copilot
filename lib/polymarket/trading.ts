/**
 * Manual order placement and cancel via Polymarket CLOB.
 * Requires POLYMARKET_SIGNER_PRIVATE_KEY (funder/proxy wallet) for server-side placement.
 * All callers must pass executionSurface; platform policy gates real CLOB execution.
 *
 * Order lifecycle is persisted through the execution-ledger service (OrderIntent, ExecutedOrder, events)
 * so the API path shares the same durable audit trail as the runtime path.
 */

import { Wallet } from "ethers";
import type { ExecutionSurface } from "@/lib/runtime/trading-execution-policy";
import { assertExecutionAllowed } from "@/lib/runtime/trading-execution-policy";
import { ClobClient, OrderType, Side } from "@polymarket/clob-client";
import { prisma } from "@/lib/db";
import { getStoredCredentials } from "./auth";
import { createAuthenticatedClobClient } from "./client";
import {
  createIntentWithEvent,
  appendOrderIntentEventToLedger,
  markOrderIntentStatusInLedger,
  createExecutedOrderForIntent,
  appendExecutedOrderEventForOrder,
  getIntentTimeline,
  getExecutedOrder,
} from "@/lib/execution-ledger/service";
import { buildApiOrderIdempotencyKey } from "@/lib/execution-ledger/idempotency";

const ORDER_INTENT_STATUS_PLACED = "placed";
const ORDER_INTENT_STATUS_FAILED = "failed";
const ORDER_INTENT_STATUS_PENDING = "pending";
const EXECUTED_ORDER_STATUS_SUBMITTED = "submitted";

/**
 * Get signer for trading. Requires POLYMARKET_SIGNER_PRIVATE_KEY (optional env).
 * When not set, place order will fail with a clear error.
 */
export function getSignerForTrading(): Wallet | null {
  const key = process.env.POLYMARKET_SIGNER_PRIVATE_KEY;
  if (!key || typeof key !== "string" || !key.trim()) return null;
  const hex = key.trim().startsWith("0x") ? key.trim() : `0x${key.trim()}`;
  try {
    return new Wallet(hex);
  } catch {
    return null;
  }
}

/**
 * Create authenticated CLOB client for trading (place/cancel).
 * Returns null if signer or credentials are missing.
 */
export async function getClobClientForTrading(): Promise<ClobClient | null> {
  const signer = getSignerForTrading();
  if (!signer) return null;
  const { credential: creds } = await getStoredCredentials();
  if (!creds) return null;
  return createAuthenticatedClobClient(
    signer,
    { key: creds.apiKey, secret: creds.secret, passphrase: creds.passphrase },
    creds.signatureType,
    creds.funderAddress
  );
}

export interface PlaceOrderInput {
  funderAddress: string;
  marketId: string;
  assetId: string;
  outcome: string;
  side: "BUY" | "SELL";
  orderType?: string;
  limitPrice: string;
  size: string;
  recommendationId?: string | null;
  riskPreviewJson?: string | null;
}

export interface PlaceOrderResult {
  success: boolean;
  orderIntentId?: string;
  polymarketOrderId?: string;
  executedOrderId?: string;
  error?: string;
}

export interface PlaceOrderOptions {
  /** Execution surface for platform policy gate. Required for all real order placement. */
  executionSurface: ExecutionSurface;
}

/**
 * If the intent was already placed (has ExecutedOrder), return the existing result.
 */
async function existingPlacedResult(intentId: string): Promise<PlaceOrderResult | null> {
  const timeline = await getIntentTimeline(intentId, 50);
  const executedOrderRow = timeline.find((r) => r.kind === "executed_order");
  if (!executedOrderRow?.id) return null;
  const exec = await getExecutedOrder(executedOrderRow.id);
  if (!exec) return null;
  return {
    success: true,
    orderIntentId: intentId,
    polymarketOrderId: exec.polymarketOrderId,
    executedOrderId: exec.id,
  };
}

/**
 * Create OrderIntent via execution-ledger (idempotent), place limit order on CLOB, persist ExecutedOrder and events.
 * Duplicate requests with the same idempotency key return the existing intent/order without calling CLOB again.
 */
export async function placeLimitOrder(
  input: PlaceOrderInput,
  options: PlaceOrderOptions
): Promise<PlaceOrderResult> {
  assertExecutionAllowed(options.executionSurface);

  const client = await getClobClientForTrading();
  if (!client) {
    return {
      success: false,
      error: "Trading not configured. Set POLYMARKET_SIGNER_PRIVATE_KEY and ensure API credentials are initialized.",
    };
  }

  const price = parseFloat(input.limitPrice);
  const size = parseFloat(input.size);
  if (!Number.isFinite(price) || price <= 0 || price >= 1 || !Number.isFinite(size) || size <= 0) {
    return { success: false, error: "Invalid price or size." };
  }

  const orderType = OrderType.GTC;
  const funder = input.funderAddress.toLowerCase().trim();
  const idempotencyKey = buildApiOrderIdempotencyKey({
    funderAddress: funder,
    assetId: input.assetId,
    side: input.side,
    orderType: String(orderType),
    limitPrice: price,
    requestedSize: size,
    recommendationId: input.recommendationId ?? null,
  });

  const intentInput = {
    funderAddress: funder,
    recommendationId: input.recommendationId ?? null,
    source: "api",
    marketId: input.marketId,
    assetId: input.assetId,
    outcome: input.outcome,
    side: input.side,
    orderType: String(orderType),
    limitPrice: input.limitPrice,
    requestedSize: input.size,
    status: ORDER_INTENT_STATUS_PENDING,
    idempotencyKey,
    riskPreviewJson: input.riskPreviewJson ?? null,
  };

  const { intent, existing } = await createIntentWithEvent(intentInput, {
    eventType: "CREATED",
    payloadJson: JSON.stringify({ source: "api", at: new Date().toISOString() }),
  });
  await appendOrderIntentEventToLedger({
    orderIntentId: intent.id,
    eventType: "API_REQUESTED",
    payloadJson: JSON.stringify({ at: new Date().toISOString() }),
  });

  if (existing) {
    const alreadyPlaced = await existingPlacedResult(intent.id);
    if (alreadyPlaced) return alreadyPlaced;
    if (intent.status === ORDER_INTENT_STATUS_FAILED) {
      return {
        success: false,
        orderIntentId: intent.id,
        error: "Previous attempt to place this order failed.",
      };
    }
  }

  try {
    const side = input.side === "SELL" ? Side.SELL : Side.BUY;
    const response = await client.createAndPostOrder(
      {
        tokenID: input.assetId,
        price,
        size,
        side,
      },
      undefined,
      orderType
    );

    const orderId = response?.orderID ?? response?.order_id ?? response?.id ?? null;
    if (!orderId) {
      await appendOrderIntentEventToLedger({
        orderIntentId: intent.id,
        eventType: "FAILED",
        payloadJson: JSON.stringify({ reason: "no_order_id_from_clob", at: new Date().toISOString() }),
      });
      await markOrderIntentStatusInLedger(intent.id, ORDER_INTENT_STATUS_FAILED);
      return {
        success: false,
        orderIntentId: intent.id,
        error: "Place succeeded but no order ID returned.",
      };
    }

    await markOrderIntentStatusInLedger(intent.id, ORDER_INTENT_STATUS_PLACED);
    await appendOrderIntentEventToLedger({
      orderIntentId: intent.id,
      eventType: "READY_FOR_SUBMISSION",
      payloadJson: JSON.stringify({ polymarketOrderId: String(orderId), at: new Date().toISOString() }),
    });

    const { executedOrderId } = await createExecutedOrderForIntent(
      {
        funderAddress: funder,
        marketId: input.marketId,
        assetId: input.assetId,
        side: input.side,
        orderType: String(orderType),
        price: input.limitPrice,
        size: input.size,
        originalSize: input.size,
        remainingSize: input.size,
        status: EXECUTED_ORDER_STATUS_SUBMITTED,
        venue: "polymarket",
        polymarketOrderId: String(orderId),
        venueOrderId: String(orderId),
        rawJson: JSON.stringify(response ?? {}),
      },
      { linkToIntentId: intent.id }
    );
    await appendExecutedOrderEventForOrder({
      executedOrderId,
      eventType: "SUBMITTED",
      payloadJson: JSON.stringify({ polymarketOrderId: String(orderId), at: new Date().toISOString() }),
    });

    return {
      success: true,
      orderIntentId: intent.id,
      polymarketOrderId: String(orderId),
      executedOrderId,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await appendOrderIntentEventToLedger({
      orderIntentId: intent.id,
      eventType: "FAILED",
      payloadJson: JSON.stringify({ reason: message, at: new Date().toISOString() }),
    });
    await markOrderIntentStatusInLedger(intent.id, ORDER_INTENT_STATUS_FAILED);
    return {
      success: false,
      orderIntentId: intent.id,
      error: message,
    };
  }
}

export interface CancelOrderOptions {
  /** Execution surface for platform policy gate. Required for all real cancel. */
  executionSurface: ExecutionSurface;
}

/**
 * Cancel an open order by Polymarket order ID.
 * Caller must pass executionSurface; assertExecutionAllowed is called before CLOB cancel.
 */
export async function cancelOrderByPolymarketId(
  funderAddress: string,
  polymarketOrderId: string,
  options: CancelOrderOptions
): Promise<{ success: boolean; error?: string }> {
  assertExecutionAllowed(options.executionSurface);

  const client = await getClobClientForTrading();
  if (!client) {
    return {
      success: false,
      error: "Trading not configured. Set POLYMARKET_SIGNER_PRIVATE_KEY.",
    };
  }

  try {
    await client.cancelOrder({ orderID: polymarketOrderId });
    const local = await prisma.userOrder.findFirst({
      where: { funderAddress, orderId: polymarketOrderId },
    });
    if (local) {
      await prisma.userOrder.update({
        where: { funderAddress_orderId: { funderAddress: local.funderAddress, orderId: local.orderId } },
        data: { status: "cancelled" },
      });
    }
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}
