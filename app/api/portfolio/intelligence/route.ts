import { NextResponse } from "next/server";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";
import { getPortfolioIntelligence } from "@/lib/portfolio/intelligence";

export const dynamic = "force-dynamic";

/**
 * GET /api/portfolio/intelligence
 * Returns portfolio intelligence v1 (summary, buckets, flags, actions, diagnostics) for the connected funder.
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
    const intelligence = await getPortfolioIntelligence({ funderAddress: funder });
    const d = intelligence.diagnostics;
    console.info(
      "[GET /api/portfolio/intelligence] ok",
      { funder: funder.slice(0, 10) + "…", positions: d.totalPositions, resolved: d.resolvedPositions, unresolved: d.unresolvedPositions }
    );
    return NextResponse.json({
      ok: true,
      funderAddress: funder,
      intelligence,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[GET /api/portfolio/intelligence] Error:", message);
    if (err instanceof Error && err.stack) {
      console.error(err.stack);
    }
    return NextResponse.json(
      {
        ok: false,
        error: "Failed to compute portfolio intelligence.",
        detail: process.env.NODE_ENV === "development" ? message : undefined,
      },
      { status: 500 }
    );
  }
}
