import { NextRequest, NextResponse } from "next/server";
import { buildControlPlaneIssues } from "@/lib/control-plane/issues";

export const dynamic = "force-dynamic";

/**
 * GET /api/audit/issues
 * Deterministic issue generation from bot/ML/runtime control-plane scorecards.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const lookbackDaysRaw = Number(searchParams.get("lookbackDays") ?? "14");
    const lookbackDays = Number.isFinite(lookbackDaysRaw)
      ? Math.max(1, Math.min(90, Math.floor(lookbackDaysRaw)))
      : 14;
    const result = await buildControlPlaneIssues(lookbackDays);
    return NextResponse.json(result);
  } catch (error) {
    console.error("[GET /api/audit/issues]", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Issue generation failed" },
      { status: 500 }
    );
  }
}
