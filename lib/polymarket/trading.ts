/**
 * Manual order placement and cancel via Polymarket CLOB.
 * Requires POLYMARKET_SIGNER_PRIVATE_KEY (funder/proxy wallet) for server-side placement.
 * All callers must pass executionSurface; platform policy gates real CLOB execution.
 */

import { Wallet } from "ethers";
import type { ExecutionSurface } from "@/lib/runtime/trading-execution-policy";
import { assertExecutionAllowed } from "@/lib/runtime/trading-execution-policy";
import { ClobClient, OrderType, Side } from "@polymarket/clob-client";
import { prisma } from "@/lib/db";
import { getStoredCredentials } from "./auth";
import { createAuthenticatedClobClient } from "./client";

const ORDER_INTENT_STATUS_PLACED = "placed";
const ORDER_INTENT_STATUS_FAILED = "failed";
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
  const creds = await getStoredCredentials();
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
 * Create OrderIntent, place limit order on CLOB, persist ExecutedOrder.
 * Caller must pass executionSurface; assertExecutionAllowed is called before any CLOB call.
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

  const side = input.side === "SELL" ? Side.SELL : Side.BUY;
  const orderType = OrderType.GTC;

  const intent = await prisma.orderIntent.create({
    data: {
      funderAddress: input.funderAddress,
      recommendationId: input.recommendationId ?? undefined,
      marketId: input.marketId,
      assetId: input.assetId,
      outcome: input.outcome,
      side: input.side,
      orderType: orderType,
      limitPrice: input.limitPrice,
      size: input.size,
      status: "pending",
      riskPreviewJson: input.riskPreviewJson ?? undefined,
    },
  });

  try {
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
      await prisma.orderIntent.update({
        where: { id: intent.id },
        data: { status: ORDER_INTENT_STATUS_FAILED },
      });
      return {
        success: false,
        orderIntentId: intent.id,
        error: "Place succeeded but no order ID returned.",
      };
    }

    await prisma.orderIntent.update({
      where: { id: intent.id },
      data: { status: ORDER_INTENT_STATUS_PLACED },
    });

    const executed = await prisma.executedOrder.create({
      data: {
        funderAddress: input.funderAddress,
        orderIntentId: intent.id,
        polymarketOrderId: String(orderId),
        marketId: input.marketId,
        assetId: input.assetId,
        side: input.side,
        price: input.limitPrice,
        size: input.size,
        status: EXECUTED_ORDER_STATUS_SUBMITTED,
        rawJson: JSON.stringify(response ?? {}),
      },
    });

    return {
      success: true,
      orderIntentId: intent.id,
      polymarketOrderId: String(orderId),
      executedOrderId: executed.id,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.orderIntent.update({
      where: { id: intent.id },
      data: { status: ORDER_INTENT_STATUS_FAILED },
    });
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
