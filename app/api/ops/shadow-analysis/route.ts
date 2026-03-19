import { NextResponse } from "next/server";
import { runShadowAnalysis } from "@/lib/shadow-analysis";
import type { ShadowAnalysisFilters } from "@/lib/shadow-analysis";

export const dynamic = "force-dynamic";

/**
 * GET /api/ops/shadow-analysis
 *
 * Returns threshold calibration and shadow-outcome analysis: summary, by reason group,
 * by source, calibration suggestions, warning-only cohort.
 * Optional query: funderAddress, minCandidates, onlyEvaluated, source, reasonGroup.
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const funderAddress = searchParams.get("funderAddress") ?? undefined;
    const minCandidatesParam = searchParams.get("minCandidates");
    const minCandidates = minCandidatesParam != null ? parseInt(minCandidatesParam, 10) : undefined;
    const onlyEvaluated = searchParams.get("onlyEvaluated") === "true" || searchParams.get("onlyEvaluated") === "1";
    const source = searchParams.get("source") ?? undefined;
    const reasonGroup = searchParams.get("reasonGroup") ?? undefined;

    const filters: ShadowAnalysisFilters = {};
    if (funderAddress) filters.funderAddress = funderAddress;
    if (minCandidates != null && !Number.isNaN(minCandidates)) filters.minCandidates = minCandidates;
    if (onlyEvaluated) filters.onlyEvaluated = true;
    if (source) filters.source = source;
    if (reasonGroup) filters.reasonGroup = reasonGroup;

    const summary = await runShadowAnalysis(filters);

    const response = {
      summary: {
        totalCandidates: summary.totalCandidates,
        blockedCandidates: summary.blockedCandidates,
        allowedCandidates: summary.allowedCandidates,
        evaluatedCandidates: summary.evaluatedCandidates,
        goodBlocks: summary.goodBlocks,
        badBlocks: summary.badBlocks,
        goodAllows: summary.goodAllows,
        badAllows: summary.badAllows,
        averageMarkout1h: summary.averageMarkout1h,
        averageMarkout6h: summary.averageMarkout6h,
        averageMarkout24h: summary.averageMarkout24h,
        warningOnlyAllowedCount: summary.warningOnlyAllowedCount,
        warningOnlyEvaluatedCount: summary.warningOnlyEvaluatedCount,
        warningOnlyGoodAllowCount: summary.warningOnlyGoodAllowCount,
        warningOnlyBadAllowCount: summary.warningOnlyBadAllowCount,
      },
      byReasonGroup: summary.byReasonGroup,
      bySource: summary.bySource,
      calibrationSuggestions: summary.calibrationSuggestions,
      filters: { funderAddress: filters.funderAddress ?? null, minCandidates: filters.minCandidates ?? null, onlyEvaluated: filters.onlyEvaluated ?? false, source: filters.source ?? null, reasonGroup: filters.reasonGroup ?? null },
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error("[GET /api/ops/shadow-analysis]", error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Shadow analysis failed",
      },
      { status: 500 }
    );
  }
}
