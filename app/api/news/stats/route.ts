import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getArticleCountByMarketLast24h, saturationScore } from "@/lib/news/features";

export const dynamic = "force-dynamic";

/**
 * GET /api/news/stats
 * News ingestion stats: source counts, items, linked by market, recent catalysts.
 */
export async function GET() {
  const [sources, itemCount, linkCount, recentItems, countByMarket24h] = await Promise.all([
    prisma.newsSource.findMany({
      where: { enabled: true },
      select: { id: true, name: true, type: true, credibilityScore: true, _count: { select: { items: true } } },
    }),
    prisma.newsItem.count(),
    prisma.marketNewsLink.count(),
    prisma.newsItem.findMany({
      orderBy: { publishedAt: "desc" },
      take: 20,
      include: { source: { select: { name: true } } },
    }),
    getArticleCountByMarketLast24h(),
  ]);

  const marketIds = Object.keys(countByMarket24h);
  const markets = marketIds.length > 0
    ? await prisma.syncedMarket.findMany({
        where: { id: { in: marketIds } },
        select: { id: true, title: true, slug: true },
      })
    : [];
  const byMarket = markets.map((m) => ({
    marketId: m.id,
    title: m.title,
    slug: m.slug,
    articleCount24h: countByMarket24h[m.id] ?? 0,
    saturation: saturationScore(countByMarket24h[m.id] ?? 0),
  }));

  return NextResponse.json({
    sourcesCount: sources.length,
    sources: sources.map((s) => ({
      id: s.id,
      name: s.name,
      type: s.type,
      credibilityScore: s.credibilityScore,
      itemsCount: s._count.items,
    })),
    totalItems: itemCount,
    totalLinks: linkCount,
    linkedByMarket24h: byMarket.sort((a, b) => b.articleCount24h - a.articleCount24h),
    recentItems: recentItems.map((i) => ({
      id: i.id,
      title: i.title,
      publishedAt: i.publishedAt?.toISOString() ?? null,
      sourceName: i.source?.name ?? "",
    })),
  });
}
