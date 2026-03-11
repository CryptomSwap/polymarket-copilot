import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";
import { placeLimitOrder } from "@/lib/polymarket/trading";
import { buildOrderPreview } from "@/lib/polymarket/order-preview";
import { runPreflightChecks } from "@/lib/polymarket/preflight";
import { logIntentCreated, logOrderPlaced } from "@/lib/analytics/lifecycle";
import { z } from "zod";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  marketId: z.string(),
  assetId: z.string().optional(),
  outcome: z.string(),
  side: z.enum(["BUY", "SELL"]),
  limitPrice: z.string(),
  size: z.string(),
  orderType: z.string().optional(),
  recommendationId: z.string().optional().nullable(),
  skipBlockedCheck: z.boolean().optional(),
  skipPreflightCheck: z.boolean().optional(),
});

/**
 * POST /api/orders/place
 * Require manual input or recommendationId. Create OrderIntent, place limit order, persist ExecutedOrder.
 * Manual approval only; no autonomous execution.
 * TODO: Geoblock / allowance checks when available.
 */
export async function POST(request: Request) {
  const funder = await getFunderForRecompute();
  if (!funder) {
    return NextResponse.json(
      { error: "No funder address. Connect wallet and save connection." },
      { status: 400 }
    );
  }

  let body: z.infer<typeof bodySchema>;
  try {
    const raw = await request.json().catch(() => ({}));
    body = bodySchema.parse(raw);
  } catch {
    return NextResponse.json(
      { error: "Invalid body. Required: marketId, assetId, outcome, side, limitPrice, size." },
      { status: 400 }
    );
  }

  let assetId = body.assetId;
  if (!assetId) {
    const asset = await prisma.syncedAsset.findFirst({
      where: { syncedMarketId: body.marketId, outcome: { equals: body.outcome, mode: "insensitive" } },
    });
    assetId = asset?.tokenId ?? undefined;
  }
  if (!assetId) {
    return NextResponse.json(
      { success: false, error: "Could not resolve assetId from marketId and outcome." },
      { status: 400 }
    );
  }

  const preview = await buildOrderPreview({
    funderAddress: funder,
    marketId: body.marketId,
    assetId,
    outcome: body.outcome,
    side: body.side,
    limitPrice: body.limitPrice,
    size: body.size,
    recommendationId: body.recommendationId,
  });

  if (!preview.valid) {
    return NextResponse.json(
      { success: false, error: preview.validationErrors.join("; ") },
      { status: 400 }
    );
  }

  if (preview.riskPreview?.blocked && !body.skipBlockedCheck) {
    return NextResponse.json(
      {
        success: false,
        error: "Order blocked by concentration/safety rules. Override with skipBlockedCheck only if you accept the risk.",
        riskPreview: preview.riskPreview,
      },
      { status: 400 }
    );
  }

  if (!body.skipPreflightCheck) {
    const preflight = await runPreflightChecks({
      funderAddress: funder,
      recommendationId: body.recommendationId ?? undefined,
      marketId: body.marketId,
      assetId: assetId!,
      limitPrice: body.limitPrice,
      size: body.size,
    });
    if (!preflight.passed) {
      return NextResponse.json(
        {
          success: false,
          error: "Preflight checks failed. Fix issues or override with skipPreflightCheck.",
          preflight: { passed: false, warnings: preflight.warnings },
        },
        { status: 400 }
      );
    }
  }

  const riskPreviewJson = preview.riskPreview ? JSON.stringify(preview.riskPreview) : undefined;

  let result;
  try {
    result = await placeLimitOrder(
      {
        funderAddress: funder,
        marketId: body.marketId,
        assetId,
        outcome: body.outcome,
        side: body.side,
        orderType: body.orderType,
        limitPrice: body.limitPrice,
        size: body.size,
        recommendationId: body.recommendationId,
        riskPreviewJson,
      },
      { executionSurface: "manual_api" }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("[trading-execution-policy]")) {
      return NextResponse.json(
        { success: false, error: message },
        { status: 403 }
      );
    }
    throw err;
  }

  if (!result.success) {
    return NextResponse.json(
      { success: false, orderIntentId: result.orderIntentId, error: result.error },
      { status: 400 }
    );
  }

  if (body.recommendationId && result.orderIntentId && result.executedOrderId) {
    void logIntentCreated(body.recommendationId, funder, result.orderIntentId, {
      side: body.side,
      size: body.size,
      limitPrice: body.limitPrice,
    });
    void logOrderPlaced(
      body.recommendationId,
      funder,
      result.orderIntentId,
      result.executedOrderId,
      { polymarketOrderId: result.polymarketOrderId, side: body.side, size: body.size, price: body.limitPrice }
    );
  }

  return NextResponse.json({
    success: true,
    orderIntentId: result.orderIntentId,
    polymarketOrderId: result.polymarketOrderId,
    executedOrderId: result.executedOrderId,
  });
}
