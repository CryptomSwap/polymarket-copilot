/**
 * Signal generation: score market/outcomes with component-based fair price, edge, confidence, signal type.
 * Read-only. TODO: Manual trade flow will consume these; no order placement here.
 */

import { prisma } from "@/lib/db";
import { computeMarketMetrics } from "./market-metrics";
import type { MarketMetrics } from "./market-metrics";
import { getEventImpactByMarketsV2 } from "@/lib/news/impact-v2";
import { getNarrativeMomentumByThemes } from "@/lib/news/narratives";

export type SignalType =
  | "MOMENTUM_CONTINUATION"
  | "MISPRICED_BREAKOUT"
  | "CHEAP_LONGSHOT"
  | "OVERCROWDED_THEME"
  | "LATE_CHASE"
  | "WATCHLIST"
  | "EXIT_CANDIDATE"
  | "TRIM_CANDIDATE";

export interface MarketSignalRow {
  funderAddress: string;
  slug: string | null;
  conditionId: string | null;
  marketId: string;
  marketTitle: string;
  outcome: string;
  side: string;
  marketPrice: string;
  fairPrice: string;
  edge: string;
  confidence: string;
  momentumScore: string;
  liquidityScore: string;
  crowdingScore: string;
  portfolioPenalty: string;
  behaviorPenalty: string;
  momentumComponent: string | null;
  liquidityComponent: string | null;
  crowdingComponent: string | null;
  portfolioComponent: string | null;
  behaviorComponent: string | null;
  longshotComponent: string | null;
  timeComponent: string | null;
  eventImpactBoost: string | null;
  narrativeMomentumBoost: string | null;
  catalystConfidence: string | null;
  category: string;
  theme: string;
  signalType: SignalType;
  thesis: string | null;
  invalidation: string | null;
}

function toStr(n: number): string {
  return String(Number.isFinite(n) ? n : 0);
}

/**
 * Fair price from components: base + momentum + liquidity + crowding + portfolio + behavior + longshot + time.
 * Each component stored separately for explainability.
 */
function fairPriceFromComponents(metrics: MarketMetrics, behaviorPen: number): {
  fairPrice: number;
  momentumComponent: number;
  liquidityComponent: number;
  crowdingComponent: number;
  portfolioComponent: number;
  behaviorComponent: number;
  longshotComponent: number;
  timeComponent: number;
} {
  const base = metrics.marketPrice;
  const momentumTilt = (metrics.momentumScore - 0.5) * 0.08;
  const liquidityPen = metrics.liquidityScore < 0.2 ? -0.02 : 0;
  const crowdingPen = metrics.crowdingScore < 0.4 ? -0.02 : 0;
  const portPen = metrics.themeOverconcentrated ? -0.05 : metrics.userExposureInTheme > 0 ? -0.02 : 0;
  const behPen = -behaviorPen * 0.05;
  const longshotPen = metrics.marketPrice < 0.15 ? -0.03 : 0;
  const timePen =
    metrics.timeToResolutionDays != null && metrics.timeToResolutionDays < 7 ? -0.01 : 0;

  const fair =
    base +
    momentumTilt +
    liquidityPen +
    crowdingPen +
    portPen +
    behPen +
    longshotPen +
    timePen;

  return {
    fairPrice: Math.max(0.01, Math.min(0.99, fair)),
    momentumComponent: momentumTilt,
    liquidityComponent: liquidityPen,
    crowdingComponent: crowdingPen,
    portfolioComponent: portPen,
    behaviorComponent: behPen,
    longshotComponent: longshotPen,
    timeComponent: timePen,
  };
}

/**
 * Classify signal type from metrics and edge. Expanded taxonomy.
 */
function classifySignalType(
  metrics: MarketMetrics,
  edge: number,
  marketPrice: number
): SignalType {
  if (metrics.isChaseCondition) return "LATE_CHASE";
  if (metrics.crowdingScore < 0.3) return "OVERCROWDED_THEME";
  if (marketPrice < 0.15) return "CHEAP_LONGSHOT";
  if (Math.abs(edge) >= 0.1) return "MISPRICED_BREAKOUT";
  if (metrics.momentumScore >= 0.6 && edge > 0) return "MOMENTUM_CONTINUATION";
  if (edge <= -0.08) return "EXIT_CANDIDATE";
  if (edge <= -0.04) return "TRIM_CANDIDATE";
  return "WATCHLIST";
}

