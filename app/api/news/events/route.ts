import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * GET /api/news/events
 * List event signals. Query: limit (default 50), eventType (filter), sinceHours (default 168).
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = Math.min(Number(searchParams.get("limit")) || 50, 200);
    const eventType = searchParams.get("eventType") || undefined;
    const sinceHours = Number(searchParams.get("sinceHours")) || 168;
    const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000);

    const where: { eventType?: string; createdAt?: { gte: Date } } = { createdAt: { gte: since } };
    if (eventType) where.eventType = eventType;

    const events = await prisma.eventSignal.findMany({
      where,
      include: { newsItem: { select: { id: true, title: true, url: true, publishedAt: true } } },
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    return NextResponse.json({
      events: events.map((e) => ({
        id: e.id,
        newsItemId: e.newsItemId,
        eventType: e.eventType,
        entityPrimary: e.entityPrimary,
        entitySecondary: e.entitySecondary,
        severity: e.severity,
        sentiment: e.sentiment,
        structuredDataJson: e.structuredDataJson,
        sourceName: e.sourceName,
        sourceCredibility: e.sourceCredibility,
        extractionConfidence: e.extractionConfidence,
        noveltyScore: e.noveltyScore,
        confirmationCount: e.confirmationCount,
        isOfficialSource: e.isOfficialSource,
        occurredAt: e.occurredAt?.toISOString() ?? null,
        createdAt: e.createdAt.toISOString(),
        newsItem: e.newsItem,
      })),
    });
  } catch (error) {
    console.error("[GET /api/news/events]", error);
    return NextResponse.json(
      { error: "Failed to fetch events" },
      { status: 500 }
    );
  }
}
