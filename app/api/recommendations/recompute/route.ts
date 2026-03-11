import { NextResponse } from "next/server";
import { recomputeRecommendations } from "@/lib/polymarket/recommendations-recompute";
import { z } from "zod";

export const dynamic = "force-dynamic";

const bodySchema = z
  .object({
    funderAddress: z.string().optional(),
    captureSnapshotsFirst: z.boolean().optional(),
  })
  .optional();

/**
 * POST /api/recommendations/recompute
 * Optionally captures market snapshots first, then rebuilds MarketSignal and Recommendation.
 * Read-only; no order placement.
 */
export async function POST(request: Request) {
  let body: z.infer<typeof bodySchema> = undefined;
  try {
    const raw = await request.json().catch(() => ({}));
    body = bodySchema.parse(raw);
  } catch {
    body = undefined;
  }
  const result = await recomputeRecommendations(body?.funderAddress, {
    captureSnapshotsFirst: body?.captureSnapshotsFirst,
  });
  if (result.errors.length > 0 && result.signalsWritten === 0) {
    return NextResponse.json(
      { success: false, error: result.errors[0], result },
      { status: 400 }
    );
  }
  return NextResponse.json({ success: true, result });
}