function portfolioPenalty(metrics: MarketMetrics): number {
  if (metrics.themeOverconcentrated) return 0.4;
  if (metrics.userExposureInTheme > 0) return 0.15;
  return 0;
}

async function behaviorPenalty(funderAddress: string): Promise<number> {
  const recent = await prisma.behaviorFlag.findMany({
    where: { funderAddress },
    orderBy: { createdAt: "desc" },
    take: 10,
  });
  const high = recent.filter((f) => f.severity === "high").length;
  const medium = recent.filter((f) => f.severity === "medium").length;
  if (high >= 2) return 0.3;
  if (high >= 1 || medium >= 2) return 0.15;
  return 0;
}

function thesisAndInvalidation(
  signalType: SignalType,
  marketPrice: number,
  fairPrice: number,
  edge: number
): { thesis: string; invalidation: string } {
  const edgePct = (edge * 100).toFixed(1);
  switch (signalType) {
    case "MOMENTUM_CONTINUATION":
      return {
        thesis: `Momentum supports level; edge ${edgePct}% vs fair.`,
        invalidation: "Price breaks key level or volume dries up.",
      };
    case "MISPRICED_BREAKOUT":
      return {
        thesis: `Price ${(marketPrice * 100).toFixed(1)}¢ vs fair ${(fairPrice * 100).toFixed(1)}¢; edge ${edgePct}%.`,
        invalidation: "New information or liquidity event reprices market.",
      };
    case "CHEAP_LONGSHOT":
      return {
        thesis: `Low price ${(marketPrice * 100).toFixed(1)}¢; edge ${edgePct}%. High risk.`,
        invalidation: "Catalyst fails or time decay.",
      };
    case "OVERCROWDED_THEME":
      return {
        thesis: "Low liquidity or crowded theme; caution on size.",
        invalidation: "Liquidity improves or theme rotates.",
      };
    case "LATE_CHASE":
      return {
        thesis: "Recent price acceleration; chase risk. Only if conviction very high.",
        invalidation: "Momentum fades or reversal.",
      };
    case "EXIT_CANDIDATE":
      return {
        thesis: `Negative edge ${edgePct}%; consider exit.`,
        invalidation: "Catalyst or flow improves.",
      };
    case "TRIM_CANDIDATE":
      return {
        thesis: `Moderate negative edge ${edgePct}%; consider trim.`,
        invalidation: "Edge improves.",
      };
    default:
      return {
        thesis: `Watch; edge ${edgePct}%.`,
        invalidation: "Conditions change.",
      };
  }
}

/**
 * Generate signals for tradable markets/outcomes for a funder.
 * Tradable: not closed, and endDate in the future or within a recent window.
 */
