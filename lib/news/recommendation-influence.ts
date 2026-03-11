/**
 * News-derived influence for recommendations: catalyst boost, saturation penalty.
 * Explainable, heuristic-based. Optional; no autonomous trading.
 */

import { prisma } from "@/lib/db";
import { saturationScore } from "./features";

export interface NewsInfluence {
  catalystBoost: number;   // 0–0.1, positive nudge to confidence when relevant fresh news exists
  saturationPenalty: number; // 0–0.2, penalty when story is overcrowded
  linkedNewsCount: number;
  linkedNewsCount24h: number;
}

/**
 * Get news influence for a market. Used optionally in recommendation engine.
 */
export async function getNewsInfluence(marketId: string): Promise<NewsInfluence> {
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [allLinks, links24h] = await Promise.all([
    prisma.marketNewsLink.findMany({
      where: { marketId },
      include: { newsItem: { include: { source: true } } },
    }),
    prisma.marketNewsLink.findMany({
      where: { marketId, newsItem: { publishedAt: { gte: since24h } } },
    }),
  ]);

  const linkedNewsCount = allLinks.length;
  const linkedNewsCount24h = links24h.length;
  const sat = saturationScore(linkedNewsCount24h);
  const saturationPenalty = Math.min(0.2, sat * 0.25); // cap 0.2

  let catalystBoost = 0;
  if (allLinks.length > 0) {
    const avgRelevance = allLinks.reduce((s, l) => s + l.relevanceScore, 0) / allLinks.length;
    const avgFresh = allLinks.reduce((s, l) => s + l.freshnessScore, 0) / allLinks.length;
    const avgImpact = allLinks.reduce((s, l) => s + (l.newsItem?.source?.credibilityScore ?? 0.5), 0) / allLinks.length;
    catalystBoost = Math.min(0.1, (avgRelevance * 0.05 + avgFresh * 0.03 + avgImpact * 0.02));
  }

  return {
    catalystBoost,
    saturationPenalty,
    linkedNewsCount,
    linkedNewsCount24h,
  };
}

/**
 * Batch get news influence for many markets.
 */
export async function getNewsInfluenceByMarket(
  marketIds: string[]
): Promise<Record<string, NewsInfluence>> {
  if (marketIds.length === 0) return {};
  const out: Record<string, NewsInfluence> = {};
  const linksByMarket = await prisma.marketNewsLink.groupBy({
    by: ["marketId"],
    where: { marketId: { in: marketIds } },
    _count: true,
  });
  const links24hByMarket = await prisma.marketNewsLink.groupBy({
    by: ["marketId"],
    where: { marketId: { in: marketIds }, newsItem: { publishedAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } } },
    _count: true,
  });
  const map24h: Record<string, number> = {};
  links24hByMarket.forEach((r) => { map24h[r.marketId] = r._count; });
  for (const r of linksByMarket) {
    const c24 = map24h[r.marketId] ?? 0;
    const sat = saturationScore(c24);
    out[r.marketId] = {
      linkedNewsCount: r._count,
      linkedNewsCount24h: c24,
      catalystBoost: r._count > 0 ? 0.05 : 0,
      saturationPenalty: Math.min(0.2, sat * 0.25),
    };
  }
  for (const id of marketIds) {
    if (!out[id]) out[id] = { catalystBoost: 0, saturationPenalty: 0, linkedNewsCount: 0, linkedNewsCount24h: 0 };
  }
  return out;
}
