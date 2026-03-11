import { NextResponse } from "next/server";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";
import { reconcileOrders } from "@/lib/polymarket/reconcile";

export const dynamic = "force-dynamic";

/**
 * POST /api/live/reconcile-affected
 * Run reconciliation for the current funder (all executed orders).
 * Use after live events or to refresh local vs remote state.
 */
export async function POST(request: Request) {
  const funder = await getFunderForRecompute();
  if (!funder) {
    return NextResponse.json(
      { error: "No funder address. Connect wallet and save connection." },
      { status: 400 }
    );
  }

  const result = await reconcileOrders(funder);
  return NextResponse.json({
    success: true,
    reconciled: result.reconciled,
    mismatches: result.mismatches,
    errors: result.errors,
  });
}
