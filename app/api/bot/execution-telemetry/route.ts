import { NextResponse } from "next/server";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";
import { getExecutionTelemetry } from "@/lib/bot/execution-telemetry";

export const dynamic = "force-dynamic";

/**
 * GET /api/bot/execution-telemetry
 * Returns execution telemetry for the connected funder: counts, success rate, last execution, top failure reasons, recent attempts.
 */
export async function GET(request: Request) {
  const funder = await getFunderForRecompute();
  if (!funder) {
    return NextResponse.json(
      { error: "No funder address. Connect wallet and save connection." },
      { status: 400 }
    );
  }

  const url = request.url ? new URL(request.url) : null;
  const recentLimit = url?.searchParams.get("recent")
    ? Math.min(100, Math.max(1, parseInt(url.searchParams.get("recent")!, 10)))
    : 20;
  const topFailures = url?.searchParams.get("topFailures")
    ? Math.min(20, Math.max(1, parseInt(url.searchParams.get("topFailures")!, 10)))
    : 10;

  try {
    const telemetry = await getExecutionTelemetry(funder, {
      recentLimit: Number.isFinite(recentLimit) ? recentLimit : 20,
      topFailureLimit: Number.isFinite(topFailures) ? topFailures : 10,
    });
    return NextResponse.json(telemetry);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[GET /api/bot/execution-telemetry]", message);
    return NextResponse.json(
      { error: "Telemetry failed.", detail: message },
      { status: 500 }
    );
  }
}
