import { NextResponse } from "next/server";
import {
  getFunderForDecisionRecompute,
  recomputeDecisions,
} from "@/lib/decision/recompute";

export const dynamic = "force-dynamic";

/**
 * POST /api/paper-trading/ensure-decision-snapshots
 * Generate decision snapshots for all current recommendations so paper trading has candidates.
 * Uses connected wallet/creds first, then any funder that has recommendations (paper-trading compatible).
 * Call this when diagnostics show "filtering_removed_all_no_decision_snapshot".
 */
export async function POST(request: Request) {
  try {
    let funderOverride: string | undefined;
    try {
      const body = await request.json().catch(() => ({}));
      funderOverride =
        typeof body.funderAddress === "string" ? body.funderAddress : undefined;
    } catch {
      funderOverride = undefined;
    }

    const funder = await getFunderForDecisionRecompute(funderOverride);
    if (!funder) {
      return NextResponse.json(
        {
          success: false,
          error:
            "No funder. Connect wallet and save connection, or ensure recommendations exist for a funder.",
        },
        { status: 400 }
      );
    }

    const result = await recomputeDecisions(funder);
    return NextResponse.json({
      success: true,
      funderAddress: result.funderAddress,
      profilesCreated: result.profilesCreated,
      profilesUpdated: result.profilesUpdated,
      snapshotsUpserted: result.snapshotsUpserted,
      errors: result.errors,
    });
  } catch (e) {
    console.error("[POST /api/paper-trading/ensure-decision-snapshots]", e);
    return NextResponse.json(
      {
        success: false,
        error: e instanceof Error ? e.message : "Ensure decision snapshots failed",
      },
      { status: 500 }
    );
  }
}
