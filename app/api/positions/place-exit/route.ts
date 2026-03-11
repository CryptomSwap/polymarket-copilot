import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";
import { buildExitPreview, type ExitType } from "@/lib/position/exit-preview";
import { placeLimitOrder } from "@/lib/polymarket/trading";
import { z } from "zod";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  assetId: z.string(),
  marketId: z.string(),
  exitType: z.enum(["TRIM", "REDUCE", "EXIT", "TAKE_PROFIT", "THESIS_BROKEN"]),
  size: z.string(),
  limitPrice: z.string(),
  recommendationId: z.string().optional().nullable(),
});

/**
 * POST /api/positions/place-exit
 * Manual exit only: create ExitIntent, place SELL order via existing order infrastructure.
 * No autonomous exits.
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
      { error: "Invalid body. Required: assetId, marketId, exitType, size, limitPrice." },
      { status: 400 }
    );
  }

  const preview = await buildExitPreview({
    funderAddress: funder,
    assetId: body.assetId,
    marketId: body.marketId,
    exitType: body.exitType as ExitType,
    size: body.size,
    limitPrice: body.limitPrice,
    recommendationId: body.recommendationId ?? undefined,
  });

  if (!preview.valid) {
    return NextResponse.json(
      { success: false, error: preview.validationErrors.join("; ") },
      { status: 400 }
    );
  }

  const position = await prisma.derivedPosition.findUnique({
    where: { funderAddress_assetId: { funderAddress: funder, assetId: body.assetId } },
  });
  if (!position) {
    return NextResponse.json(
      { success: false, error: "Position not found." },
      { status: 400 }
    );
  }

  const exitIntent = await prisma.exitIntent.create({
    data: {
      funderAddress: funder,
      assetId: body.assetId,
      marketId: body.marketId,
      recommendationId: body.recommendationId ?? undefined,
      side: "SELL",
      exitType: body.exitType,
      limitPrice: body.limitPrice,
      size: body.size,
      status: "pending",
      previewJson: JSON.stringify({
        estimatedRealizedPnl: preview.estimatedRealizedPnl,
        concentrationPctAfter: preview.concentrationPctAfter,
        warnings: preview.warnings,
      }),
    },
  });

  let placeResult;
  try {
    placeResult = await placeLimitOrder(
      {
        funderAddress: funder,
        marketId: body.marketId,
        assetId: body.assetId,
        outcome: position.outcome,
        side: "SELL",
        limitPrice: body.limitPrice,
        size: body.size,
        recommendationId: body.recommendationId ?? undefined,
      },
      { executionSurface: "position_exit" }
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

  if (!placeResult.success) {
    await prisma.exitIntent.update({
      where: { id: exitIntent.id },
      data: { status: "failed" },
    });
    return NextResponse.json({
      success: false,
      error: placeResult.error,
      exitIntentId: exitIntent.id,
    }, { status: 400 });
  }

  await prisma.exitIntent.update({
    where: { id: exitIntent.id },
    data: { status: "placed" },
  });

  return NextResponse.json({
    success: true,
    exitIntentId: exitIntent.id,
    polymarketOrderId: placeResult.polymarketOrderId,
    executedOrderId: placeResult.executedOrderId,
  });
}