export async function generateSignals(funderAddress: string): Promise<MarketSignalRow[]> {
  const now = new Date();
  const cutoffDays = 30;
  const cutoff = new Date(now.getTime() - cutoffDays * 24 * 60 * 60 * 1000);
  const markets = await prisma.syncedMarket.findMany({
    where: {
      status: { not: "closed" },
      OR: [{ endDate: null }, { endDate: { gte: cutoff } }],
    },
    include: { assets: true },
    take: 200,
  });

  const behaviorPen = await behaviorPenalty(funderAddress);
  const marketIds = markets.map((m) => m.id);
  const [eventByMarket, narrativeByTheme] = await Promise.all([
    getEventImpactByMarketsV2(marketIds),
    getNarrativeMomentumByThemes([]),
  ]);
  const rows: MarketSignalRow[] = [];

  for (const m of markets) {
    let rawJson: Record<string, unknown> | null = null;
    if (m.raw) {
      try {
        rawJson = JSON.parse(m.raw) as Record<string, unknown>;
      } catch {
        rawJson = null;
      }
    }

    for (const a of m.assets) {
      const metrics = await computeMarketMetrics(
        {
          marketId: m.id,
          conditionId: m.conditionId,
          slug: m.slug,
          title: m.title,
          outcome: a.outcome,
          outcomeIndex: a.outcomeIndex ?? 0,
          tokenId: a.tokenId,
          rawJson,
          volumeNum: m.volumeNum,
          liquidityNum: m.liquidityNum,
          endDate: m.endDate,
        },
        funderAddress
      );

      const marketPrice = metrics.marketPrice;
      const portPen = portfolioPenalty(metrics);
      const {
        fairPrice,
        momentumComponent,
        liquidityComponent,
        crowdingComponent,
        portfolioComponent,
        behaviorComponent,
        longshotComponent,
        timeComponent,
      } = fairPriceFromComponents(metrics, behaviorPen);
      const eventImpact = eventByMarket[m.id] ?? {
        impactEstimate: 0,
        persistentImpact: 0,
        confidence: 0,
        eventCount: 0,
        calibratedCount: 0,
      };
      const narrativeMomentum = narrativeByTheme[metrics.theme] ?? narrativeByTheme[metrics.category] ?? 0;
      const blended = eventImpact.impactEstimate;
      const persistent = eventImpact.persistentImpact;
      const impactConf = eventImpact.confidence;
      const usePersistent = eventImpact.eventCount > 0 && persistent !== 0 && eventImpact.calibratedCount > 0;
      const impactForBoost = usePersistent ? 0.5 * blended + 0.5 * persistent : blended;
      const eventImpactBoost = Math.max(-0.05, Math.min(0.05, impactForBoost * 0.08 * (0.7 + impactConf * 0.3)));
      const narrativeMomentumBoost = Math.max(-0.03, Math.min(0.03, narrativeMomentum * 0.05));
      const catalystConfidence = Math.min(1, impactConf * 0.9 + (narrativeMomentum > 0.3 ? 0.05 : 0));
      const adjustedFair = Math.max(0.01, Math.min(0.99, fairPrice + eventImpactBoost + narrativeMomentumBoost));
      const edge = adjustedFair - marketPrice;
      const conf =
        0.5 +
        Math.min(0.3, Math.abs(edge) * 2) +
        metrics.liquidityScore * 0.2 -
        portPen -
        behaviorPen +
        catalystConfidence * 0.05;
      const confidence = Math.max(0, Math.min(1, conf));
      const signalType = classifySignalType(metrics, edge, marketPrice);
      const { thesis, invalidation } = thesisAndInvalidation(
        signalType,
        marketPrice,
        adjustedFair,
        edge
      );
      const side = a.outcome.toUpperCase() === "YES" ? "YES" : "NO";

      rows.push({
        funderAddress,
        slug: m.slug,
        conditionId: m.conditionId,
        marketId: m.id,
        marketTitle: m.title,
        outcome: a.outcome,
        side,
        marketPrice: toStr(marketPrice),
        fairPrice: toStr(adjustedFair),
        edge: toStr(edge),
        confidence: toStr(confidence),
        momentumScore: toStr(metrics.momentumScore),
        liquidityScore: toStr(metrics.liquidityScore),
        crowdingScore: toStr(metrics.crowdingScore),
        portfolioPenalty: toStr(portPen),
        behaviorPenalty: toStr(behaviorPen),
        momentumComponent: toStr(momentumComponent),
        liquidityComponent: toStr(liquidityComponent),
        crowdingComponent: toStr(crowdingComponent),
        portfolioComponent: toStr(portfolioComponent),
        behaviorComponent: toStr(behaviorComponent),
        longshotComponent: toStr(longshotComponent),
        timeComponent: toStr(timeComponent),
        eventImpactBoost: toStr(eventImpactBoost),
        narrativeMomentumBoost: toStr(narrativeMomentumBoost),
        catalystConfidence: toStr(catalystConfidence),
        category: metrics.category,
        theme: metrics.theme,
        signalType,
        thesis,
        invalidation,
      });
    }
  }

  return rows;
}
