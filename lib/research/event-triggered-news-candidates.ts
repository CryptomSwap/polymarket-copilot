/**
 * Diagnostics-only RSS → market match → candidate-lake rows (`event_triggered_news`).
 * No admission/scoring integration; interpretable token overlap only.
 */

import * as fs from "fs/promises";
import * as path from "path";
import { prisma } from "@/lib/db";
import type { FetchedItem } from "@/lib/news/fetch";
import { fetchAllEnabledSources } from "@/lib/news/fetch";
import { tryBidAskSpreadBpsFromSyncedMarketRaw } from "@/lib/polymarket/synced-market-token-quote-from-raw";
import {
  buildCandidateLakePersistedRecordFromEventTriggeredNews,
  type CandidateLakePersistedRecord,
} from "@/lib/research/candidate-lake";
import { appendDiagnosticsCandidateLakeRecords } from "@/lib/research/candidate-lake-store";

function oneLineError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const lines = raw
    .split("\n")
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
  const preferred = lines.find((l) =>
    /can't reach|database|ECONNREFUSED|ETIMEDOUT|timeout|connect/i.test(l),
  );
  const chosen = preferred ?? lines[lines.length - 1] ?? raw.trim();
  return chosen.slice(0, 400);
}

const STOP = new Set([
  "that",
  "this",
  "with",
  "from",
  "have",
  "will",
  "been",
  "were",
  "they",
  "their",
  "about",
  "after",
  "before",
  "into",
  "through",
  "during",
  "would",
  "could",
  "should",
  "https",
  "http",
  "news",
  "said",
  "says",
  "just",
  "more",
  "than",
  "some",
  "what",
  "when",
  "where",
  "which",
  "while",
  "your",
  "also",
  "only",
  "over",
  "such",
  "many",
  "most",
  "other",
]);

/** Upper bound for `DIAGNOSTICS_EVENT_TRIGGERED_NEWS_STALE_MINUTES` (env was previously capped at 360 in code). */
const STALE_EVENT_WINDOW_MAX_MINUTES = 1440;

/**
 * Env-tunable thresholds.
 * Default stale window (1440m = clamp max): maximizes eligibility vs typical RSS pub lag.
 * Clamp stale to 30–`STALE_EVENT_WINDOW_MAX_MINUTES`; numeric edge still uses `recentEdgeMaxMinutes` (default 45).
 * `minTokenHits`≥2 drops single-token collisions — see `computeNetEdge`.
 */
export type EventTriggeredNewsEffectiveConfig = {
  staleEventMinutes: number;
  recentEdgeMaxMinutes: number;
  highMappingConfidence: number;
  minSpreadBps: number;
  edgeScale: number;
  minTokenHits: number;
  rssCap: number;
  marketCap: number;
};

function numEnv(key: string, fallback: number): number {
  const v = Number(process.env[key]);
  return Number.isFinite(v) ? v : fallback;
}

/** Read diagnostics knobs from env (clamped). Snapshot is written to JSON each run. */
export function resolveEventTriggeredNewsEffectiveConfig(params: {
  rssCap: number;
  marketCap: number;
}): EventTriggeredNewsEffectiveConfig {
  let stale = Math.round(numEnv("DIAGNOSTICS_EVENT_TRIGGERED_NEWS_STALE_MINUTES", 1440));
  stale = Math.min(STALE_EVENT_WINDOW_MAX_MINUTES, Math.max(30, stale));

  let recent = Math.round(numEnv("DIAGNOSTICS_EVENT_TRIGGERED_NEWS_RECENT_EDGE_MINUTES", 45));
  recent = Math.min(120, Math.max(5, recent));
  if (recent > stale) recent = stale;

  let conf = numEnv("DIAGNOSTICS_EVENT_TRIGGERED_NEWS_HIGH_MAPPING_CONFIDENCE", 0.55);
  conf = Math.min(0.95, Math.max(0.2, conf));

  let spread = Math.round(numEnv("DIAGNOSTICS_EVENT_TRIGGERED_NEWS_MIN_SPREAD_BPS", 50));
  spread = Math.min(500, Math.max(10, spread));

  let edgeScale = numEnv("DIAGNOSTICS_EVENT_TRIGGERED_NEWS_EDGE_SCALE", 1.5e-7);
  if (!(edgeScale > 0) || !Number.isFinite(edgeScale)) edgeScale = 1.5e-7;

  let minTok = Math.round(numEnv("DIAGNOSTICS_EVENT_TRIGGERED_NEWS_MIN_TOKEN_HITS", 2));
  minTok = Math.min(5, Math.max(1, minTok));

  return {
    staleEventMinutes: stale,
    recentEdgeMaxMinutes: recent,
    highMappingConfidence: conf,
    minSpreadBps: spread,
    edgeScale,
    minTokenHits: minTok,
    rssCap: params.rssCap,
    marketCap: params.marketCap,
  };
}

