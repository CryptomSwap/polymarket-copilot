/**
 * Narrative tracking: article count per theme, sentiment shifts, momentum. Persists NarrativeTrend.
 */

import { prisma } from "@/lib/db";

const THEME_FROM_EVENT: Record<string, string> = {
  sanctions: "geopolitics",
  war_escalation: "geopolitics",
  elections: "politics",
  central_bank: "macro",
  earnings: "corporate",
  regulation: "policy",
  other: "general",
};

export interface NarrativeTrendRow {
  theme: string;
  eventType: string;
  articleCount24h: number;
  sentimentTrend: string | null;
  momentumScore: number;
}

/**
 * Compute narrative metrics for the last 24h from EventSignals + NewsItems.
 */
export async function computeNarrativeTrends(opts?: {
  windowHours?: number;
}): Promise<NarrativeTrendRow[]> {
  const windowHours = opts?.windowHours ?? 24;
  const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);

  const signals = await prisma.eventSignal.findMany({
    where: { createdAt: { gte: since } },
    include: { newsItem: { select: { publishedAt: true } } },
  });

  const byThemeEvent = new Map<string, { count: number; sentiments: string[] }>();
  for (const s of signals) {
    const theme = THEME_FROM_EVENT[s.eventType] ?? "general";
    const key = `${theme}\t${s.eventType}`;
    const cur = byThemeEvent.get(key) ?? { count: 0, sentiments: [] };
    cur.count += 1;
    if (s.sentiment) cur.sentiments.push(s.sentiment);
    byThemeEvent.set(key, cur);
  }

  const prevWindow = new Date(Date.now() - 2 * windowHours * 60 * 60 * 1000);
  const prevSignals = await prisma.eventSignal.findMany({
    where: { createdAt: { gte: prevWindow, lt: since } },
  });
  const prevByKey = new Map<string, number>();
  for (const s of prevSignals) {
    const theme = THEME_FROM_EVENT[s.eventType] ?? "general";
    const key = `${theme}\t${s.eventType}`;
    prevByKey.set(key, (prevByKey.get(key) ?? 0) + 1);
  }

  const rows: NarrativeTrendRow[] = [];
  for (const [key, data] of Array.from(byThemeEvent.entries())) {
    const [theme, eventType] = key.split("\t");
    const prevCount = prevByKey.get(key) ?? 0;
    const momentum = data.count - prevCount;
    const momentumScore = prevCount > 0 ? Math.max(-1, Math.min(1, momentum / Math.max(1, prevCount))) : (data.count > 0 ? 0.5 : 0);
    const negCount = data.sentiments.filter((x) => x === "negative").length;
    const posCount = data.sentiments.filter((x) => x === "positive").length;
    let sentimentTrend: string | null = "neutral";
    if (data.sentiments.length > 0) {
      if (negCount > data.sentiments.length * 0.6) sentimentTrend = "rising_negative";
      else if (negCount > data.sentiments.length * 0.4) sentimentTrend = "falling_negative";
      else if (posCount > data.sentiments.length * 0.6) sentimentTrend = "rising_positive";
      else if (posCount > data.sentiments.length * 0.4) sentimentTrend = "falling_positive";
    }
    rows.push({
      theme,
      eventType,
      articleCount24h: data.count,
      sentimentTrend,
      momentumScore,
    });
  }
  return rows;
}

export interface NarrativeUpdateResult {
  trendsUpserted: number;
  errors: string[];
}

/**
 * Compute narrative trends and upsert NarrativeTrend.
 */
export async function runNarrativeTracking(opts?: { windowHours?: number }): Promise<NarrativeUpdateResult> {
  const errors: string[] = [];
  let trendsUpserted = 0;
  try {
    const rows = await computeNarrativeTrends(opts);
    for (const row of rows) {
      await prisma.narrativeTrend.upsert({
        where: {
          theme_eventType: { theme: row.theme, eventType: row.eventType },
        },
        create: {
          theme: row.theme,
          eventType: row.eventType,
          articleCount24h: row.articleCount24h,
          sentimentTrend: row.sentimentTrend,
          momentumScore: row.momentumScore,
        },
        update: {
          articleCount24h: row.articleCount24h,
          sentimentTrend: row.sentimentTrend,
          momentumScore: row.momentumScore,
          updatedAt: new Date(),
        },
      });
      trendsUpserted++;
    }
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }
  return { trendsUpserted, errors };
}

/**
 * Get narrative momentum score for a single theme (average momentum across event types). For recommendation/signal use.
 */
export async function getNarrativeMomentumForTheme(theme: string): Promise<number> {
  const trends = await prisma.narrativeTrend.findMany({
    where: { theme },
    take: 10,
  });
  if (trends.length === 0) return 0;
  const sum = trends.reduce((s, t) => s + t.momentumScore, 0);
  return sum / trends.length;
}

/**
 * Batch get narrative momentum by theme. Pass empty array to get all themes.
 */
export async function getNarrativeMomentumByThemes(
  themes: string[]
): Promise<Record<string, number>> {
  const trends = themes.length > 0
    ? await prisma.narrativeTrend.findMany({ where: { theme: { in: themes } } })
    : await prisma.narrativeTrend.findMany();
  const byTheme = new Map<string, number[]>();
  for (const t of trends) {
    const arr = byTheme.get(t.theme) ?? [];
    arr.push(t.momentumScore);
    byTheme.set(t.theme, arr);
  }
  const keys = themes.length > 0 ? themes : Array.from(byTheme.keys());
  const out: Record<string, number> = {};
  for (const theme of keys) {
    const arr = byTheme.get(theme) ?? [];
    out[theme] = arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  }
  return out;
}
