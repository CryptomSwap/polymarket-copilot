import { NextResponse } from "next/server";
import { scoreLiveRecommendations } from "@/lib/ml/score-live";

export const dynamic = "force-dynamic";

/**
 * POST /api/ml/score-live
 * Score current live recommendations with the ACTIVE/APPROVED model; persist RecommendationMlScore and optionally Recommendation.mlScore.
 */
export async function POST(request: Request) {
  try {
    let funderAddress: string | undefined;
    let updateDenormalized = true;
    try {
      const body = await request.json().catch(() => ({}));
      funderAddress = typeof body?.funderAddress === "string" ? body.funderAddress : undefined;
      if (typeof body?.updateDenormalizedScore === "boolean") updateDenormalized = body.updateDenormalizedScore;
    } catch {
      // use defaults
    }
    const result = await scoreLiveRecommendations(funderAddress, { updateDenormalizedScore: updateDenormalized });
    if (!result.success) {
      return NextResponse.json(
        { success: false, error: result.error, scoredCount: result.scoredCount },
        { status: 400 }
      );
    }
    return NextResponse.json(result);
  } catch (error) {
    console.error("[POST /api/ml/score-live]", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Score live failed" },
      { status: 500 }
    );
  }
}
