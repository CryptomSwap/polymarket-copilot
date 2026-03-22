import { NextResponse } from "next/server";
import { getFunderForPaperTradingTick } from "@/lib/decision/recompute";
import { runPaperTradingTick } from "@/lib/paper-trading/engine";

export const dynamic = "force-dynamic";

/**
 * POST /api/paper-trading/tick
 * Run one paper-trading tick: score live candidates, open paper trades when score >= threshold.
 * Uses wallet-aligned funder resolution (same as scheduled paper_trading_tick); optional body { funderAddress } overrides.
 */
export async function POST(request: Request) {
  try {
    let funderOverride: string | undefined;
    try {
      const body = await request.json().catch(() => ({}));
      funderOverride = typeof body.funderAddress === "string" ? body.funderAddress : undefined;
    } catch {
      funderOverride = undefined;
    }
    const funder = await getFunderForPaperTradingTick(funderOverride);
    const result = await runPaperTradingTick(funder ?? undefined);
    return NextResponse.json(result);
  } catch (err) {
    console.error("[paper-trading/tick] fatal error", err);
    return new Response(
      JSON.stringify({
        error: "tick_failed",
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : null,
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}
