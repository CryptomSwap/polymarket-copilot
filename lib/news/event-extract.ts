/**
 * Structured event extraction from news articles. Entity detection, keyword context, heuristics.
 * Persists EventSignal. Used inside news sync.
 */

import { prisma } from "@/lib/db";

export const EVENT_TYPES = [
  "sanctions",
  "war_escalation",
  "elections",
  "central_bank",
  "earnings",
  "regulation",
  "other",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

const SEVERITIES = ["low", "medium", "high", "critical"] as const;
const SENTIMENTS = ["negative", "neutral", "positive"] as const;

interface KeywordRule {
  eventType: EventType;
  keywords: string[];
  entityHints: string[];
  defaultSeverity: (typeof SEVERITIES)[number];
  defaultSentiment: (typeof SENTIMENTS)[number];
}

const RULES: KeywordRule[] = [
  {
    eventType: "sanctions",
    keywords: ["sanction", "sanctions", "embargo", "penalties", "banned", "freeze assets", "restrictions"],
    entityHints: ["russia", "iran", "china", "north korea", "eu", "us", "uk"],
    defaultSeverity: "high",
    defaultSentiment: "negative",
  },
  {
    eventType: "war_escalation",
    keywords: ["escalat", "invasion", "strike", "attack", "military", "ceasefire", "troops", "conflict", "war"],
    entityHints: ["ukraine", "russia", "israel", "gaza", "iran", "nato", "hamas"],
    defaultSeverity: "high",
    defaultSentiment: "negative",
  },
  {
    eventType: "elections",
    keywords: ["election", "vote", "ballot", "poll", "campaign", "candidate", "president", "senate", "congress"],
    entityHints: ["trump", "biden", "republican", "democrat", "us", "uk", "france"],
    defaultSeverity: "medium",
    defaultSentiment: "neutral",
  },
  {
    eventType: "central_bank",
    keywords: ["fed", "fomc", "interest rate", "rate cut", "rate hike", "inflation", "ecb", "central bank", "monetary policy"],
    entityHints: ["fed", "powell", "ecb", "lagarde", "boj"],
    defaultSeverity: "high",
    defaultSentiment: "neutral",
  },
  {
    eventType: "earnings",
    keywords: ["earnings", "revenue", "profit", "quarterly", "beat estimates", "miss", "guidance"],
    entityHints: [],
    defaultSeverity: "medium",
    defaultSentiment: "neutral",
  },
  {
    eventType: "regulation",
    keywords: ["regulation", "sec", "approval", "lawsuit", "court", "ruling", "ban", "crypto", "etf", "approve"],
    entityHints: ["sec", "cfdc", "eu", "bitcoin", "ethereum"],
    defaultSeverity: "medium",
    defaultSentiment: "neutral",
  },
];

function tokenize(text: string): Set<string> {
  return new Set(
    (text || "")
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((s) => s.length > 1)
  );
}

function extractEntity(tokens: Set<string>, hints: string[]): string | null {
  for (const h of hints) {
    if (tokens.has(h)) return h;
  }
  return null;
}

function inferSentimentFromText(text: string): (typeof SENTIMENTS)[number] {
  const lower = text.toLowerCase();
  if (/\b(crash|fall|drop|loss|war|attack|sanction|ban|reject|fail)\b/.test(lower)) return "negative";
  if (/\b(rally|surge|gain|approve|deal|agree|peace)\b/.test(lower)) return "positive";
  return "neutral";
}

export interface ExtractedEvent {
  eventType: EventType;
  entityPrimary: string | null;
  entitySecondary: string | null;
  severity: string;
  sentiment: string;
  structuredDataJson: string | null;
}

/**
 * Extract structured events from a single article (title + body/summary).
 */
export function extractEventsFromText(
  title: string,
  bodyOrSummary: string | null
): ExtractedEvent[] {
  const combined = (title + " " + (bodyOrSummary || "")).slice(0, 8000);
  const tokens = tokenize(combined);
  const results: ExtractedEvent[] = [];
  const seen = new Set<EventType>();

  for (const rule of RULES) {
    const matchCount = rule.keywords.filter((k) => {
      for (const t of Array.from(tokens)) {
        if (t.includes(k) || k.includes(t)) return true;
      }
      return false;
    }).length;
    if (matchCount === 0) continue;
    const entityPrimary = extractEntity(tokens, rule.entityHints) ?? null;
    const sentiment = inferSentimentFromText(combined);
    if (seen.has(rule.eventType) && !entityPrimary) continue;
    seen.add(rule.eventType);
    results.push({
      eventType: rule.eventType,
      entityPrimary,
      entitySecondary: null,
      severity: rule.defaultSeverity,
      sentiment,
      structuredDataJson: JSON.stringify({
        keywordMatches: matchCount,
        entityHints: rule.entityHints.filter((h) => tokens.has(h)),
      }),
    });
  }

  if (results.length === 0) {
    const sentiment = inferSentimentFromText(combined);
    results.push({
      eventType: "other",
      entityPrimary: null,
      entitySecondary: null,
      severity: "low",
      sentiment,
      structuredDataJson: null,
    });
  }
  return results;
}

export interface EventExtractionResult {
  signalsCreated: number;
  errors: string[];
}

/**
 * Run event extraction on recent news items and persist EventSignal. Idempotent per news item (upsert by newsItemId + eventType + entityPrimary).
 */
export async function runEventExtraction(opts?: {
  sinceHours?: number;
  maxItems?: number;
}): Promise<EventExtractionResult> {
  const since = opts?.sinceHours ?? 168; // 7 days
  const maxItems = opts?.maxItems ?? 500;
  const sinceDate = new Date(Date.now() - since * 60 * 60 * 1000);
  const errors: string[] = [];
  let signalsCreated = 0;

  const items = await prisma.newsItem.findMany({
    where: { createdAt: { gte: sinceDate } },
    orderBy: { createdAt: "desc" },
    take: maxItems,
  });

  for (const item of items) {
    try {
      const extracted = extractEventsFromText(item.title, item.body ?? item.summary);
      for (const e of extracted) {
        const existing = await prisma.eventSignal.findFirst({
          where: {
            newsItemId: item.id,
            eventType: e.eventType,
            entityPrimary: e.entityPrimary ?? null,
          },
        });
        if (existing) continue;
        await prisma.eventSignal.create({
          data: {
            newsItemId: item.id,
            eventType: e.eventType,
            entityPrimary: e.entityPrimary,
            entitySecondary: e.entitySecondary,
            severity: e.severity,
            sentiment: e.sentiment,
            structuredDataJson: e.structuredDataJson,
          },
        });
        signalsCreated++;
      }
    } catch (err) {
      errors.push(item.id + ": " + (err instanceof Error ? err.message : String(err)));
    }
  }

  return { signalsCreated, errors };
}
