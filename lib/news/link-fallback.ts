/**
 * Fallback event-to-market linker when MarketNewsLink is missing for an event's news item.
 * Matches EventSignal to SyncedMarket by entityPrimary, eventType→category, title/slug overlap.
 * Creates MarketNewsLink so runMarketImpactLinking can create MarketEventLink.
 */

import { prisma } from "@/lib/db";

const TOP_MARKETS_PER_EVENT = 5;
const FALLBACK_MIN_RELEVANCE = 0.2;

/** eventType -> category slugs/keywords that suggest a match */
const EVENT_TYPE_TO_CATEGORY: Record<string, string[]> = {
  sanctions: ["geo", "politic", "russia", "iran", "china", "sanction"],
  war_escalation: ["geo", "war", "ukraine", "russia", "israel", "gaza", "military"],
  elections: ["politic", "elect", "trump", "biden", "vote", "senate", "congress"],
  central_bank: ["crypto", "fed", "rate", "inflation", "ecb"],
  regulation: ["crypto", "sec", "regulation", "commodit"],
  earnings: ["crypto", "earnings", "stock"],
  other: [],
};

function tokenize(text: string): string[] {
  return (text || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((s) => s.length > 1);
}

function scoreEventMarketMatch(
  entityPrimary: string | null,
  eventType: string,
  newsTitle: string,
  marketTitle: string,
  marketSlug: string | null,
  category: string | null
): { score: number; reasoning: string[] } {
  const reasons: string[] = [];
  let score = 0;
  const titleLower = (marketTitle || "").toLowerCase();
  const slugLower = (marketSlug || "").toLowerCase();
  const catLower = (category || "").toLowerCase();
  const combined = titleLower + " " + slugLower + " " + catLower;
  const newsTokens = new Set(tokenize(newsTitle));

  if (entityPrimary && entityPrimary.length >= 2) {
    const entity = entityPrimary.toLowerCase().trim();
    if (combined.includes(entity)) {
      score += 0.4;
      reasons.push(`entity "${entityPrimary}" in market`);
    }
  }

  const categoryHints = EVENT_TYPE_TO_CATEGORY[eventType] ?? EVENT_TYPE_TO_CATEGORY.other;
  for (const hint of categoryHints) {
    if (combined.includes(hint)) {
      score += 0.25;
      reasons.push(`eventType ${eventType} ~ category/slug "${hint}"`);
      break;
    }
  }

  const marketTokens = new Set(tokenize(combined));
  let overlap = 0;
  for (const t of Array.from(newsTokens)) {
    if (t.length < 3) continue;
    if (marketTokens.has(t)) overlap += 1;
  }
  const overlapScore = marketTokens.size > 0 ? Math.min(0.4, (overlap / Math.max(1, marketTokens.size)) * 0.4) : 0;
  score += overlapScore;
  if (overlapScore > 0) reasons.push("title/slug token overlap");

  return { score: Math.min(1, score), reasoning: reasons };
}

export interface FallbackLinkDiagnostics {
  eventsProcessed: number;
  eventsWithExistingLinks: number;
  fallbackEventMarketMatches: number;
  skippedMissingMarketMetadata: number;
  marketsConsidered: number;
}

/**
 * For EventSignals whose news item has no MarketNewsLink, find candidate markets and create links.
 * Conservative: top N markets per event, min relevance threshold, reasoning stored on link.
 */
export async function runFallbackEventMarketLinking(opts?: {
  sinceHours?: number;
  maxSignals?: number;
}): Promise<{ linksCreated: number; diagnostics: FallbackLinkDiagnostics; errors: string[] }> {
  const sinceHours = opts?.sinceHours ?? 168;
  const maxSignals = opts?.maxSignals ?? 500;
  const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000);
  const errors: string[] = [];
  const diagnostics: FallbackLinkDiagnostics = {
    eventsProcessed: 0,
    eventsWithExistingLinks: 0,
    fallbackEventMarketMatches: 0,
    skippedMissingMarketMetadata: 0,
    marketsConsidered: 0,
  };

  const signals = await prisma.eventSignal.findMany({
    where: { createdAt: { gte: since } },
    include: { newsItem: { select: { id: true, title: true } } },
    orderBy: { createdAt: "desc" },
    take: maxSignals,
  });

  const existingLinkCounts = await prisma.marketNewsLink.groupBy({
    by: ["newsItemId"],
    where: { newsItemId: { in: signals.map((s) => s.newsItemId) } },
    _count: true,
  });
  const hasLinkByNews = new Set(existingLinkCounts.filter((g) => g._count > 0).map((g) => g.newsItemId));

  const marketCutoffDays = 30;
  const marketCutoff = new Date(Date.now() - marketCutoffDays * 24 * 60 * 60 * 1000);
  const markets = await prisma.syncedMarket.findMany({
    where: {
      status: { not: "closed" },
      OR: [{ endDate: null }, { endDate: { gte: marketCutoff } }],
    },
    select: { id: true, title: true, slug: true, category: true },
  });
  diagnostics.marketsConsidered = markets.length;

  let linksCreated = 0;
  for (const signal of signals) {
    diagnostics.eventsProcessed++;
    if (hasLinkByNews.has(signal.newsItemId)) {
      diagnostics.eventsWithExistingLinks++;
      continue;
    }
    const newsTitle = signal.newsItem?.title ?? "";
    const scored: { marketId: string; score: number; reasoning: string[] }[] = [];
    for (const m of markets) {
      if (!m.title || (m.title as string).trim() === "") {
        diagnostics.skippedMissingMarketMetadata++;
        continue;
      }
      const { score, reasoning } = scoreEventMarketMatch(
        signal.entityPrimary,
        signal.eventType,
        newsTitle,
        m.title,
        m.slug,
        m.category
      );
      if (score >= FALLBACK_MIN_RELEVANCE) scored.push({ marketId: m.id, score, reasoning });
    }
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, TOP_MARKETS_PER_EVENT);
    for (const { marketId, score, reasoning } of top) {
      try {
        await prisma.marketNewsLink.upsert({
          where: { marketId_newsItemId: { marketId, newsItemId: signal.newsItemId } },
          create: {
            marketId,
            newsItemId: signal.newsItemId,
            relevanceScore: score,
            impactScore: 0.5,
            noveltyScore: 0.5,
            freshnessScore: 0.5,
          },
          update: { relevanceScore: score },
        });
        linksCreated++;
        diagnostics.fallbackEventMarketMatches++;
      } catch (e) {
        errors.push(`fallback link ${signal.id}/${marketId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  return { linksCreated, diagnostics, errors };
}
