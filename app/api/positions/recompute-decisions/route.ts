import { NextResponse } from "next/server";
import { recomputePositionDecisions } from "@/lib/position/recompute";

export const dynamic = "force-dynamic";

/**
 * POST /api/positions/recompute-decisions
 * Recompute position exit decisions (HOLD, TRIM, REDUCE, EXIT, TAKE_PROFIT, THESIS_BROKEN) for all derived positions.
 */
export async function POST() {
  const result = await recomputePositionDecisions();
  if (result.errors.length > 0 && result.snapshotsUpserted === 0) {
    return NextResponse.json(
      { error: result.errors[0], errors: result.errors },
      { status: 400 }
    );
  }
  return NextResponse.json({
    success: true,
    funderAddress: result.funderAddress,
    snapshotsUpserted: result.snapshotsUpserted,
    errors: result.errors,
  });
}
