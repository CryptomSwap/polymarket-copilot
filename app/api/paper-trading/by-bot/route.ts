import { NextRequest, NextResponse } from "next/server";
import { getPerBotAnalytics } from "@/lib/paper-trading/analytics";

export const dynamic = "force-dynamic";

/**
 * GET /api/paper-trading/by-bot
 * Per-bot analytics for paper trades, segmented by botType and enriched with price-band / policy / theme / category / targetLabel stats.
 * Query: from, to (ISO), modelRunId, botType (optional filter).
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const fromStr = searchParams.get("from");
    const toStr = searchParams.get("to");
    const modelRunId = searchParams.get("modelRunId") ?? undefined;
    const botType = searchParams.get("botType") ?? undefined;

    const from = fromStr ? new Date(fromStr) : undefined;
    const to = toStr ? new Date(toStr) : undefined;

    const data = await getPerBotAnalytics({
      from,
      to,
      modelRunId,
      botType,
    });

    return NextResponse.json({ bots: data });
  } catch (e) {
    console.error("[GET /api/paper-trading/by-bot]", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Per-bot analytics failed" },
      { status: 500 }
    );
  }
}

