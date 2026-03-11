import { NextResponse } from "next/server";
import { recomputePortfolio } from "@/lib/polymarket/recompute";
import { z } from "zod";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ funderAddress: z.string().optional() }).optional();

/**
 * POST /api/portfolio/recompute
 * Rebuilds DerivedPosition, PortfolioSnapshot, and BehaviorFlag from synced data.
 */
export async function POST(request: Request) {
  let body: z.infer<typeof bodySchema> = undefined;
  try {
    const raw = await request.json().catch(() => ({}));
    body = bodySchema.parse(raw);
  } catch {
    body = undefined;
  }
  const funderAddress = body?.funderAddress;
  const result = await recomputePortfolio(funderAddress);
  if (result.errors.length > 0 && result.positionsWritten === 0 && !result.snapshotCreated) {
    return NextResponse.json(
      { success: false, error: result.errors[0], result },
      { status: 400 }
    );
  }
  return NextResponse.json({ success: true, result });
}