export type EventTriggeredNewsRejectionReason = "no_market_match" | "low_confidence" | "stale_event";

/** Append news candidates and refresh diagnostics JSON (caller should gate on `DIAGNOSTICS_EVENT_TRIGGERED_NEWS_APPEND`). */
export async function maybeAppendEventTriggeredNewsDiagnosticsForTick(params: {
  now: Date;
  tickBatchId: string | null;
  engineBranch: string;
}): Promise<void> {
  const { now, tickBatchId, engineBranch } = params;
  const capRss = Math.min(200, Math.max(10, Number(process.env.DIAGNOSTICS_EVENT_TRIGGERED_NEWS_RSS_CAP ?? "80") || 80));
  const capMkts = Math.min(
    6000,
    Math.max(200, Number(process.env.DIAGNOSTICS_EVENT_TRIGGERED_NEWS_MARKET_CAP ?? "2500") || 2500)
  );
  const cycle = await runEventTriggeredNewsDiagnosticsCycle({
    now,
    tickBatchId,
    tickTimestampIso: now.toISOString(),
    engineBranch,
    botType: "event_triggered_news_diagnostics",
    maxRssItems: capRss,
    maxMarkets: capMkts,
  });
  await appendDiagnosticsCandidateLakeRecords(cycle.records);
  await writeEventTriggeredNewsDiagnosticsFile(cycle.diagnostics);
}

export async function writeEventTriggeredNewsDiagnosticsFile(d: EventTriggeredNewsDiagnostics): Promise<string> {
  const out = path.join(process.cwd(), "diagnostics", "event-triggered-news-diagnostics.json");
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, JSON.stringify(d, null, 2), "utf8");
  return out;
}

export type EventTriggeredNewsDiagnostics = {
  generatedAtIso: string;
  verdict: "news_source_live" | "news_source_empty" | "news_source_invalid";
  errorMessage: string | null;
  effectiveConfig: EventTriggeredNewsEffectiveConfig;
  rssItemsBySourceId: Record<string, number>;
  totals: {
    rssItems: number;
    matchedItems: number;
    candidatesGenerated: number;
    rejections: Record<EventTriggeredNewsRejectionReason, number>;
  };
  sampleMappings: Array<{
    rssTitle: string;
    rssUrl: string;
    marketId: string | null;
    marketTitle: string | null;
    hits: number;
    mappingConfidence: number;
    spreadBps: number | null;
    netEdgeAfterFeesAndImpact: number | null;
    rejectionReason: EventTriggeredNewsRejectionReason | null;
  }>;
};

type MarketRow = {
  id: string;
  slug: string;
  title: string;
  raw: string | null;
  assets: { tokenId: string; outcome: string }[];
};

/** Drops pure numeric tokens (e.g. years) that spuriously match many market titles. */
export function extractKeywords(text: string, max = 36): string[] {
  const t = text.toLowerCase().replace(/<[^>]+>/g, " ");
  const parts = t
    .split(/[^a-z0-9]+/g)
    .filter((w) => w.length >= 4 && !STOP.has(w) && !/^\d+$/.test(w));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const w of parts) {
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= max) break;
  }
  return out;
}

function ageMinutes(now: Date, publishedAt: Date | null): number {
  const t = publishedAt?.getTime() ?? now.getTime();
  return Math.max(0, (now.getTime() - t) / 60_000);
}

function freshnessScore(now: Date, publishedAt: Date | null, staleEventMinutes: number): number {
  const m = ageMinutes(now, publishedAt);
  if (m <= 10) return 1;
  if (m <= 30) return 0.9;
  if (m <= 60) return 0.75;
  if (m <= staleEventMinutes) return 0.55;
  return 0.25;
}

