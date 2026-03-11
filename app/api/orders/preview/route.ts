import { NextResponse } from "next/server";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";
import { buildOrderPreview } from "@/lib/polymarket/order-preview";
import { logPreviewed } from "@/lib/analytics/lifecycle";
import { z } from "zod";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  marketId: z.string(),
  assetId: z.string().optional(),
  outcome: z.string(),
  side: z.enum(["BUY", "SELL"]),
  limitPrice: z.string(),
  size: z.string(),
  recommendationId: z.string().optional().nullable(),
});

/**
 * POST /api/orders/preview
 * Validate market/asset/side/price/size and return risk preview and warnings.
 * Manual approval only; no order placed.
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

  const result = await buildOrderPreview({
    funderAddress: funder,
    marketId: body.marketId,
    assetId: body.assetId,
    outcome: body.outcome,
    side: body.side,
    limitPrice: body.limitPrice,
    size: body.size,
    recommendationId: body.recommendationId,
  });

  if (!result.valid) {
    return NextResponse.json(
      { valid: false, validationErrors: result.validationErrors, riskPreview: null, marketTitle: result.marketTitle },
      { status: 400 }
    );
  }

  if (body.recommendationId) {
    void logPreviewed(body.recommendationId, funder, {
      marketId: body.marketId,
      side: body.side,
      size: body.size,
      price: body.limitPrice,
    });
  }

  return NextResponse.json({
    valid: true,
    validationErrors: [],
    riskPreview: result.riskPreview,
    marketTitle: result.marketTitle,
  });
}
