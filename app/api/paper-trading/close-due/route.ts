import { NextResponse } from "next/server";
import { closePaperTradesAt12h } from "@/lib/paper-trading/engine";

export const dynamic = "force-dynamic";

/**
 * POST /api/paper-trading/close-due
 * Close paper trades that have passed the 12h horizon (compute markout from MarketPriceSnapshot).
 */
export async function POST() {
  try {
    const result = await closePaperTradesAt12h();
    return NextResponse.json(result);
  } catch (e) {
    console.error("[POST /api/paper-trading/close-due]", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Close due failed" },
      { status: 500 }
    );
  }
}
