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
  { name: "Reuters (World)", type: NEWS_SOURCE_TYPE_RSS, baseUrl: "https://www.reutersagency.com/feed/", credibilityScore: 0.9, enabled: true },
  { name: "AP Top News", type: NEWS_SOURCE_TYPE_RSS, baseUrl: "https://feeds.ap.org/rss/topnews", credibilityScore: 0.9, enabled: true },
  { name: "BBC World", type: NEWS_SOURCE_TYPE_RSS, baseUrl: "https://feeds.bbci.co.uk/news/world/rss.xml", credibilityScore: 0.85, enabled: true },
  { name: "Reuters Business", type: NEWS_SOURCE_TYPE_RSS, baseUrl: "https://www.reutersagency.com/feed/?best-topics=business-finance", credibilityScore: 0.9, enabled: true },
  { name: "Reuters Politics", type: NEWS_SOURCE_TYPE_RSS, baseUrl: "https://www.reutersagency.com/feed/?best-topics=politics", credibilityScore: 0.9, enabled: true },
  { name: "Reuters Markets", type: NEWS_SOURCE_TYPE_RSS, baseUrl: "https://www.reutersagency.com/feed/?best-topics=commodities-energy", credibilityScore: 0.9, enabled: true },
];

/**
 * Ensure default news sources exist. Idempotent; creates only if none exist.
 */
export async function ensureDefaultNewsSources(): Promise<NewsSourceRow[]> {
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
  return list.map((s) => ({
    id: s.id,
    name: s.name,
    type: s.type,
    baseUrl: s.baseUrl,
    credibilityScore: s.credibilityScore,
    enabled: s.enabled,
  }));
}
