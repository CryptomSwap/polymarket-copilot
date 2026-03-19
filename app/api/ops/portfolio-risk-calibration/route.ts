import { NextResponse } from "next/server";
import { runPortfolioRiskCalibration } from "@/lib/portfolio-risk-calibration";
import type { PortfolioRiskSubtype } from "@/lib/portfolio-risk-calibration";

export const dynamic = "force-dynamic";

/**
 * GET /api/ops/portfolio-risk-calibration
 *
 * Returns portfolio-risk threshold calibration: current thresholds, per-subtype stats,
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
        ? (subtypeParam as PortfolioRiskSubtype)
        : undefined;
    const source = searchParams.get("source") ?? undefined;

    const filters = {
      funderAddress,
      minEvaluated:
        minEvaluated != null && !Number.isNaN(minEvaluated) ? minEvaluated : undefined,
      subtype,
      source,
    };

    const report = await runPortfolioRiskCalibration(filters);

    return NextResponse.json({
      currentThresholds: report.currentThresholds,
      perSubtype: report.perSubtype,
      recommendations: report.recommendations,
      totalCandidates: report.totalCandidates,
      riskRelevantCandidates: report.riskRelevantCandidates,
      filters: report.filters,
    });
  } catch (error) {
    console.error("[GET /api/ops/portfolio-risk-calibration]", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Portfolio risk calibration failed",
      },
      { status: 500 }
    );
  }
}

const VALID_SUBTYPES: PortfolioRiskSubtype[] = [
  "total_exposure",
  "single_market_concentration",
  "single_theme_concentration",
  "near_resolution_exposure",
  "illiquid_exposure",
  "correlated_exposure",
  "portfolio_fit_penalty",
  "behavior_conflict",
  "other_portfolio_risk",
];

function isValidSubtype(s: string): s is PortfolioRiskSubtype {
  return (VALID_SUBTYPES as string[]).includes(s);
}
