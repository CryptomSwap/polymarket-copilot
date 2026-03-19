import { NextResponse } from "next/server";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";
import { getPortfolioTimeline, type TimelineSourceFilter } from "@/lib/portfolio/timeline";

export const dynamic = "force-dynamic";

const SOURCE_VALUES: TimelineSourceFilter[] = [
  "all",
  "drift",
  "behavior",
  "recommendation",
  "execution",
  "reconciliation",
  "journal",
  "copilot",
];

/**
 * GET /api/portfolio/timeline
 * Returns a reverse-chronological feed of portfolio events from persisted sources.
 * Deterministic, read-only. No new tables.
 *
 * Query params:
 * - limit (default 100, max 200)
 * - since (ISO date): only events with createdAt >= since
 * - source: all | drift | behavior | recommendation | execution | reconciliation | journal | copilot
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
  const limitParam = searchParams.get("limit");
  const limit = Math.min(
    Number(limitParam) || 100,
    200
  );
  let since: Date | undefined;
  const sinceParam = searchParams.get("since");
  if (sinceParam) {
    const t = new Date(sinceParam);
    if (Number.isFinite(t.getTime())) since = t;
  }
  let source: TimelineSourceFilter = "all";
  const sourceParam = searchParams.get("source");
  if (sourceParam && SOURCE_VALUES.includes(sourceParam as TimelineSourceFilter)) {
    source = sourceParam as TimelineSourceFilter;
  }

  try {
    const events = await getPortfolioTimeline(funder, { limit, since, source });
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
