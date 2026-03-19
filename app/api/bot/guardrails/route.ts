import { NextResponse } from "next/server";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";
import { getGuardrailsReadiness } from "@/lib/bot/guardrails";

export const dynamic = "force-dynamic";

/**
 * GET /api/bot/guardrails
 * Returns a deterministic preflight summary: ready/caution/blocked and per-check details.
 * Read-only; no mutation; no new tables. Does not enable autonomous trading.
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
    const payload = await getGuardrailsReadiness(funder);
    return NextResponse.json(payload);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[GET /api/bot/guardrails]", message);
    return NextResponse.json(
      { error: "Failed to evaluate guardrails.", detail: message },
      { status: 500 }
    );
  }
}
