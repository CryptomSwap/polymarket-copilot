import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * GET /api/news/market/[slug]
 * Linked news for a market: items, scores, catalyst summaries.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const slugDecoded = decodeURIComponent(slug);

  const market = await prisma.syncedMarket.findUnique({
    where: { slug: slugDecoded },
  });
  if (!market) {
    return NextResponse.json({ error: "Market not found" }, { status: 404 });
  }

  const links = await prisma.marketNewsLink.findMany({
    where: { marketId: market.id },
    orderBy: { relevanceScore: "desc" },
    take: 50,
    include: {
      newsItem: {
        include: { source: { select: { id: true, name: true, credibilityScore: true } } },
      },
    },
  });

  return NextResponse.json({
    market: { id: market.id, slug: market.slug, title: market.title },
    links: links.map((l) => ({
      id: l.id,
      relevanceScore: l.relevanceScore,
      impactScore: l.impactScore,
      noveltyScore: l.noveltyScore,
      freshnessScore: l.freshnessScore,
      catalystSummary: l.catalystSummary,
      newsItem: {
        id: l.newsItem.id,
        url: l.newsItem.url,
        title: l.newsItem.title,
        summary: l.newsItem.summary,
        publishedAt: l.newsItem.publishedAt?.toISOString() ?? null,
        source: l.newsItem.source,
      },
    })),
  });
}