function regexEscapeToken(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Slug: substring match (often hyphen/compression; `\\b` misses glued tokens).
 * Title: whole-word match (natural sentences; avoids weak substring hits).
 */
function keywordHitsSlugOrTitle(slug: string, title: string, kw: string): boolean {
  if (slug.includes(kw)) return true;
  const escaped = regexEscapeToken(kw);
  try {
    const re = new RegExp(`\\b${escaped}\\b`, "i");
    return re.test(title);
  } catch {
    return title.includes(kw);
  }
}

function bestMarketForItem(
  item: FetchedItem,
  markets: MarketRow[],
  highMappingConfidence: number,
  minTokenHits: number
): {
  market: MarketRow;
  hits: number;
  mappingConfidence: number;
  rejection: EventTriggeredNewsRejectionReason | null;
} | null {
  const hay = `${item.title} ${item.body}`.toLowerCase();
  const keywords = extractKeywords(hay);
  if (keywords.length === 0) return null;

  let best: { market: MarketRow; hits: number } | null = null;
  for (const m of markets) {
    const slug = m.slug.toLowerCase();
    const title = m.title.toLowerCase();
    let hits = 0;
    for (const kw of keywords) {
      if (keywordHitsSlugOrTitle(slug, title, kw)) hits++;
    }
    if (hits < minTokenHits) continue;
    if (!best || hits > best.hits) best = { market: m, hits };
  }
  if (!best) return null;
  const cap = Math.max(5, keywords.length);
  const mappingConfidence = Math.min(1, best.hits / cap);
  let rejection: EventTriggeredNewsRejectionReason | null = null;
  if (mappingConfidence < highMappingConfidence) rejection = "low_confidence";
  return { market: best.market, hits: best.hits, mappingConfidence, rejection };
}

function pickYesAsset(assets: { tokenId: string; outcome: string }[]): { tokenId: string; side: string } | null {
  if (!assets.length) return null;
  const yes = assets.find((a) => /yes/i.test(a.outcome));
  const pick = yes ?? assets[0];
  return { tokenId: pick.tokenId, side: "BUY" };
}

function computeNetEdge(
  params: {
    now: Date;
    publishedAt: Date | null;
    mappingConfidence: number;
    spreadBps: number | null;
  },
  cfg: EventTriggeredNewsEffectiveConfig
): number | null {
  const { now, publishedAt, mappingConfidence, spreadBps } = params;
  if (ageMinutes(now, publishedAt) > cfg.recentEdgeMaxMinutes) return null;
  if (mappingConfidence < cfg.highMappingConfidence) return null;
  if (spreadBps == null || spreadBps < cfg.minSpreadBps) return null;
  const fresh = freshnessScore(now, publishedAt, cfg.staleEventMinutes);
  return cfg.edgeScale * fresh * mappingConfidence * spreadBps;
}

export async function runEventTriggeredNewsDiagnosticsCycle(params: {
  now: Date;
  tickBatchId: string | null;
  tickTimestampIso: string;
  engineBranch: string;
  botType: string;
  maxRssItems: number;
  maxMarkets: number;
  rssItemsOverride?: FetchedItem[] | null;
}): Promise<{ diagnostics: EventTriggeredNewsDiagnostics; records: CandidateLakePersistedRecord[] }> {
  const {
    now,
    tickBatchId,
    tickTimestampIso,
    engineBranch,
    botType,
    maxRssItems,
    maxMarkets,
    rssItemsOverride,
  } = params;
  const cfg = resolveEventTriggeredNewsEffectiveConfig({
    rssCap: maxRssItems,
    marketCap: maxMarkets,
  });

  const rejections: Record<EventTriggeredNewsRejectionReason, number> = {
    no_market_match: 0,
    low_confidence: 0,
    stale_event: 0,
  };
  const sampleMappings: EventTriggeredNewsDiagnostics["sampleMappings"] = [];
  const records: CandidateLakePersistedRecord[] = [];

  let rssItems: FetchedItem[] = [];
  let verdict: EventTriggeredNewsDiagnostics["verdict"] = "news_source_empty";
  let errorMessage: string | null = null;

  try {
    rssItems = rssItemsOverride ?? (await fetchAllEnabledSources());
  } catch (e) {
    verdict = "news_source_invalid";
    errorMessage = oneLineError(e);
    return {
      diagnostics: {
        generatedAtIso: now.toISOString(),
        verdict,
        errorMessage,
        effectiveConfig: cfg,
        rssItemsBySourceId: {},
        totals: { rssItems: 0, matchedItems: 0, candidatesGenerated: 0, rejections },
        sampleMappings,
      },
      records: [],
    };
  }

  const trimmed = rssItems.slice(0, maxRssItems);
  const rssItemsBySourceId: Record<string, number> = {};
  for (const it of trimmed) {
    rssItemsBySourceId[it.sourceId] = (rssItemsBySourceId[it.sourceId] ?? 0) + 1;
  }

  if (trimmed.length === 0) {
    verdict = "news_source_empty";
    return {
      diagnostics: {
        generatedAtIso: now.toISOString(),
        verdict,
        errorMessage: null,
        effectiveConfig: cfg,
        rssItemsBySourceId,
        totals: { rssItems: 0, matchedItems: 0, candidatesGenerated: 0, rejections },
        sampleMappings,
      },
      records: [],
    };
  }

  let markets: MarketRow[] = [];
  try {
    markets = await prisma.syncedMarket.findMany({
      orderBy: { updatedAt: "desc" },
      take: maxMarkets,
      select: {
        id: true,
        slug: true,
        title: true,
        raw: true,
        assets: { select: { tokenId: true, outcome: true } },
      },
    });
  } catch (e) {
    verdict = "news_source_invalid";
    errorMessage = oneLineError(e);
    return {
      diagnostics: {
        generatedAtIso: now.toISOString(),
        verdict,
        errorMessage,
        effectiveConfig: cfg,
        rssItemsBySourceId,
        totals: { rssItems: trimmed.length, matchedItems: 0, candidatesGenerated: 0, rejections },
        sampleMappings,
      },
      records: [],
    };
  }

  let matchedItems = 0;
  for (const item of trimmed) {
    const age = ageMinutes(now, item.publishedAt);
    if (age > cfg.staleEventMinutes) {
      rejections.stale_event++;
      if (sampleMappings.length < 12) {
        sampleMappings.push({
          rssTitle: item.title,
          rssUrl: item.url,
          marketId: null,
          marketTitle: null,
          hits: 0,
          mappingConfidence: 0,
          spreadBps: null,
          netEdgeAfterFeesAndImpact: null,
          rejectionReason: "stale_event",
        });
      }
      continue;
    }

    const pick = bestMarketForItem(item, markets, cfg.highMappingConfidence, cfg.minTokenHits);
    if (!pick) {
      rejections.no_market_match++;
      if (sampleMappings.length < 12) {
        sampleMappings.push({
          rssTitle: item.title,
          rssUrl: item.url,
          marketId: null,
          marketTitle: null,
          hits: 0,
          mappingConfidence: 0,
          spreadBps: null,
          netEdgeAfterFeesAndImpact: null,
          rejectionReason: "no_market_match",
        });
      }
      continue;
    }

    const assetPick = pickYesAsset(pick.market.assets);
    if (!assetPick) {
      rejections.no_market_match++;
      if (sampleMappings.length < 12) {
        sampleMappings.push({
          rssTitle: item.title,
          rssUrl: item.url,
          marketId: pick.market.id,
          marketTitle: pick.market.title,
          hits: pick.hits,
          mappingConfidence: pick.mappingConfidence,
          spreadBps: null,
          netEdgeAfterFeesAndImpact: null,
          rejectionReason: "no_market_match",
        });
      }
      continue;
    }
    matchedItems++;
    const spread = tryBidAskSpreadBpsFromSyncedMarketRaw(pick.market.raw, assetPick.tokenId).spreadBps;

    if (pick.rejection === "low_confidence") rejections.low_confidence++;

    const netEdge = computeNetEdge(
      {
        now,
        publishedAt: item.publishedAt,
        mappingConfidence: pick.mappingConfidence,
        spreadBps: spread,
      },
      cfg
    );

    const recommendationId = `etn:${item.dedupeHash}:${pick.market.id}:${assetPick.tokenId}`;

    records.push(
      buildCandidateLakePersistedRecordFromEventTriggeredNews({
        tickTimestampIso,
        tickBatchId,
        engineBranch,
        botType,
        recommendationId,
        marketId: pick.market.id,
        assetId: assetPick.tokenId,
        side: assetPick.side,
        netEdgeAfterFeesAndImpact: netEdge,
        expectedNetEdge: netEdge,
        uncertainty: netEdge != null ? 0.85 : 0.95,
        freshnessScore: freshnessScore(now, item.publishedAt, cfg.staleEventMinutes),
        spreadBps: spread,
        mappingConfidence: pick.mappingConfidence,
        eventTimestampIso: (item.publishedAt ?? now).toISOString(),
        rssSourceId: item.sourceId,
        rssUrl: item.url,
        rssTitle: item.title,
      })
    );

    if (sampleMappings.length < 12) {
      sampleMappings.push({
        rssTitle: item.title,
        rssUrl: item.url,
        marketId: pick.market.id,
        marketTitle: pick.market.title,
        hits: pick.hits,
        mappingConfidence: pick.mappingConfidence,
        spreadBps: spread,
        netEdgeAfterFeesAndImpact: netEdge,
        rejectionReason: pick.rejection,
      });
    }
  }

  verdict =
    trimmed.length > 0 && (matchedItems > 0 || records.length > 0)
      ? "news_source_live"
      : "news_source_empty";

  return {
    diagnostics: {
      generatedAtIso: now.toISOString(),
      verdict,
      errorMessage,
      effectiveConfig: cfg,
      rssItemsBySourceId,
      totals: {
        rssItems: trimmed.length,
        matchedItems,
        candidatesGenerated: records.length,
        rejections,
      },
      sampleMappings,
    },
    records,
  };
}
