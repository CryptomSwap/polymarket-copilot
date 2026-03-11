import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * GET /api/news/items
 * List recent news items. Query: limit, since (ISO date), sourceId.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const limit = Math.min(Number(searchParams.get("limit")) || 50, 200);
  const sinceParam = searchParams.get("since");
  const sourceId = searchParams.get("sourceId") ?? undefined;

  const since = sinceParam ? new Date(sinceParam) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const items = await prisma.newsItem.findMany({
    where: {
      publishedAt: { gte: since },
      ...(sourceId && { sourceId }),
    },
    orderBy: { publishedAt: "desc" },
    take: limit,
    include: { source: { select: { id: true, name: true, credibilityScore: true } } },
  });

  return NextResponse.json({
    items: items.map((i) => ({
      id: i.id,
      url: i.url,
      title: i.title,
      summary: i.summary,
      publishedAt: i.publishedAt?.toISOString() ?? null,
      fetchedAt: i.fetchedAt.toISOString(),
      language: i.language,
      source: i.source,
    })),
  });
}
