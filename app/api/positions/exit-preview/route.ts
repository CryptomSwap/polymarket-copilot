import { NextResponse } from "next/server";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";
import { buildExitPreview, type ExitType } from "@/lib/position/exit-preview";
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
 * POST /api/positions/exit-preview
 * Preview exit: effect on exposure, realized/unrealized lock-in, concentration relief.
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

  const result = await buildExitPreview({
    funderAddress: funder,
    assetId: body.assetId,
    marketId: body.marketId,
    exitType: body.exitType as ExitType,
    size: body.size,
    limitPrice: body.limitPrice,
    recommendationId: body.recommendationId ?? undefined,
  });

  return NextResponse.json(result);
}
