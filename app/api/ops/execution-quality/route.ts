import { NextResponse } from "next/server";
import { getMarketStateEngineForDebug } from "@/lib/runtime/market-state/market-state-engine-debug";
import { evaluateExecutionQuality } from "@/lib/execution-quality";

export const dynamic = "force-dynamic";

/**
 * GET /api/ops/execution-quality
 *
 * Evaluates execution quality (spread, depth, quote freshness, slippage) for an asset/order.
 * Uses live market state when available. Safe: read-only, no writes.
 *
 * Query params:
 * - assetId: required; asset to evaluate
 * - marketId: optional; for context
 * - side: optional; "BUY" | "SELL" (default BUY)
 * - intendedPrice: optional; limit price 0–1 (default 0.5)
 * - intendedSize: optional; order size (default 10)
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const assetId = searchParams.get("assetId")?.trim();
    const marketId = searchParams.get("marketId")?.trim() ?? "";
    const side = (searchParams.get("side")?.toUpperCase() === "SELL" ? "SELL" : "BUY") as "BUY" | "SELL";
    const intendedPrice = Math.min(1, Math.max(0, parseFloat(searchParams.get("intendedPrice") ?? "0.5") || 0.5));
    const intendedSize = Math.max(0, parseFloat(searchParams.get("intendedSize") ?? "10") || 10);

    if (!assetId) {
      return NextResponse.json(
        { status: "error", message: "assetId is required" },
        { status: 400 }
      );
    }

    const engine = getMarketStateEngineForDebug();
    if (!engine) {
      return NextResponse.json({
        status: "no_engine",
        message: "Market state engine not available. Start the runtime to evaluate execution quality.",
        executionQuality: null,
      });
    }

    const asset = engine.getAssetState(assetId);
    if (!asset) {
      return NextResponse.json({
        status: "no_asset",
        message: `No market state for asset ${assetId}. Asset may not be tracked.`,
        executionQuality: null,
      });
    }

    const quoteAgeMs =
      asset.quote?.updatedAt != null
        ? Date.now() - new Date(asset.quote.updatedAt).getTime()
        : undefined;

    const result = evaluateExecutionQuality({
      assetId,
      marketId: marketId || asset.market?.marketId ?? "",
      side,
      intendedPrice,
      intendedSize,
      bestBid: asset.quote?.bestBid ?? null,
      bestAsk: asset.quote?.bestAsk ?? null,
      bidDepth: asset.depth?.bidTopSize ?? null,
      askDepth: asset.depth?.askTopSize ?? null,
      spreadBps: asset.quote?.spreadBps ?? undefined,
      lastTradePrice: asset.lastTrade?.price ?? undefined,
      quoteAgeMs: quoteAgeMs ?? undefined,
      liquidityScore: asset.liquidity?.qualityScore ?? undefined,
      isTradable: asset.liquidity?.isTradable ?? undefined,
    });

    return NextResponse.json({
      status: "ok",
      executionQuality: {
        tradable: result.tradable,
        qualityState: result.qualityState,
        blockingReasons: result.blockingReasons,
        warnings: result.warnings,
        estimatedSlippage: result.estimatedSlippage,
        estimatedFillQuality: result.estimatedFillQuality,
        spread: result.spread,
        spreadBps: result.spreadBps,
        depthSufficiency: result.depthSufficiency,
        quoteFreshnessState: result.quoteFreshnessState,
        evaluatedAt: result.evaluatedAt,
      },
    });
  } catch (error) {
    console.error("[GET /api/ops/execution-quality]", error);
    return NextResponse.json(
      {
        status: "error",
        message: error instanceof Error ? error.message : "Execution quality evaluation failed",
      },
      { status: 500 }
    );
  }
}
