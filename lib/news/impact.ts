/**
 * Market impact estimation: link EventSignals to markets and estimate probability impact.
 * Based on market category, event type, sentiment, article volume. Persists MarketEventLink.
 */

import { prisma } from "@/lib/db";
import type { EventType } from "./event-extract";

const IMPACT_BY_EVENT_CATEGORY: Record<string, Record<string, number>> = {
  geopolitics: {
    sanctions: 0.15,
    war_escalation: 0.25,
    elections: 0.08,
    central_bank: 0.05,
    regulation: 0.06,
    other: 0.02,
  },
  politics: {
    sanctions: 0.05,
    war_escalation: 0.1,
    elections: 0.2,
    central_bank: 0.02,
    regulation: 0.08,
    other: 0.02,
  },
  crypto: {
    sanctions: 0.04,
    war_escalation: 0.03,
    elections: 0.02,
    central_bank: 0.12,
    regulation: 0.18,
    earnings: 0.02,
    other: 0.02,
  },
  commodities: {
    sanctions: 0.12,
    war_escalation: 0.15,
    elections: 0.02,
    central_bank: 0.08,
    regulation: 0.03,
    other: 0.02,
  },
  default: {
    sanctions: 0.08,
    war_escalation: 0.12,
    elections: 0.1,
    central_bank: 0.1,
    regulation: 0.08,
    earnings: 0.06,
    other: 0.02,
  },
};

function mapCategory(category: string | null): string {
  if (!category) return "default";
  const c = category.toLowerCase();
  if (c.includes("geo") || c.includes("world")) return "geopolitics";
  if (c.includes("politic") || c.includes("elect")) return "politics";
  if (c.includes("crypto") || c.includes("bitcoin") || c.includes("eth")) return "crypto";
  if (c.includes("commodit") || c.includes("oil") || c.includes("energy")) return "commodities";
  return "default";
}

function sentimentMultiplier(sentiment: string | null): number {
  if (!sentiment) return 1;
  if (sentiment === "negative") return 1.2;
  if (sentiment === "positive") return 0.9;
  return 1;
}

function severityMultiplier(severity: string | null): number {
  if (!severity) return 1;
  if (severity === "critical") return 1.5;
  if (severity === "high") return 1.25;
  if (severity === "medium") return 1;
  return 0.8;
}

export interface ImpactEstimate {
  impactEstimate: number;
  confidence: number;
  reasoning: { category: string; baseImpact: number; sentimentMult: number; severityMult: number; linkRelevance: number };
}

/**
 * Estimate probability impact for a single event signal applied to a market.
 */
export function estimateImpact(
  eventType: EventType | string,
  marketCategory: string | null,
  eventSeverity: string | null,
  eventSentiment: string | null,
  linkRelevanceScore: number
): ImpactEstimate {
  const category = mapCategory(marketCategory);
  const table = IMPACT_BY_EVENT_CATEGORY[category] ?? IMPACT_BY_EVENT_CATEGORY.default;
  const baseImpact = table[eventType] ?? table.other ?? 0.02;
  const sentMult = sentimentMultiplier(eventSentiment);
  const sevMult = severityMultiplier(eventSeverity);
  const relevanceFactor = 0.5 + Math.min(0.5, linkRelevanceScore);
  const impactEstimate = (baseImpact * sentMult * sevMult * relevanceFactor);
  const capped = Math.max(-1, Math.min(1, eventSentiment === "negative" ? impactEstimate : -impactEstimate * 0.5));
  const confidence = Math.min(1, 0.3 + relevanceFactor * 0.4 + (eventSeverity === "high" || eventSeverity === "critical" ? 0.2 : 0));
  return {
    impactEstimate: capped,
    confidence,
    reasoning: {
      category,
      baseImpact,
      sentimentMult: sentMult,
      severityMult: sevMult,
      linkRelevance: linkRelevanceScore,
    },
  };
}

export interface MarketImpactResult {
  linksCreated: number;
  errors: string[];
  /** Number of EventSignals that had zero MarketNewsLink (no market linked to their news item) */
  signalsWithZeroNewsLinks?: number;
}

/**
 * For each EventSignal, find markets linked via MarketNewsLink to its news item; compute impact and persist MarketEventLink.
 */
