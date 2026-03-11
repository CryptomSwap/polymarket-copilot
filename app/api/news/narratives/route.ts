import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { computeNarrativeTrends } from "@/lib/news/narratives";

export const dynamic = "force-dynamic";

/**
 * GET /api/news/narratives
 * Narrative momentum dashboard: trends by theme/eventType. Query: windowHours (default 24).
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const windowHours = Math.min(Math.max(1, Number(searchParams.get("windowHours")) || 24), 168);

    const trends = await computeNarrativeTrends({ windowHours });
    const persisted = await prisma.narrativeTrend.findMany({
      orderBy: { updatedAt: "desc" },
      take: 100,
    });

    return NextResponse.json({
      windowHours,
      computed: trends.map((t) => ({
        theme: t.theme,
        eventType: t.eventType,
        articleCount24h: t.articleCount24h,
        sentimentTrend: t.sentimentTrend,
        momentumScore: t.momentumScore,
      })),
      persisted: persisted.map((p) => ({
        id: p.id,
        theme: p.theme,
        eventType: p.eventType,
        articleCount24h: p.articleCount24h,
        sentimentTrend: p.sentimentTrend,
        momentumScore: p.momentumScore,
        updatedAt: p.updatedAt.toISOString(),
      })),
    });
  } catch (error) {
    console.error("[GET /api/news/narratives]", error);
    return NextResponse.json(
      { error: "Failed to fetch narratives" },
      { status: 500 }
    );
  }
}
