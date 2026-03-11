import { NextResponse } from "next/server";
import {
  getMarketStateEngineForDebug,
  buildMarketStateEngineDebugPayload,
  buildNoEngineDebugPayload,
} from "@/lib/runtime/market-state/market-state-engine-debug";

export const dynamic = "force-dynamic";

const DEFAULT_SAMPLE_LIMIT = 10;
const MAX_SAMPLE_LIMIT = 50;

/**
 * GET /api/ops/runtime/market-state
 *
 * Internal read-only debug surface for Market State Engine.
 * Safe: no credentials, no writes, no order placement.
 * Use during rollout to inspect engine state and health.
 *
 * Query params:
 * - assetId: optional; return single-asset summary in engine.asset
 * - limit: optional; max assets in sample (default 10, max 50)
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const assetId = searchParams.get("assetId") ?? undefined;
    const limitParam = searchParams.get("limit");
    const limit =
      limitParam != null
        ? Math.min(MAX_SAMPLE_LIMIT, Math.max(0, parseInt(limitParam, 10) || DEFAULT_SAMPLE_LIMIT))
        : DEFAULT_SAMPLE_LIMIT;

    const engine = getMarketStateEngineForDebug();
    if (!engine) {
      return NextResponse.json(buildNoEngineDebugPayload());
    }

    const payload = buildMarketStateEngineDebugPayload(engine, { assetId, limit });
    return NextResponse.json(payload);
  } catch (error) {
    console.error("[GET /api/ops/runtime/market-state]", error);
    return NextResponse.json(
      {
        status: "error",
        message: error instanceof Error ? error.message : "Failed to build market state debug payload",
      },
      { status: 500 }
    );
  }
}
