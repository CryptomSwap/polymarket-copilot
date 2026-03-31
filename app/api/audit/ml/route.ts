import { NextRequest, NextResponse } from "next/server";
import { buildMlScorecard } from "@/lib/control-plane/audit";

export const dynamic = "force-dynamic";

/**
 * GET /api/audit/ml
 * Machine-readable ML effectiveness scorecard for paper-only governance decisions.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const lookbackDaysRaw = Number(searchParams.get("lookbackDays") ?? "14");
    const lookbackDays = Number.isFinite(lookbackDaysRaw) ? Math.max(1, Math.min(90, Math.floor(lookbackDaysRaw))) : 14;
    const scorecard = await buildMlScorecard(lookbackDays);
    return NextResponse.json({
      scope: "paper_only",
      lookbackDays,
      scorecard,
    });
  } catch (error) {
    console.error("[GET /api/audit/ml]", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "ML audit failed" },
      { status: 500 }
    );
  }
}
