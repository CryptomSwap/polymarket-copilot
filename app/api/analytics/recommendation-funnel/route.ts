import { NextResponse } from "next/server";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";
import { getRecommendationFunnel } from "@/lib/analytics/execution-summary";

export const dynamic = "force-dynamic";

/**
 * GET /api/analytics/recommendation-funnel
 * Returns funnel counts: shown, reviewed, approved, rejected, previewed, intent created, placed, filled, skipped.
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

  const funnel = await getRecommendationFunnel(funderAddress);
  return NextResponse.json(funnel);
}
