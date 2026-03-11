/**
 * Event quality scoring: source credibility, official detection, novelty, confirmation count, extraction confidence.
 * Deterministic heuristics. Used to enrich EventSignal after extraction.
 */

import { prisma } from "@/lib/db";

const CREDIBILITY_BY_SOURCE: Record<string, number> = {
  reuters: 0.95,
  "reuters.com": 0.95,
  ap: 0.92,
  "associated press": 0.92,
  "financial times": 0.9,
  ft: 0.9,
  "ft.com": 0.9,
  bbc: 0.88,
  "bbc news": 0.88,
  bloomberg: 0.88,
  "wall street journal": 0.87,
  wsj: 0.87,
  cnbc: 0.82,
  npr: 0.85,
  "the guardian": 0.84,
  guardian: 0.84,
  aljazeera: 0.82,
  axios: 0.8,
  politico: 0.78,
  "new york times": 0.86,
  nyt: 0.86,
  washingtonpost: 0.85,
  "washington post": 0.85,
  cnn: 0.8,
  fox: 0.75,
  cbs: 0.8,
  abc: 0.78,
  nbc: 0.8,
};

const OFFICIAL_DOMAINS = [
  "reuters.com", "apnews.com", "ft.com", "bbc.com", "bbc.co.uk",
  "bloomberg.com", "wsj.com", "cnbc.com", "npr.org", "gov", ".gov",
  "whitehouse.gov", "treasury.gov", "sec.gov", "ecb.europa.eu", "federalreserve.gov",
];

/**
 * Source credibility 0–1 from name and optional URL. Mapping-based plus domain heuristic.
 */
export function getSourceCredibility(sourceName?: string, articleUrl?: string): number {
  const name = (sourceName ?? "").toLowerCase().trim();
  for (const [key, score] of Object.entries(CREDIBILITY_BY_SOURCE)) {
    if (name.includes(key)) return score;
  }
  if (articleUrl) {
    const urlLower = articleUrl.toLowerCase();
    for (const d of OFFICIAL_DOMAINS) {
      if (urlLower.includes(d)) return 0.85;
    }
  }
  if (name.length > 0) return 0.55;
  return 0.5;
}

/**
 * True if source/URL looks like an official or tier-1 outlet.
 */
export function detectOfficialSource(sourceName?: string, articleUrl?: string): boolean {
  const cred = getSourceCredibility(sourceName, articleUrl);
  if (cred >= 0.88) return true;
  if (articleUrl) {
    const urlLower = articleUrl.toLowerCase();
    if (OFFICIAL_DOMAINS.some((d) => urlLower.includes(d))) return true;
  }
  return false;
}

export interface NoveltyParams {
  eventType: string;
  entityPrimary: string | null;
  currentSignalId: string;
  windowHours?: number;
}

/**
 * Lower novelty if same eventType+entityPrimary already appeared recently. Higher for first mention.
 * Returns 0–1.
 */
export async function estimateNoveltyScore(params: NoveltyParams): Promise<number> {
  const { eventType, entityPrimary, currentSignalId, windowHours = 48 } = params;
  const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);
  const same = await prisma.eventSignal.count({
    where: {
      eventType,
      entityPrimary: entityPrimary ?? null,
      createdAt: { gte: since },
      id: { not: currentSignalId },
    },
  });
  if (same === 0) return 0.9;
  if (same >= 5) return 0.2;
  return Math.max(0.2, 0.9 - same * 0.15);
}

export interface ConfirmationParams {
  eventType: string;
  entityPrimary: string | null;
  currentSignalId: string;
  windowHours?: number;
}

/**
 * Count recent EventSignals with same eventType + entityPrimary (exclude current). 0+.
 */
export async function countConfirmationsForEvent(params: ConfirmationParams): Promise<number> {
  const { eventType, entityPrimary, currentSignalId, windowHours = 24 } = params;
  const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);
  const n = await prisma.eventSignal.count({
    where: {
      eventType,
      entityPrimary: entityPrimary ?? null,
      createdAt: { gte: since },
      id: { not: currentSignalId },
    },
  });
  return n;
}

export interface ExtractionConfidenceParams {
  keywordMatches: number;
  entityPresent: boolean;
  titleLength: number;
  bodyLength: number;
}

/**
 * Extraction confidence from rule strength, entity presence, text length. 0–1.
 */
