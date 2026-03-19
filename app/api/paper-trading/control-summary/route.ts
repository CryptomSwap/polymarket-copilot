import { NextRequest, NextResponse } from "next/server";
import { getPaperTradingControlSummary } from "@/lib/paper-trading/control-summary";

export const dynamic = "force-dynamic";

/**
 * GET /api/paper-trading/control-summary
 * Unified paper decision-control summary per bot (paper-only).
 */
export async function GET(_request: NextRequest) {
  try {
    const bots = await getPaperTradingControlSummary();
    return NextResponse.json({ bots });
  } catch (e) {
    console.error("[GET /api/paper-trading/control-summary]", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Control summary failed" },
      { status: 500 }
    );
  }
}

