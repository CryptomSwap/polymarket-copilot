import { NextResponse } from "next/server";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";
import { generateAlerts } from "@/lib/alerts/engine";

export const dynamic = "force-dynamic";

/**
 * POST /api/alerts/generate
 * Run Alert Engine v1 for the connected funder. Idempotent with dedupe.
 * Call on dashboard load or cron to refresh proactive alerts.
 */
export async function POST() {
  const funder = await getFunderForRecompute();
  if (!funder) {
    return NextResponse.json(
      { error: "No funder address. Connect wallet and save connection." },
      { status: 400 }
    );
  }

  try {
    const result = await generateAlerts(funder);
    return NextResponse.json({
      ok: true,
      funderAddress: result.funderAddress,
      created: result.created,
      skippedByDedupe: result.skippedByDedupe,
      errors: result.errors,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[POST /api/alerts/generate]", message);
    return NextResponse.json(
      { ok: false, error: "Alert generation failed.", detail: message },
      { status: 500 }
    );
  }
}
