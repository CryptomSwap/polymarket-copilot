import { NextResponse } from "next/server";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";
import { runPreflightChecks } from "@/lib/polymarket/preflight";
import { z } from "zod";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  marketId: z.string(),
  assetId: z.string().optional(),
  outcome: z.string().optional(),
  limitPrice: z.string(),
  size: z.string(),
  recommendationId: z.string().optional().nullable(),
});

/**
 * POST /api/orders/preflight
 * Run preflight checks for an order. Returns passed, warnings, and persists TradePreflightCheck.
 * Block place when preflight fails unless explicitly overridden.
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
      { error: "Invalid body. Required: marketId, limitPrice, size. Optional: assetId, outcome, recommendationId." },
      { status: 400 }
    );
  }

  let assetId = body.assetId;
  if (!assetId && body.outcome && body.marketId) {
    const { prisma } = await import("@/lib/db");
    const asset = await prisma.syncedAsset.findFirst({
      where: { syncedMarketId: body.marketId, outcome: { equals: body.outcome, mode: "insensitive" } },
    });
    assetId = asset?.tokenId ?? undefined;
  }
  if (!assetId) {
    return NextResponse.json(
      { error: "Could not resolve assetId. Provide assetId or outcome." },
      { status: 400 }
    );
  }

  const result = await runPreflightChecks({
    funderAddress: funder,
    recommendationId: body.recommendationId ?? undefined,
    marketId: body.marketId,
    assetId,
    limitPrice: body.limitPrice,
    size: body.size,
  });

  return NextResponse.json({
    passed: result.passed,
    preflightId: result.preflightId,
    geoblockOk: result.geoblockOk,
    balanceOk: result.balanceOk,
    allowanceOk: result.allowanceOk,
    marketActiveOk: result.marketActiveOk,
    tickSizeOk: result.tickSizeOk,
    feeKnown: result.feeKnown,
    warnings: result.warnings,
  });
}
