import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getEventImpactForMarketV2 } from "@/lib/news/impact-v2";

export const dynamic = "force-dynamic";

/**
 * GET /api/news/market-impact/[slug]
 * Structured events affecting the market, V2 impact (instant/persistent), observed and calibration.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ slug: string }> }
) {
  try {
    const { slug } = await context.params;
    if (!slug) {
      return NextResponse.json({ error: "Missing slug" }, { status: 400 });
    }

    const market = await prisma.syncedMarket.findUnique({
      where: { slug },
      select: { id: true, title: true, slug: true, category: true },
    });
    if (!market) {
      return NextResponse.json({ error: "Market not found" }, { status: 404 });
    }

    const [impact, links] = await Promise.all([
      getEventImpactForMarketV2(market.id),
      prisma.marketEventLink.findMany({
        where: { marketId: market.id },
        include: {
          eventSignal: {
            include: {
              newsItem: { select: { id: true, title: true, url: true, publishedAt: true } },
            },
          },
        },
        orderBy: { createdAt: "desc" },
        take: 30,
      }),
    ]);

    return NextResponse.json({
      market: { id: market.id, title: market.title, slug: market.slug, category: market.category },
      totalBlendedImpact: impact.blendedImpactEstimate,
      totalPersistentImpact: impact.persistentImpact,
      averageConfidence: impact.confidence,
      eventCount: impact.eventCount,
      calibratedEventCount: impact.calibratedCount,
      impactEstimate: impact.blendedImpactEstimate,
      confidence: impact.confidence,
      reasoning: impact.reasoning,
      links: links.map((l) => ({
        id: l.id,
        impactEstimate: l.impactEstimate,
        confidence: l.confidence,
        reasoningJson: l.reasoningJson,
        instantImpact: l.instantImpact,
        persistentImpact: l.persistentImpact,
        decayHalfLifeMinutes: l.decayHalfLifeMinutes,
        timeToFullIncorporationMinutes: l.timeToFullIncorporationMinutes,
        impactObserved5m: l.impactObserved5m,
        impactObserved30m: l.impactObserved30m,
        impactObserved2h: l.impactObserved2h,
        impactObserved24h: l.impactObserved24h,
        calibrationError5m: l.calibrationError5m,
        calibrationError30m: l.calibrationError30m,
        calibrationError2h: l.calibrationError2h,
        calibrationError24h: l.calibrationError24h,
        calibrationOutcomeIndex: l.calibrationOutcomeIndex ?? null,
        calibrationConfidence: l.calibrationConfidence ?? null,
        createdAt: l.createdAt.toISOString(),
        eventSignal: {
          id: l.eventSignal.id,
          eventType: l.eventSignal.eventType,
          entityPrimary: l.eventSignal.entityPrimary,
          severity: l.eventSignal.severity,
          sentiment: l.eventSignal.sentiment,
          sourceName: l.eventSignal.sourceName,
          isOfficialSource: l.eventSignal.isOfficialSource,
          noveltyScore: l.eventSignal.noveltyScore,
          confirmationCount: l.eventSignal.confirmationCount,
          newsItem: l.eventSignal.newsItem,
        },
      })),
    });
  } catch (error) {
    console.error("[GET /api/news/market-impact/[slug]]", error);
    return NextResponse.json(
      { error: "Failed to fetch market impact" },
      { status: 500 }
    );
  }
}