export async function runMarketImpactLinking(opts?: {
  sinceHours?: number;
  maxSignals?: number;
}): Promise<MarketImpactResult> {
  const since = opts?.sinceHours ?? 168;
  const maxSignals = opts?.maxSignals ?? 1000;
  const sinceDate = new Date(Date.now() - since * 60 * 60 * 1000);
  const errors: string[] = [];
  let linksCreated = 0;
  let signalsWithZeroNewsLinks = 0;

  const signals = await prisma.eventSignal.findMany({
    where: { createdAt: { gte: sinceDate } },
    include: { newsItem: true },
    orderBy: { createdAt: "desc" },
    take: maxSignals,
  });

  const marketCache = new Map<string, { category: string | null }>();
  async function getMarketCategory(marketId: string): Promise<string | null> {
    if (marketCache.has(marketId)) return marketCache.get(marketId)!.category;
    const m = await prisma.syncedMarket.findUnique({
      where: { id: marketId },
      select: { category: true },
    });
    const category = m?.category ?? null;
    marketCache.set(marketId, { category });
    return category;
  }

  for (const signal of signals) {
    try {
      const links = await prisma.marketNewsLink.findMany({
        where: { newsItemId: signal.newsItemId },
        select: { marketId: true, relevanceScore: true },
      });
      if (links.length === 0) signalsWithZeroNewsLinks++;
      for (const link of links) {
        const existing = await prisma.marketEventLink.findFirst({
          where: { eventSignalId: signal.id, marketId: link.marketId },
        });
        if (existing) continue;
        const category = await getMarketCategory(link.marketId);
        const { impactEstimate, confidence, reasoning } = estimateImpact(
          signal.eventType,
          category,
          signal.severity,
          signal.sentiment,
          link.relevanceScore
        );
        await prisma.marketEventLink.create({
          data: {
            eventSignalId: signal.id,
            marketId: link.marketId,
            impactEstimate,
            confidence,
            reasoningJson: JSON.stringify(reasoning),
          },
        });
        linksCreated++;
      }
    } catch (err) {
      errors.push(signal.id + ": " + (err instanceof Error ? err.message : String(err)));
    }
  }

  return { linksCreated, errors, signalsWithZeroNewsLinks };
}

/**
 * Get aggregate event impact for a market (for recommendation/signal use).
 */
export async function getEventImpactForMarket(marketId: string): Promise<{
  impactEstimate: number;
  confidence: number;
  eventCount: number;
  reasoning: unknown[];
}> {
  const links = await prisma.marketEventLink.findMany({
    where: { marketId },
    include: { eventSignal: true },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  if (links.length === 0) {
    return { impactEstimate: 0, confidence: 0, eventCount: 0, reasoning: [] };
  }
  const weighted = links.reduce(
    (acc, l) => acc + l.impactEstimate * l.confidence,
    0
  );
  const totalConf = links.reduce((acc, l) => acc + l.confidence, 0);
  const avgImpact = totalConf > 0 ? weighted / totalConf : 0;
  const avgConfidence = links.length > 0 ? totalConf / links.length : 0;
  const reasoning = links.slice(0, 5).map((l) => ({
    eventType: l.eventSignal.eventType,
    impactEstimate: l.impactEstimate,
    confidence: l.confidence,
    reasoningJson: l.reasoningJson,
  }));
  return {
    impactEstimate: Math.max(-1, Math.min(1, avgImpact)),
    confidence: Math.min(1, avgConfidence * 0.8),
    eventCount: links.length,
    reasoning,
  };
}

/**
 * Batch get event impact for multiple markets (for signal generation).
 */
export async function getEventImpactByMarkets(
  marketIds: string[]
): Promise<Record<string, { impactEstimate: number; confidence: number; eventCount: number }>> {
  if (marketIds.length === 0) return {};
  const links = await prisma.marketEventLink.findMany({
    where: { marketId: { in: marketIds } },
    include: { eventSignal: true },
  });
  const byMarket = new Map<string, { impactEstimate: number; confidence: number; eventCount: number }>();
  for (const mid of marketIds) {
    const marketLinks = links.filter((l) => l.marketId === mid);
    if (marketLinks.length === 0) {
      byMarket.set(mid, { impactEstimate: 0, confidence: 0, eventCount: 0 });
      continue;
    }
    const weighted = marketLinks.reduce((a, l) => a + l.impactEstimate * l.confidence, 0);
    const totalConf = marketLinks.reduce((a, l) => a + l.confidence, 0);
    const avgImpact = totalConf > 0 ? weighted / totalConf : 0;
    const avgConf = marketLinks.length > 0 ? totalConf / marketLinks.length : 0;
    byMarket.set(mid, {
      impactEstimate: Math.max(-1, Math.min(1, avgImpact)),
      confidence: Math.min(1, avgConf * 0.8),
      eventCount: marketLinks.length,
    });
  }
  return Object.fromEntries(byMarket);
}
