import { NextResponse } from "next/server";
import { recomputeDecisions } from "@/lib/decision/recompute";

export const dynamic = "force-dynamic";

/**
 * POST /api/decision/recompute
 * Rebuild setup performance profiles and decision snapshots for current recommendations.
 */
export async function POST(request: Request) {
  let funderAddress: string | undefined;
  try {
    const body = await request.json().catch(() => ({}));
    funderAddress = typeof body.funderAddress === "string" ? body.funderAddress : undefined;
  } catch {
    funderAddress = undefined;
  }

  const result = await recomputeDecisions(funderAddress);
  if (result.errors.length > 0 && result.snapshotsUpserted === 0 && result.funderAddress === "") {
    return NextResponse.json(
      { success: false, error: result.errors[0] ?? "Recompute failed." },
      { status: 400 }
    );
  }
  return NextResponse.json({
    success: true,
    funderAddress: result.funderAddress,
    profilesCreated: result.profilesCreated,
    profilesUpdated: result.profilesUpdated,
    snapshotsUpserted: result.snapshotsUpserted,
    errors: result.errors,
  });
}
