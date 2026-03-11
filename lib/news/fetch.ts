/**
 * Fetch and normalize news from RSS (and optional direct) sources.
 */

import Parser from "rss-parser";
import { prisma } from "@/lib/db";
import type { NormalizedFeedItem } from "./dedupe";
import { dedupeHash } from "./dedupe";
import { getEnabledSources } from "./sources";

const parser = new Parser({
  timeout: 15000,
  headers: { "User-Agent": "PolymarketCopilot/1.0 (News ingestion)" },
});

export interface FetchedItem extends NormalizedFeedItem {
  sourceId: string;
  dedupeHash: string;
  language: string;
}

/**
 * Detect language from text (heuristic: common words). Default "en".
 */
function detectLanguage(text: string): string {
  const t = (text || "").toLowerCase();
  if (/\b(the|and|for|are|but|not|you|all|can|had|her|was|one|our|out|day|get|has|him|his|how|man|new|now|old|see|way|who|boy|did|its|let|put|say|she|too|use)\b/.test(t)) return "en";
  if (/\b(der|die|das|und|ist|sind|für|mit|auf|werden|können|haben)\b/.test(t)) return "de";
  if (/\b(le|la|les|des|une|est|sont|pour|que|dans|aux|avec)\b/.test(t)) return "fr";
  if (/\b(el|la|los|las|que|and|por|una|con|del|los|como)\b/.test(t)) return "es";
  return "en";
}

/**
 * Normalize RSS item to common shape.
 */
function normalizeRssItem(
  item: Parser.Item,
  sourceId: string
): FetchedItem | null {
  const link = item.link ?? item.guid ?? "";
  const title = (item.title ?? "").trim();
  if (!link || !title) return null;

  const content = item.content ?? item.contentSnippet ?? item.summary ?? "";
  const summary = (item.summary ?? item.contentSnippet ?? "").trim() || null;
  const body = (content || title).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 50000);

  let publishedAt: Date | null = null;
  if (item.pubDate) {
    const d = new Date(item.pubDate);
    if (!Number.isNaN(d.getTime())) publishedAt = d;
  }

  const normalized: NormalizedFeedItem = {
    url: link,
    title,
    body,
    summary,
    publishedAt,
  };
  const hash = dedupeHash(normalized);
  const language = detectLanguage(title + " " + body.slice(0, 500));

  return {
    ...normalized,
    sourceId,
    dedupeHash: hash,
    language,
  };
}

/**
 * Fetch one RSS feed and return normalized items.
 */
export async function fetchRssFeed(
  sourceId: string,
  feedUrl: string
): Promise<FetchedItem[]> {
  const items: FetchedItem[] = [];
  try {
    const feed = await parser.parseURL(feedUrl);
    for (const item of feed.items ?? []) {
      const n = normalizeRssItem(item, sourceId);
      if (n) items.push(n);
    }
  } catch (err) {
    console.warn("[news/fetch] RSS fetch failed:", feedUrl, err);
  }
  return items;
}

/**
 * Fetch all enabled RSS sources and return combined items.
 */
export async function fetchAllEnabledSources(): Promise<FetchedItem[]> {
  const sources = await getEnabledSources();
  const all: FetchedItem[] = [];
  for (const s of sources) {
    if (s.type !== "rss") continue;
    const items = await fetchRssFeed(s.id, s.baseUrl);
    all.push(...items);
  }
  return all;
}

/**
 * Persist fetched items; skip duplicates by dedupeHash. Returns created count.
 */
export async function persistFetchedItems(items: FetchedItem[]): Promise<number> {
  let created = 0;
  for (const it of items) {
    const existing = await prisma.newsItem.findUnique({ where: { dedupeHash: it.dedupeHash } });
    if (existing) {
      await prisma.newsItem.update({
        where: { id: existing.id },
        data: { fetchedAt: new Date() },
      });
      continue;
    }
    try {
      await prisma.newsItem.create({
        data: {
          sourceId: it.sourceId,
          url: it.url,
          title: it.title,
          body: it.body,
          summary: it.summary,
          publishedAt: it.publishedAt,
          dedupeHash: it.dedupeHash,
          language: it.language,
        },
      });
      created++;
    } catch (e) {
      // race: duplicate inserted by another process
    }
  }
  return created;
}
