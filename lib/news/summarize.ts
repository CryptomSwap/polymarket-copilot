/**
 * Market-facing catalyst summaries: what happened, what changed, why it matters, uncertainty.
 * Structured and concise; heuristic/template-based (no LLM required).
 */

import { prisma } from "@/lib/db";

/**
 * Generate a short catalyst summary for a market–news link.
 * Uses title + summary/body snippet and source for a consistent structure.
 */
export function buildCatalystSummary(
  title: string,
  bodyOrSummary: string | null,
  sourceName: string,
  relevanceScore: number
): string {
  const snippet = (bodyOrSummary || title || "").slice(0, 300).replace(/\s+/g, " ").trim();
  const rel = relevanceScore >= 0.5 ? "High relevance" : relevanceScore >= 0.25 ? "Moderate relevance" : "Related";
  const parts: string[] = [];
  parts.push(`What: ${title.slice(0, 120)}${title.length > 120 ? "…" : ""}`);
  if (snippet && snippet !== title) parts.push(`Detail: ${snippet.slice(0, 200)}${snippet.length > 200 ? "…" : ""}`);
  parts.push(`Source: ${sourceName}. ${rel}.`);
  if (relevanceScore < 0.4) parts.push("Caveat: Link to this market is heuristic; verify relevance.");
  return parts.join(" ");
}

/**
 * Persist catalyst summaries for all MarketNewsLinks that don't have one.
 */
export async function fillCatalystSummaries(): Promise<number> {
  const links = await prisma.marketNewsLink.findMany({
    where: { catalystSummary: null },
    include: { newsItem: { include: { source: true } } },
  });
  let filled = 0;
  for (const link of links) {
    const summary = buildCatalystSummary(
      link.newsItem.title,
      link.newsItem.summary ?? link.newsItem.body,
      link.newsItem.source.name,
      link.relevanceScore
    );
    await prisma.marketNewsLink.update({
      where: { id: link.id },
      data: { catalystSummary: summary },
    });
    filled++;
  }
  return filled;
}
