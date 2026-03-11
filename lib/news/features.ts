/**
 * Feature scoring for MarketNewsLink: relevance, impact, novelty, freshness.
 * Source credibility; article count by market (24h); overcrowding/saturation.
 */

import { prisma } from "@/lib/db";

/**
 * Update impact score from source credibility.
 */
export async function updateImpactFromSource(): Promise<void> {
  const links = await prisma.marketNewsLink.findMany({
    include: { newsItem: { include: { source: true } } },
  });
  for (const link of links) {
    await prisma.marketNewsLink.update({
      where: { id: link.id },
      data: { impactScore: link.newsItem.source.credibilityScore },
    });
  }
}

/**
 * Compute freshness score from publishedAt (0 = old, 1 = just now). Decay over 7 days.
 */
function freshnessScore(publishedAt: Date | null): number {
  if (!publishedAt) return 0.5;
  const ageHours = (Date.now() - publishedAt.getTime()) / (60 * 60 * 1000);
  if (ageHours <= 1) return 1;
  if (ageHours <= 24) return Math.max(0.3, 1 - ageHours / 48);
  if (ageHours <= 168) return Math.max(0.1, 0.5 - (ageHours - 24) / 336);
  return 0.1;
}

/**
 * Compute novelty: inverse of how many other items in same market in same time window (0–1).
 */
async function noveltyForLink(linkId: string, marketId: string, newsItemPublishedAt: Date | null): Promise<number> {
  const windowStart = newsItemPublishedAt
    ? new Date(newsItemPublishedAt.getTime() - 24 * 60 * 60 * 1000)
    : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const count = await prisma.marketNewsLink.count({
    where: {
      marketId,
      id: { not: linkId },
      newsItem: { publishedAt: { gte: windowStart } },
    },
  });
  if (count === 0) return 1;
  return Math.max(0.1, 1 - Math.log(1 + count) / 5);
}

/**
 * Refresh freshness and novelty for all links.
 */
export async function refreshLinkScores(): Promise<void> {
  const links = await prisma.marketNewsLink.findMany({
    include: { newsItem: true },
  });
  for (const link of links) {
    const fresh = freshnessScore(link.newsItem.publishedAt);
    const novelty = await noveltyForLink(link.id, link.marketId, link.newsItem.publishedAt);
    await prisma.marketNewsLink.update({
      where: { id: link.id },
      data: { freshnessScore: fresh, noveltyScore: novelty },
    });
  }
}

/**
 * Article count per market in last 24h (for overcrowding indicator).
 */
export async function getArticleCountByMarketLast24h(): Promise<Record<string, number>> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const links = await prisma.marketNewsLink.findMany({
    where: { newsItem: { publishedAt: { gte: since } } },
    select: { marketId: true },
  });
  const out: Record<string, number> = {};
  for (const { marketId } of links) {
    out[marketId] = (out[marketId] ?? 0) + 1;
  }
  return out;
}

/**
 * Saturation score for a market (0 = few stories, 1 = overcrowded in last 24h).
 */
export function saturationScore(articleCount24h: number): number {
  if (articleCount24h <= 2) return 0;
  if (articleCount24h <= 5) return 0.3;
  if (articleCount24h <= 10) return 0.6;
  return Math.min(1, 0.7 + (articleCount24h - 10) / 50);
}

/**
 * Get source credibility for a news item (by sourceId).
 */
export async function getSourceCredibility(sourceId: string): Promise<number> {
  const s = await prisma.newsSource.findUnique({ where: { id: sourceId } });
  return s?.credibilityScore ?? 0.5;
}
