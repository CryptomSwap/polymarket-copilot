import { NextResponse } from "next/server";
import { getMarketStateEngineForDebug } from "@/lib/runtime/market-state/market-state-engine-debug";
import { buildMarketDetailLivePayload } from "@/lib/runtime/market-state/market-detail-live";
import { getBotAssetSummaryForDetail } from "@/lib/runtime/bot-runtime/bot-runtime-debug";

export const dynamic = "force-dynamic";

/**
 * GET /api/markets/live/detail?assetId=<token_id>
 *
 * Live market detail for the professional Market Detail UI.
 * Sourced from runtime state only (Market State Engine + optional Bot Runtime).
 * No DB; historical chart/candle data is separate (e.g. existing markets/[slug] or analytics).
 *
 * Response: quote, spread, depthSummary, tradeTape.lastTrade, liquidity, volatility,
 * health (freshness/stale), botSummary (last decision when bot runtime attached).
 * When runtime is not attached (e.g. worker in another process), returns
 * available: false with empty/null fields so the UI can show "live data unavailable".
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const assetId = searchParams.get("assetId")?.trim();
    if (!assetId) {
      return NextResponse.json(
        { error: "Missing required query parameter: assetId" },
        { status: 400 }
      );
    }

    const engine = getMarketStateEngineForDebug();
    const botSummary = getBotAssetSummaryForDetail(assetId);
    const now = new Date();
    const payload = buildMarketDetailLivePayload(engine, assetId, botSummary, now);
    return NextResponse.json(payload);
  } catch (error) {
    console.error("[GET /api/markets/live/detail]", error);
    return NextResponse.json(
      {
        error: "Failed to build market detail live payload",
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
