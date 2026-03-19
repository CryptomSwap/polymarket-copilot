import { NextResponse } from "next/server";
import { getFunderForDecisionRecompute } from "@/lib/decision/recompute";
import { buildBlockReport } from "@/lib/decision/block-report";

export const dynamic = "force-dynamic";

/**
 * GET /api/decision/block-report
 * Aggregate report on why recommendations are BLOCKed: counts by block reason, category (eligibility, theme concentration, portfolio fit, market quality, liquidity, low score), and sample rows.
 * Query: ?funderAddress=0x... to scope to a funder; otherwise uses same resolution as paper trading (funder with most snapshots, then wallet, then any rec funder).
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const funderParam = searchParams.get("funderAddress")?.trim();
    const funder = funderParam ?? (await getFunderForDecisionRecompute());
    const report = await buildBlockReport(funder ?? undefined);
    return NextResponse.json({
      funderAddress: funder ?? null,
      ...report,
    });
  } catch (e) {
    console.error("[GET /api/decision/block-report]", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Block report failed" },
      { status: 500 }
    );
  }
}
