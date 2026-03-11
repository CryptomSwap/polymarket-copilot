import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { runRegimeScan, persistRegimeSnapshot } from "@/lib/markets/regime";

export const dynamic = "force-dynamic";

/**
 * GET /api/markets/regime?marketId=... | ?slug=...
 * Returns regime features, classification, and signals for a market.
 * Optional ?persist=1 to save a snapshot for evaluation/ML.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const marketId = searchParams.get("marketId");
  const slug = searchParams.get("slug");
  const persist = searchParams.get("persist") === "1";

  let resolvedMarketId = marketId ?? null;
  if (!resolvedMarketId && slug) {
    const market = await prisma.syncedMarket.findUnique({
      where: { slug: decodeURIComponent(slug) },
      select: { id: true },
    });
    resolvedMarketId = market?.id ?? null;
  }

  if (!resolvedMarketId) {
    return NextResponse.json(
      { error: "Provide marketId or slug query parameter." },
      { status: 400 }
    );
  }

  const result = await runRegimeScan({ marketId: resolvedMarketId });
  if (!result) {
    return NextResponse.json({ error: "Market not found or has no assets." }, { status: 404 });
  }

  if (persist) {
    try {
      await persistRegimeSnapshot(result);
    } catch (e) {
      return NextResponse.json(
        { error: "Regime snapshot persist failed.", detail: e instanceof Error ? e.message : "" },
        { status: 500 }
      );
    }
  }

  return NextResponse.json({
    marketId: result.marketId,
    assetId: result.assetId,
    features: result.features,
    regime: result.regime,
    signals: result.signals,
    persisted: persist,
  });
}
