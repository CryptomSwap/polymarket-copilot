import { NextResponse } from "next/server";
import { runDecisionStageCalibration } from "@/lib/decision-calibration";
import type { DecisionStageSubtype } from "@/lib/decision-calibration";

export const dynamic = "force-dynamic";

/**
 * GET /api/ops/decision-calibration
 *
 * Returns decision-stage boundary calibration: current thresholds, per-subtype stats,
 * recommended reviews. Does not auto-apply changes.
 * Optional query: funderAddress, minEvaluated, subtype, source.
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const funderAddress = searchParams.get("funderAddress") ?? undefined;
    const minEvaluatedParam = searchParams.get("minEvaluated");
    const minEvaluated =
      minEvaluatedParam != null ? parseInt(minEvaluatedParam, 10) : undefined;
    const subtypeParam = searchParams.get("subtype") ?? undefined;
    const subtype =
      subtypeParam && isValidSubtype(subtypeParam)
        ? (subtypeParam as DecisionStageSubtype)
        : undefined;
    const source = searchParams.get("source") ?? undefined;

    const filters = {
      funderAddress,
      minEvaluated:
        minEvaluated != null && !Number.isNaN(minEvaluated) ? minEvaluated : undefined,
      subtype,
      source,
    };

    const report = await runDecisionStageCalibration(filters);

    return NextResponse.json({
      currentThresholds: report.currentThresholds,
      perSubtype: report.perSubtype,
      recommendations: report.recommendations,
      totalCandidates: report.totalCandidates,
      decisionRelevantCandidates: report.decisionRelevantCandidates,
      filters: report.filters,
    });
  } catch (error) {
    console.error("[GET /api/ops/decision-calibration]", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Decision calibration failed",
      },
      { status: 500 }
    );
  }
}

const VALID_SUBTYPES: DecisionStageSubtype[] = [
  "eligibility_block",
  "low_conviction_edge",
  "medium_conviction_edge",
  "high_conviction_edge",
  "poor_market_quality",
  "borderline_market_quality",
  "poor_portfolio_fit",
  "portfolio_fit_penalty",
  "size_reduced",
  "size_zero",
  "exit_trim_logic",
  "other_decision_stage",
];

function isValidSubtype(s: string): s is DecisionStageSubtype {
  return (VALID_SUBTYPES as string[]).includes(s);
}
