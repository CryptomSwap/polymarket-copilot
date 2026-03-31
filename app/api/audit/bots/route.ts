import { NextRequest, NextResponse } from "next/server";
import { buildBotScorecards } from "@/lib/control-plane/audit";

export const dynamic = "force-dynamic";

/**
 * GET /api/audit/bots
 * Machine-readable per-bot audit scorecards for paper-only control-plane decisions.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const lookbackDaysRaw = Number(searchParams.get("lookbackDays") ?? "14");
    const lookbackDays = Number.isFinite(lookbackDaysRaw) ? Math.max(1, Math.min(90, Math.floor(lookbackDaysRaw))) : 14;
    const result = await buildBotScorecards(lookbackDays);
    return NextResponse.json({
      scope: "paper_only",
      lookbackDays,
      ...result,
    });
  } catch (error) {
    console.error("[GET /api/audit/bots]", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Bot audit failed" },
      { status: 500 }
    );
  }
}