export function estimateExtractionConfidence(params: ExtractionConfidenceParams): number {
  const { keywordMatches, entityPresent, titleLength, bodyLength } = params;
  let c = 0.3;
  if (keywordMatches >= 3) c += 0.35;
  else if (keywordMatches >= 2) c += 0.25;
  else if (keywordMatches >= 1) c += 0.15;
  if (entityPresent) c += 0.2;
  if (titleLength >= 20) c += 0.1;
  if (bodyLength >= 100) c += 0.05;
  return Math.min(1, c);
}

export interface EnrichEventSignalQualityParams {
  signalId: string;
  sourceName?: string;
  articleUrl?: string;
  eventType: string;
  entityPrimary: string | null;
  structuredDataJson?: string | null;
  title?: string;
  body?: string | null;
  occurredAt?: Date | null;
}

/**
 * Enrich one EventSignal with quality fields. Idempotent; updates only when run.
 */
export async function enrichEventSignalQuality(params: EnrichEventSignalQualityParams): Promise<void> {
  const {
    signalId,
    sourceName,
    articleUrl,
    eventType,
    entityPrimary,
    structuredDataJson,
    title = "",
    body = "",
    occurredAt,
  } = params;

  const sourceCredibility = getSourceCredibility(sourceName, articleUrl);
  const isOfficialSource = detectOfficialSource(sourceName, articleUrl);
  const [noveltyScore, confirmationCount] = await Promise.all([
    estimateNoveltyScore({ eventType, entityPrimary, currentSignalId: signalId, windowHours: 48 }),
    countConfirmationsForEvent({ eventType, entityPrimary, currentSignalId: signalId, windowHours: 24 }),
  ]);

  let keywordMatches = 0;
  let entityPresent = !!entityPrimary;
  try {
    if (structuredDataJson) {
      const parsed = JSON.parse(structuredDataJson) as { keywordMatches?: number };
      keywordMatches = typeof parsed.keywordMatches === "number" ? parsed.keywordMatches : 0;
    }
  } catch {
    // ignore
  }
  const extractionConfidence = estimateExtractionConfidence({
    keywordMatches,
    entityPresent,
    titleLength: title.length,
    bodyLength: (body ?? "").length,
  });

  await prisma.eventSignal.update({
    where: { id: signalId },
    data: {
      sourceName: sourceName ?? undefined,
      sourceCredibility,
      extractionConfidence,
      noveltyScore,
      confirmationCount,
      isOfficialSource,
      occurredAt: occurredAt ?? undefined,
    },
  });
}

/**
 * Enrich recent EventSignals that have null sourceCredibility. Returns count enriched.
 * When force is false (default), only signals with null sourceCredibility are selected.
 */
export async function enrichRecentEventSignalsQuality(opts?: {
  sinceHours?: number;
  maxSignals?: number;
}): Promise<{ enriched: number; errors: string[] }> {
  return refreshEventSignalsQuality({
    sinceHours: opts?.sinceHours ?? 168,
    limit: opts?.maxSignals ?? 500,
    force: false,
  });
}

/**
 * Refresh event quality fields for recent EventSignals.
 * force = true: recompute quality fields even if already populated.
 * force = false: only fill missing (same as enrichRecentEventSignalsQuality).
 * Quality fields: sourceCredibility, extractionConfidence, noveltyScore, confirmationCount, isOfficialSource.
 */
export async function refreshEventSignalsQuality(opts?: {
  sinceHours?: number;
  limit?: number;
  force?: boolean;
}): Promise<{ enriched: number; errors: string[] }> {
  const sinceHours = opts?.sinceHours ?? 168;
  const limit = opts?.limit ?? 500;
  const force = opts?.force ?? false;
  const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000);
  const errors: string[] = [];
  let enriched = 0;

  const where = force
    ? { createdAt: { gte: since } }
    : { createdAt: { gte: since }, sourceCredibility: null };

  const signals = await prisma.eventSignal.findMany({
    where,
    include: { newsItem: { include: { source: true } } },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  for (const s of signals) {
    try {
      await enrichEventSignalQuality({
        signalId: s.id,
        sourceName: s.newsItem?.source?.name,
        articleUrl: s.newsItem?.url,
        eventType: s.eventType,
        entityPrimary: s.entityPrimary,
        structuredDataJson: s.structuredDataJson,
        title: s.newsItem?.title,
        body: s.newsItem?.body ?? s.newsItem?.summary,
        occurredAt: s.newsItem?.publishedAt ?? undefined,
      });
      enriched++;
    } catch (err) {
      errors.push(s.id + ": " + (err instanceof Error ? err.message : String(err)));
    }
  }
  return { enriched, errors };
}
