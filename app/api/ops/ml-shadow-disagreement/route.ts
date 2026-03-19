import { NextRequest, NextResponse } from "next/server";
import { runDisagreementAnalysis } from "@/lib/ml/shadow-disagreement";

export const dynamic = "force-dynamic";

/**
 * GET /api/ops/ml-shadow-disagreement
 *
 * Advisory disagreement analysis: staged decision vs shadow ML scores.
 * Query: funderAddress?, candidateSource?, shadowBand?, stagedCohort?, limit? (default 5000).
 * Returns cohort stats, agreement/disagreement rates, recent samples. No runtime behavior change.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const funderAddress = searchParams.get("funderAddress") ?? undefined;
    const candidateSource = searchParams.get("candidateSource") ?? undefined;
    const shadowBand = searchParams.get("shadowBand") as "low" | "medium" | "high" | null;
    const stagedCohort = searchParams.get("stagedCohort") as "staged_block" | "staged_allow" | "staged_reduce" | null;
    const limitParam = searchParams.get("limit");
    const limit = limitParam ? Math.min(10000, Math.max(1, parseInt(limitParam, 10) || 5000)) : 5000;

    const result = await runDisagreementAnalysis({
      funderAddress,
      candidateSource,
      shadowBand: shadowBand ?? undefined,
      stagedCohort: stagedCohort ?? undefined,
      limit,
    });

    return NextResponse.json(result);
  } catch (error) {
    console.error("[GET /api/ops/ml-shadow-disagreement]", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Disagreement analysis failed" },
      { status: 500 }
    );
  }
}
