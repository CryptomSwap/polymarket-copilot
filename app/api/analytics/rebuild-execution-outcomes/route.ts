import { NextResponse } from "next/server";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";
import { rebuildExecutionOutcomes } from "@/lib/analytics/execution-outcomes";

export const dynamic = "force-dynamic";

/**
 * POST /api/analytics/rebuild-execution-outcomes
 * Rebuild RecommendationExecutionOutcome rows from order intents and evaluations.
 * Optional body: { funderAddress?: string }
 */
export async function POST(request: Request) {
  let funderAddress: string | undefined;
  try {
    const body = await request.json().catch(() => ({}));
    funderAddress = typeof body.funderAddress === "string" ? body.funderAddress : undefined;
  } catch {
    funderAddress = undefined;
  }
  if (!funderAddress) {
    funderAddress = await getFunderForRecompute().then((f) => f ?? undefined);
  }

  const result = await rebuildExecutionOutcomes(funderAddress);
  return NextResponse.json({
    success: true,
    created: result.created,
    updated: result.updated,
    errors: result.errors,
  });
}
