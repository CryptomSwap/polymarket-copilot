import { NextResponse } from "next/server";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";
import { backfillSyncedMarketIds } from "@/lib/polymarket/portfolio";
import { z } from "zod";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ funderAddress: z.string().optional() }).optional();

/**
 * POST /api/portfolio/backfill-canonical-market-ids
 * Backfills syncedMarketId on existing DerivedPosition rows where it is null.
 * Uses current market resolution; unresolved positions stay null. Safe to run repeatedly.
 */
export async function POST(request: Request) {
  let body: z.infer<typeof bodySchema> = undefined;
  try {
    const raw = await request.json().catch(() => ({}));
    body = bodySchema.parse(raw);
  } catch {
    body = undefined;
  }

  const funder = body?.funderAddress?.trim() ?? (await getFunderForRecompute());
  if (!funder) {
    return NextResponse.json(
      { error: "No funder address. Connect wallet and save connection." },
      { status: 400 }
    );
  }

  const result = await backfillSyncedMarketIds(funder);
  if (result.processed > 0) {
    console.info("[backfill-canonical-market-ids]", JSON.stringify({
      funder: result.funderAddress,
      processed: result.processed,
      updated: result.updated,
      byMarketId: result.resolvedByMarketId,
      byConditionId: result.resolvedByConditionId,
      byAssetId: result.resolvedByAssetId,
      stillUnresolved: result.stillUnresolved,
    }));
  }
  return NextResponse.json({ success: result.errors.length === 0, result });
}
