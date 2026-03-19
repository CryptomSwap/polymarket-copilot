/**
 * Build PortfolioRiskInput from various sources (DB rows, canonical views).
 * Keeps risk engine input-agnostic; callers own data loading.
 */

import type { PortfolioRiskInput, PortfolioRiskPositionInput, PortfolioRiskWorkingOrderInput } from "./types";

function parseNum(s: string | number | null | undefined): number {
  if (s == null) return 0;
  if (typeof s === "number" && Number.isFinite(s)) return s;
  const n = parseFloat(String(s).trim());
  return Number.isFinite(n) ? n : 0;
}

/** Minimal derived-position-like row (e.g. Prisma DerivedPosition). */
export interface DerivedPositionLike {
  assetId: string;
  marketId: string;
  marketTitle: string;
  outcome: string;
  side: string;
  size: string;
  marketValue: string;
  category?: string | null;
  theme?: string | null;
  reservedOrderSize?: string | null;
  reservedOrderValue?: string | null;
  syncedMarket?: { endDate?: Date | string | null } | null;
}

/**
 * Build risk input from DB-derived positions (e.g. Prisma DerivedPosition[]).
 * Use in decision recompute and other DB-driven flows.
 */
export function buildPortfolioRiskInputFromDerived(
  funderAddress: string,
  positions: DerivedPositionLike[],
  options?: {
    maxTotalExposure?: number;
    maxSingleMarketConcentrationPct?: number;
    maxSingleThemeConcentrationPct?: number;
    nearResolutionHoursThreshold?: number;
    correlationHeuristics?: PortfolioRiskInput["correlationHeuristics"];
  }
): PortfolioRiskInput {
  const posInputs: PortfolioRiskPositionInput[] = positions.map((p) => {
    const size = parseNum(p.size);
    const marketValue = parseNum(p.marketValue);
    const endDate = p.syncedMarket?.endDate ?? null;
    return {
      assetId: p.assetId,
      marketId: p.marketId,
      marketTitle: p.marketTitle ?? null,
      category: p.category ?? null,
      theme: p.theme ?? null,
      outcome: p.outcome ?? null,
      side: p.side ?? null,
      size,
      marketValue,
      maxPayout: size,
      endDate: endDate ? (typeof endDate === "string" ? endDate : (endDate as Date).toISOString()) : null,
    };
  });

  const workingOrders: PortfolioRiskWorkingOrderInput[] = [];
  for (const p of positions) {
    const reservedVal = parseNum(p.reservedOrderValue ?? p.reservedOrderSize);
    if (reservedVal > 0) {
      workingOrders.push({
        assetId: p.assetId,
        marketId: p.marketId,
        side: p.side ?? null,
        size: parseNum(p.reservedOrderSize),
        price: parseNum(p.reservedOrderSize) > 0 ? reservedVal / parseNum(p.reservedOrderSize) : 0,
        theme: p.theme ?? null,
      });
    }
  }

  return {
    funderAddress,
    positions: posInputs,
    workingOrders,
    maxTotalExposure: options?.maxTotalExposure,
    maxSingleMarketConcentrationPct: options?.maxSingleMarketConcentrationPct,
    maxSingleThemeConcentrationPct: options?.maxSingleThemeConcentrationPct,
    nearResolutionHoursThreshold: options?.nearResolutionHoursThreshold,
    correlationHeuristics: options?.correlationHeuristics ?? "theme",
  };
}

/** Canonical position view (from portfolio intelligence). */
export interface CanonicalPositionViewLike {
  market: { id: string | null; conditionId: string | null; title: string; category: string | null; theme: string | null; endDate: string | null };
  token: { assetId: string; outcome: string; side: string };
  economics: { quantity: string; currentValue?: string; exposure?: string; maxPayout?: string };
  quality?: { unresolvedCatalog?: boolean };
}

/**
 * Build risk input from canonical position views (e.g. from getPortfolioIntelligence flow).
 */
export function buildPortfolioRiskInputFromViews(
  funderAddress: string,
  views: CanonicalPositionViewLike[],
  workingOrders?: PortfolioRiskWorkingOrderInput[],
  options?: {
    maxTotalExposure?: number;
    maxSingleMarketConcentrationPct?: number;
    maxSingleThemeConcentrationPct?: number;
    nearResolutionHoursThreshold?: number;
    correlationHeuristics?: PortfolioRiskInput["correlationHeuristics"];
  }
): PortfolioRiskInput {
  const posInputs: PortfolioRiskPositionInput[] = views.map((v) => {
    const qty = parseNum(v.economics.quantity);
    const currentVal = parseNum(v.economics.currentValue ?? v.economics.exposure);
    return {
      assetId: v.token.assetId,
      marketId: v.market.id ?? v.market.conditionId ?? "",
      marketTitle: v.market.title ?? null,
      category: v.market.category ?? null,
      theme: v.market.theme ?? null,
      outcome: v.token.outcome ?? null,
      side: v.token.side ?? null,
      size: qty,
      marketValue: currentVal,
      maxPayout: parseNum(v.economics.maxPayout),
      endDate: v.market.endDate,
      illiquid: false,
      liquidityContext: null,
    };
  });

  return {
    funderAddress,
    positions: posInputs,
    workingOrders: workingOrders ?? [],
    maxTotalExposure: options?.maxTotalExposure,
    maxSingleMarketConcentrationPct: options?.maxSingleMarketConcentrationPct,
    maxSingleThemeConcentrationPct: options?.maxSingleThemeConcentrationPct,
    nearResolutionHoursThreshold: options?.nearResolutionHoursThreshold,
    correlationHeuristics: options?.correlationHeuristics ?? "theme",
  };
}
