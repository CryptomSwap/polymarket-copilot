import { NextResponse } from "next/server";
import { runExecutionQualityCalibration } from "@/lib/execution-quality-calibration";
import type { ExecutionQualitySubtype } from "@/lib/execution-quality-calibration";

export const dynamic = "force-dynamic";

/**
 * GET /api/ops/execution-quality-calibration
 *
 * Returns execution-quality threshold calibration: current thresholds, per-subtype stats,
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
        ? (subtypeParam as ExecutionQualitySubtype)
        : undefined;
    const source = searchParams.get("source") ?? undefined;

    const filters = {
      funderAddress,
      minEvaluated:
        minEvaluated != null && !Number.isNaN(minEvaluated) ? minEvaluated : undefined,
      subtype,
      source,
    };

    const report = await runExecutionQualityCalibration(filters);

    return NextResponse.json({
      currentThresholds: report.currentThresholds,
      perSubtype: report.perSubtype,
      recommendations: report.recommendations,
      totalCandidates: report.totalCandidates,
      eqRelevantCandidates: report.eqRelevantCandidates,
      filters: report.filters,
    });
  } catch (error) {
    console.error("[GET /api/ops/execution-quality-calibration]", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Execution quality calibration failed",
      },
      { status: 500 }
    );
  }
}

const VALID_SUBTYPES: ExecutionQualitySubtype[] = [
  "stale_quote",
  "spread_too_wide",
  "insufficient_depth",
  "slippage_too_high",
  "not_tradable",
  "low_liquidity_score",
  "price_too_far_from_market",
  "other",
];

function isValidSubtype(s: string): s is ExecutionQualitySubtype {
  return (VALID_SUBTYPES as string[]).includes(s);
}
