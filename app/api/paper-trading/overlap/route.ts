import { NextRequest, NextResponse } from "next/server";
import { getBotOverlapReport } from "@/lib/paper-trading/analytics";

export const dynamic = "force-dynamic";

/**
 * GET /api/paper-trading/overlap
 * Bot overlap report based on PaperTrade rows.
 * Query (optional): from, to (ISO), modelRunId.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const fromStr = searchParams.get("from");
    const toStr = searchParams.get("to");
    const modelRunId = searchParams.get("modelRunId") ?? undefined;

    const from = fromStr ? new Date(fromStr) : undefined;
    const to = toStr ? new Date(toStr) : undefined;

    const overlap = await getBotOverlapReport({ from, to, modelRunId });

    return NextResponse.json({ overlap });
  } catch (e) {
    console.error("[GET /api/paper-trading/overlap]", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Overlap report failed" },
      { status: 500 }
    );
  }
}

