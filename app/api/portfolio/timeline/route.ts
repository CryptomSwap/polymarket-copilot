import { NextResponse } from "next/server";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";
import { getPortfolioTimeline } from "@/lib/portfolio/timeline";

export const dynamic = "force-dynamic";

/**
 * GET /api/portfolio/timeline
 * Returns a reverse-chronological feed of portfolio events: position opened/increased/reduced,
 * recommendation created/lifecycle, alerts, portfolio snapshots.
 * Query: limit (default 80), from (ISO), to (ISO).
 */
export async function GET(request: Request) {
  const funder = await getFunderForRecompute();
  if (!funder) {
    return NextResponse.json(
      { error: "No funder address. Connect wallet and save connection." },
      { status: 400 }
    );
  }

  const { searchParams } = new URL(request.url);
  const limit = Math.min(Number(searchParams.get("limit")) || 80, 200);
  let from: Date | undefined;
  let to: Date | undefined;
  const fromParam = searchParams.get("from");
  const toParam = searchParams.get("to");
  if (fromParam) {
    const t = new Date(fromParam);
    if (Number.isFinite(t.getTime())) from = t;
  }
  if (toParam) {
    const t = new Date(toParam);
    if (Number.isFinite(t.getTime())) to = t;
  }

  try {
    const events = await getPortfolioTimeline(funder, { limit, from, to });
    return NextResponse.json({ events });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[GET /api/portfolio/timeline]", message);
    return NextResponse.json(
      { error: "Failed to load timeline.", detail: message },
      { status: 500 }
    );
  }
}
