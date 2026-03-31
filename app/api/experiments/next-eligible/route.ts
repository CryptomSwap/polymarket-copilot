import { NextResponse } from "next/server";
import { getNextEligibleExperiments } from "@/lib/control-plane/experiments";

export const dynamic = "force-dynamic";

/**
 * GET /api/experiments/next-eligible
 * Read-only, bounded experiment eligibility summary for paper-only rollout.
 */
export async function GET() {
  try {
    const result = await getNextEligibleExperiments();
    return NextResponse.json(result);
  } catch (error) {
    console.error("[GET /api/experiments/next-eligible]", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Experiment eligibility evaluation failed" },
      { status: 500 }
    );
  }
}
