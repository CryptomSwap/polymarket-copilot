import { NextResponse } from "next/server";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";
import { getExecutionSummary } from "@/lib/analytics/execution-summary";

export const dynamic = "force-dynamic";

/**
 * GET /api/analytics/execution-summary
 * Returns acted-on vs ignored counts, win rates, slippage, override performance.
 * Uses connected funder when no query param.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  let funderAddress: string | undefined = searchParams.get("funderAddress") ?? undefined;
  if (!funderAddress) {
    funderAddress = await getFunderForRecompute().then((f) => f ?? undefined);
  }
  if (!funderAddress) {
    return NextResponse.json(
      { error: "No funder address. Connect wallet or pass funderAddress." },
      { status: 400 }
    );
  }

  const summary = await getExecutionSummary(funderAddress);
  return NextResponse.json(summary);
}
