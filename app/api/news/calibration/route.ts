import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * GET /api/news/calibration
 * Recent calibrated MarketEventLink rows. Query: limit?, marketId?, sinceHours?
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = Math.min(Number(searchParams.get("limit")) || 50, 200);
    const marketId = searchParams.get("marketId") || undefined;
    const sinceHours = Number(searchParams.get("sinceHours")) || 72;
    const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000);

    const where: { marketId?: string; createdAt?: { gte: Date } } = { createdAt: { gte: since } };
    if (marketId) where.marketId = marketId;

    const links = await prisma.marketEventLink.findMany({
      where,
      include: {
        eventSignal: { select: { id: true, eventType: true, entityPrimary: true } },
      },
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    const marketIds = Array.from(new Set(links.map((l) => l.marketId)));
    const markets =
      marketIds.length > 0
        ? await prisma.syncedMarket.findMany({
            where: { id: { in: marketIds } },
            select: { id: true, slug: true, title: true },
          })
        : [];
    const marketById = Object.fromEntries(markets.map((m) => [m.id, m]));

    return NextResponse.json({
      links: links.map((l) => ({
        id: l.id,
        marketId: l.marketId,
        marketSlug: marketById[l.marketId]?.slug ?? null,
        marketTitle: marketById[l.marketId]?.title ?? null,
        eventType: l.eventSignal.eventType,
        entityPrimary: l.eventSignal.entityPrimary,
        impactEstimate: l.impactEstimate,
        instantImpact: l.instantImpact,
        persistentImpact: l.persistentImpact,
        impactObserved5m: l.impactObserved5m,
        impactObserved30m: l.impactObserved30m,
        impactObserved2h: l.impactObserved2h,
        impactObserved24h: l.impactObserved24h,
        calibrationError5m: l.calibrationError5m,
        calibrationError30m: l.calibrationError30m,
        calibrationError2h: l.calibrationError2h,
        calibrationError24h: l.calibrationError24h,
        calibrationConfidence: l.calibrationConfidence ?? null,
        createdAt: l.createdAt.toISOString(),
      })),
    });
  } catch (error) {
    console.error("[GET /api/news/calibration]", error);
    return NextResponse.json(
      { error: "Failed to fetch calibration" },
      { status: 500 }
    );
  }
}
