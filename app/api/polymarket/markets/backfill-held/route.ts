/**
 * POST /api/polymarket/markets/backfill-held
 * Backfills SyncedMarket + SyncedAsset for conditionIds the connected funder holds
 * (from UserFill.market) that are not already in the catalog. Uses Gamma API
 * GET /markets?condition_ids=<id> for exact lookup. Run portfolio recompute after
 * to resolve positions.
 */

import { NextResponse } from "next/server";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";
import { backfillHeldMarkets } from "@/lib/polymarket/markets";

export const dynamic = "force-dynamic";

export async function POST() {
  const funder = await getFunderForRecompute();
  if (!funder) {
    return NextResponse.json(
      { error: "No funder address. Connect wallet and save connection." },
      { status: 400 }
    );
  }

  try {
    const result = await backfillHeldMarkets(funder);
    return NextResponse.json({
      success: result.errors.length === 0 || result.upsertedMarkets > 0,
      ...result,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Backfill failed";
    console.error("[POST /api/polymarket/markets/backfill-held]", error);
    return NextResponse.json(
      { error: "Backfill failed", details: message },
      { status: 500 }
    );
  }
}
