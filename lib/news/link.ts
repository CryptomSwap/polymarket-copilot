/**
 * Link news items to markets: keyword overlap, slug/title overlap, entity heuristics.
 * Diagnostics and relaxed filters so linking works when publishedAt or market status is missing.
 */

import { prisma } from "@/lib/db";

const GEOPOLITICS_KEYWORDS = [
  "iran", "khamenei", "successor", "strike", "israel", "gaza", "ukraine", "russia", "nato", "china", "taiwan",
  "north korea", "nuclear", "sanctions", "war", "military", "invasion", "ceasefire", "election", "coup",
];
const COMMODITY_OIL_KEYWORDS = ["oil", "crude", "brent", "wti", "opec", "barrel", "gasoline", "energy"];
const CRYPTO_KEYWORDS = ["btc", "bitcoin", "eth", "ethereum", "sol", "solana", "crypto", "cryptocurrency", "blockchain", "sec"];
const POLITICS_KEYWORDS = ["election", "senate", "president", "congress", "candidate", "vote", "republican", "democrat", "trump", "biden", "ballot"];

export interface LinkNewsDiagnostics {
  linked: number;
  candidateItemsScanned: number;
  candidateMarketsScanned: number;
  rejectedLowRelevance: number;
  itemsWithNullPublishedAt: number;
  marketsWithNonActiveStatus: number;
}

function tokenize(text: string): string[] {
  return (text || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((s) => s.length > 1);
}

function keywordOverlap(tokens: Set<string>, keywords: string[]): number {
  let count = 0;
  for (const k of keywords) {
    if (tokens.has(k)) count++;
  }
  return count;
}

/**
 * Score how relevant a news item is to a market (title, slug, category).
 */
export function scoreRelevance(
  newsTitle: string,
  newsBody: string,
  marketTitle: string,
  marketSlug: string | null,
  category: string | null
): number {
  const newsTokens = new Set(tokenize(newsTitle + " " + (newsBody || "").slice(0, 2000)));
  const marketTokens = new Set(tokenize((marketTitle || "") + " " + (marketSlug || "") + " " + (category || "")));

  let score = 0;
  for (const t of Array.from(marketTokens)) {
    if (t.length < 3) continue;
    if (newsTokens.has(t)) score += 1;
    // partial match
    for (const nt of Array.from(newsTokens)) {
      if (nt.includes(t) || t.includes(nt)) score += 0.5;
    }
  }
  const maxPossible = marketTokens.size * 1.5 || 1;
  const overlap = Math.min(1, score / Math.max(3, maxPossible));

  const categoryLower = (category || "").toLowerCase();
  const slugLower = (marketSlug || "").toLowerCase();
  const titleLower = (marketTitle || "").toLowerCase();

  if (categoryLower.includes("politic") || slugLower.includes("elect") || keywordOverlap(newsTokens, POLITICS_KEYWORDS) > 0) {
    if (keywordOverlap(newsTokens, POLITICS_KEYWORDS) >= 1 && (overlap > 0 || titleLower.includes("elect") || titleLower.includes("trump") || titleLower.includes("biden")))
      return Math.min(1, overlap + 0.3);
  }
  if (categoryLower.includes("crypto") || slugLower.includes("bitcoin") || slugLower.includes("eth")) {
    if (keywordOverlap(newsTokens, CRYPTO_KEYWORDS) >= 1) return Math.min(1, overlap + 0.3);
  }
  if (categoryLower.includes("commodit") || slugLower.includes("oil") || slugLower.includes("crude")) {
    if (keywordOverlap(newsTokens, COMMODITY_OIL_KEYWORDS) >= 1) return Math.min(1, overlap + 0.3);
  }
  if (keywordOverlap(newsTokens, GEOPOLITICS_KEYWORDS) >= 1) {
    if (slugLower.includes("iran") || slugLower.includes("ukraine") || slugLower.includes("israel") || titleLower.includes("war") || categoryLower.includes("geo"))
      return Math.min(1, overlap + 0.25);
  }

  return overlap;
}

/**
 * Link all recent news items to markets; create MarketNewsLink with relevance above threshold.
 * Uses relaxed filters: news with null publishedAt but recent fetchedAt; markets with status active or null.
 */
export async function linkNewsToMarkets(
  minRelevance: number = 0.15
): Promise<{ linked: number; diagnostics: LinkNewsDiagnostics }> {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const marketCutoffDays = 30;
  const marketCutoff = new Date(Date.now() - marketCutoffDays * 24 * 60 * 60 * 1000);
  const items = await prisma.newsItem.findMany({
    where: {
      OR: [
        { publishedAt: { gte: cutoff } },
        { publishedAt: null, fetchedAt: { gte: cutoff } },
      ],
    },
    include: { source: true },
    take: 2000,
  });
  const markets = await prisma.syncedMarket.findMany({
    where: {
      status: { not: "closed" },
      OR: [{ endDate: null }, { endDate: { gte: marketCutoff } }],
    },
    select: { id: true, title: true, slug: true, category: true },
  });

  const diagnostics: LinkNewsDiagnostics = {
    linked: 0,
    candidateItemsScanned: items.length,
    candidateMarketsScanned: markets.length,
    rejectedLowRelevance: 0,
    itemsWithNullPublishedAt: items.filter((i) => i.publishedAt == null).length,
    marketsWithNonActiveStatus: 0,
  };
  let linked = 0;
  let rejectedLowRelevance = 0;

  for (const item of items) {
    const body = item.body ?? item.summary ?? item.title ?? "";
    for (const m of markets) {
      const rel = scoreRelevance(item.title, body, m.title, m.slug, m.category);
      if (rel < minRelevance) {
        rejectedLowRelevance++;
        continue;
      }
      try {
        await prisma.marketNewsLink.upsert({
          where: { marketId_newsItemId: { marketId: m.id, newsItemId: item.id } },
          create: {
            marketId: m.id,
            newsItemId: item.id,
            relevanceScore: rel,
            impactScore: item.source.credibilityScore,
            noveltyScore: 0.5,
            freshnessScore: 0.5,
          },
          update: {
            relevanceScore: rel,
            impactScore: item.source.credibilityScore,
          },
        });
        linked++;
      } catch {
        // skip duplicate
      }
    }
  }

  diagnostics.linked = linked;
  diagnostics.rejectedLowRelevance = rejectedLowRelevance;
  const activeCount = await prisma.syncedMarket.count({ where: { status: "active" } });
  const totalMarkets = await prisma.syncedMarket.count();
  diagnostics.marketsWithNonActiveStatus = Math.max(0, totalMarkets - activeCount);

  return { linked, diagnostics };
}
