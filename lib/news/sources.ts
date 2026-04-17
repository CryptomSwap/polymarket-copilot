/**
 * News source configuration: RSS and optional direct fetchers.
 * Credibility score 0–1; enable/disable per source.
 */

import { prisma } from "@/lib/db";

export const NEWS_SOURCE_TYPE_RSS = "rss";
export const NEWS_SOURCE_TYPE_DIRECT = "direct";

export interface NewsSourceRow {
  id: string;
  name: string;
  type: string;
  baseUrl: string;
  credibilityScore: number;
  enabled: boolean;
}

const DEFAULT_SOURCES: Omit<NewsSourceRow, "id">[] = [
  {
    name: "NYT World",
    type: NEWS_SOURCE_TYPE_RSS,
    baseUrl: "https://rss.nytimes.com/services/xml/rss/nyt/World.xml",
    credibilityScore: 0.88,
    enabled: true,
  },
  {
    name: "NPR News",
    type: NEWS_SOURCE_TYPE_RSS,
    baseUrl: "https://feeds.npr.org/1001/rss.xml",
    credibilityScore: 0.86,
    enabled: true,
  },
  {
    name: "BBC World",
    type: NEWS_SOURCE_TYPE_RSS,
    baseUrl: "https://feeds.bbci.co.uk/news/world/rss.xml",
    credibilityScore: 0.85,
    enabled: true,
  },
  {
    name: "Guardian Business",
    type: NEWS_SOURCE_TYPE_RSS,
    baseUrl: "https://www.theguardian.com/business/rss",
    credibilityScore: 0.85,
    enabled: true,
  },
  {
    name: "Guardian Politics",
    type: NEWS_SOURCE_TYPE_RSS,
    baseUrl: "https://www.theguardian.com/politics/rss",
    credibilityScore: 0.85,
    enabled: true,
  },
  {
    name: "FT Markets",
    type: NEWS_SOURCE_TYPE_RSS,
    baseUrl: "https://www.ft.com/markets?format=rss",
    credibilityScore: 0.82,
    enabled: true,
  },
];

/** `reutersagency.com` feeds return 404; remap existing DB rows idempotently. */
const LEGACY_SOURCE_REPAIRS: Array<{
  legacyUrl: string;
  name: string;
  baseUrl: string;
  credibilityScore: number;
}> = [
  {
    legacyUrl: "https://www.reutersagency.com/feed/",
    name: "NYT World",
    baseUrl: "https://rss.nytimes.com/services/xml/rss/nyt/World.xml",
    credibilityScore: 0.88,
  },
  {
    legacyUrl: "https://www.reutersagency.com/feed/?best-topics=business-finance",
    name: "Guardian Business",
    baseUrl: "https://www.theguardian.com/business/rss",
    credibilityScore: 0.85,
  },
  {
    legacyUrl: "https://www.reutersagency.com/feed/?best-topics=politics",
    name: "Guardian Politics",
    baseUrl: "https://www.theguardian.com/politics/rss",
    credibilityScore: 0.85,
  },
  {
    legacyUrl: "https://www.reutersagency.com/feed/?best-topics=commodities-energy",
    name: "FT Markets",
    baseUrl: "https://www.ft.com/markets?format=rss",
    credibilityScore: 0.82,
  },
  {
    legacyUrl: "https://reutersagency.com/feed/",
    name: "NYT World",
    baseUrl: "https://rss.nytimes.com/services/xml/rss/nyt/World.xml",
    credibilityScore: 0.88,
  },
  {
    legacyUrl: "https://reutersagency.com/feed/?best-topics=business-finance",
    name: "Guardian Business",
    baseUrl: "https://www.theguardian.com/business/rss",
    credibilityScore: 0.85,
  },
  {
    legacyUrl: "https://reutersagency.com/feed/?best-topics=politics",
    name: "Guardian Politics",
    baseUrl: "https://www.theguardian.com/politics/rss",
    credibilityScore: 0.85,
  },
  {
    legacyUrl: "https://reutersagency.com/feed/?best-topics=commodities-energy",
    name: "FT Markets",
    baseUrl: "https://www.ft.com/markets?format=rss",
    credibilityScore: 0.82,
  },
  {
    legacyUrl: "https://feeds.ap.org/rss/topnews",
    name: "NPR News",
    baseUrl: "https://feeds.npr.org/1001/rss.xml",
    credibilityScore: 0.86,
  },
];

/**
 * Patch DB rows that still point at broken reutersagency RSS URLs (404).
 * Safe to call on every fetch; updates are no-ops when URLs already match.
 */
export async function repairLegacyNewsSourceUrls(): Promise<void> {
  for (const r of LEGACY_SOURCE_REPAIRS) {
    await prisma.newsSource.updateMany({
      where: { baseUrl: r.legacyUrl },
      data: {
        name: r.name,
        baseUrl: r.baseUrl,
        credibilityScore: r.credibilityScore,
        enabled: true,
      },
    });
  }
}

/**
 * Ensure default news sources exist. Idempotent; creates only if none exist.
 */
export async function ensureDefaultNewsSources(): Promise<NewsSourceRow[]> {
  await repairLegacyNewsSourceUrls();
  const existing = await prisma.newsSource.count();
  if (existing > 0) {
    const list = await prisma.newsSource.findMany({ where: { enabled: true } });
    return list.map((s) => ({
      id: s.id,
      name: s.name,
      type: s.type,
      baseUrl: s.baseUrl,
      credibilityScore: s.credibilityScore,
      enabled: s.enabled,
    }));
  }
  const created: NewsSourceRow[] = [];
  for (const d of DEFAULT_SOURCES) {
    const s = await prisma.newsSource.create({
      data: {
        name: d.name,
        type: d.type,
        baseUrl: d.baseUrl,
        credibilityScore: d.credibilityScore,
        enabled: d.enabled,
      },
    });
    created.push({
      id: s.id,
      name: s.name,
      type: s.type,
      baseUrl: s.baseUrl,
      credibilityScore: s.credibilityScore,
      enabled: s.enabled,
    });
  }
  return created;
}

/**
 * List enabled sources for sync.
 */
export async function getEnabledSources(): Promise<NewsSourceRow[]> {
  const list = await prisma.newsSource.findMany({ where: { enabled: true } });
  const rows = list.map((s) => ({
    id: s.id,
    name: s.name,
    type: s.type,
    baseUrl: s.baseUrl,
    credibilityScore: s.credibilityScore,
    enabled: s.enabled,
  }));
  /** One fetch per URL (legacy repairs can leave duplicate rows). */
  const byUrl = new Map<string, NewsSourceRow>();
  for (const r of rows) {
    if (!byUrl.has(r.baseUrl)) byUrl.set(r.baseUrl, r);
  }
  return Array.from(byUrl.values());
}
