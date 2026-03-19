import { NextResponse } from "next/server";
import { runRuntimePolicyCalibration } from "@/lib/runtime-policy-calibration";
import type { RuntimePolicySubtype } from "@/lib/runtime-policy-calibration";

export const dynamic = "force-dynamic";

/**
 * GET /api/ops/runtime-policy-calibration
 *
 * Returns runtime-policy / freshness threshold calibration: current thresholds, per-subtype stats,
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
        ? (subtypeParam as RuntimePolicySubtype)
        : undefined;
    const source = searchParams.get("source") ?? undefined;

    const filters = {
      funderAddress,
      minEvaluated:
        minEvaluated != null && !Number.isNaN(minEvaluated) ? minEvaluated : undefined,
      subtype,
      source,
    };

    const report = await runRuntimePolicyCalibration(filters);

    return NextResponse.json({
      currentThresholds: report.currentThresholds,
      perSubtype: report.perSubtype,
      recommendations: report.recommendations,
      totalCandidates: report.totalCandidates,
      runtimePolicyRelevantCandidates: report.runtimePolicyRelevantCandidates,
      filters: report.filters,
    });
  } catch (error) {
    console.error("[GET /api/ops/runtime-policy-calibration]", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Runtime policy calibration failed",
      },
      { status: 500 }
    );
  }
}

const VALID_SUBTYPES: RuntimePolicySubtype[] = [
  "stale_market_data",
  "stale_user_feed",
  "stale_portfolio_truth",
  "stale_reconciliation",
  "stale_decision_snapshot",
  "runtime_phase_block",
  "runtime_safety_blocked",
  "runtime_safety_kill_switch",
  "exchange_truth_unavailable",
  "replay_backlog",
  "runtime_error",
  "other_freshness_policy",
];

function isValidSubtype(s: string): s is RuntimePolicySubtype {
  return (VALID_SUBTYPES as string[]).includes(s);
}
