import { NextResponse } from "next/server";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";
import { getDashboardSummaryStrip } from "@/lib/dashboard/summary-strip";

export const dynamic = "force-dynamic";

/**
 * GET /api/dashboard/summary-strip
 * Returns a compact aggregate of current portfolio state for the dashboard strip.
 * Read-only; uses existing intelligence, open orders, and alert feed.
 */
export async function GET() {
  const funder = await getFunderForRecompute();
  if (!funder) {
    return NextResponse.json(
      { error: "No funder address. Connect wallet and save connection." },
      { status: 400 }
    );
  }

  try {
    const payload = await getDashboardSummaryStrip(funder);
    return NextResponse.json(payload);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[GET /api/dashboard/summary-strip]", message);
    return NextResponse.json(
      { error: "Failed to load summary strip.", detail: message },
      { status: 500 }
    );
  }
}
