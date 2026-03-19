import { NextResponse } from "next/server";
import { getFunderForDecisionRecompute } from "@/lib/decision/recompute";
import { runPaperTradingTick } from "@/lib/paper-trading/engine";

export const dynamic = "force-dynamic";

/**
 * POST /api/paper-trading/tick
 * Run one paper-trading tick: score live candidates, open paper trades when score >= threshold.
 * Uses same funder resolution as decision recompute; optional body { funderAddress } forces that funder (e.g. same as ensure-decision-snapshots).
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
    const funder = await getFunderForDecisionRecompute(funderOverride);
    const result = await runPaperTradingTick(funder ?? undefined);
    return NextResponse.json(result);
  } catch (e) {
    console.error("[POST /api/paper-trading/tick]", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Paper trading tick failed" },
      { status: 500 }
    );
  }
}
