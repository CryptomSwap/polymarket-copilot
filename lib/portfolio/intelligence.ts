/**
 * Portfolio Intelligence v1: aggregates canonical positions into a dashboard-ready payload.
 * Uses canonical position layer and shared per-position insight helper. Deterministic, threshold-based.
 */

import { prisma } from "@/lib/db";
import {
  buildCanonicalPositionView,
  type CanonicalPositionView,
} from "@/lib/portfolio/canonical-position-view";
import { computeCanonicalPositionInsight } from "@/lib/portfolio/canonical-position-insight";
import { enrichPositionsBatch } from "@/lib/portfolio/enrich-positions";

// --- Helpers ---

function safeNum(value: string | number | null | undefined): number {
  if (value == null) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const n = parseFloat(String(value).trim());
  return Number.isFinite(n) ? n : 0;
}

function pct(value: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  return (value / total) * 100;
}

function aggregateExposure<T>(
  positions: T[],
  getKey: (p: T) => string,
  getExposure: (p: T) => number
): { key: string; exposure: number; pct: number }[] {
  const total = positions.reduce((s, p) => s + getExposure(p), 0);
  const byKey = new Map<string, number>();
  for (const p of positions) {
    const k = getKey(p) || "Unknown";
    byKey.set(k, (byKey.get(k) ?? 0) + getExposure(p));
  }
  return Array.from(byKey.entries())
    .map(([key, exposure]) => ({ key, exposure, pct: pct(exposure, total) }))
    .sort((a, b) => b.exposure - a.exposure);
}

// --- Thresholds (deterministic) ---

const NEAR_RESOLUTION_HOURS = 72;
const STALE_SYNC_HOURS = 24;
const HIGH_CONCENTRATION_PCT = 35;
const LARGE_LOSS_PCT = 20;
const LARGE_GAIN_PCT = 25;

// --- Payload types ---

export interface PortfolioIntelligenceSummary {
  totalPositions: number;
  resolvedPositions: number;
  unresolvedPositions: number;
  stalePositions: number;
  nearResolutionPositions: number;
  totalOpenExposure: number | null;
  totalUnrealizedPnl: number | null;
  topConcentrationPct: number | null;
  yesExposure: number | null;
  noExposure: number | null;
}

export interface ExposureBucket {
  key: string;
  exposure: number;
  pct: number;
}

export interface PositionRef {
  id: string;
  assetId: string;
  marketTitle: string | null;
  exposure: number;
}

export interface PortfolioIntelligenceBuckets {
  byMarket: ExposureBucket[];
  byCategory: ExposureBucket[];
  byTheme: ExposureBucket[];
  nearResolution: PositionRef[];
  stale: PositionRef[];
  unresolved: PositionRef[];
}

export type IntelligenceFlagCode =
  | "HIGH_CONCENTRATION"
  | "NEAR_RESOLUTION_CLUSTER"
  | "STALE_SYNC_CLUSTER"
  | "UNRESOLVED_CATALOG_POSITIONS"
  | "LARGE_LOSS"
  | "LARGE_GAIN";

export type FlagSeverity = "low" | "medium" | "high";

export interface IntelligenceFlag {
  code: IntelligenceFlagCode;
  severity: FlagSeverity;
  score: number;
  message: string;
  metadata?: Record<string, unknown>;
}

export type IntelligenceActionType = "review" | "sync" | "monitor" | "trim" | "hedge";

export interface IntelligenceAction {
  type: IntelligenceActionType;
  label: string;
  priority: number;
  flagCode?: IntelligenceFlagCode;
  detail?: string;
}

export interface PortfolioIntelligenceDiagnostics {
  totalPositions: number;
  resolvedPositions: number;
  unresolvedPositions: number;
  stalePositions: number;
  nearResolutionPositions: number;
  matchedByMarketId: number;
  matchedByConditionId: number;
  matchedByAssetId: number;
  categoriesCount: number;
  themesCount: number;
}

export interface PortfolioIntelligence {
  summary: PortfolioIntelligenceSummary;
  buckets: PortfolioIntelligenceBuckets;
  flags: IntelligenceFlag[];
  actions: IntelligenceAction[];
  diagnostics: PortfolioIntelligenceDiagnostics;
}

// --- Flag scoring ---

const FLAG_SEVERITY_WEIGHT: Record<FlagSeverity, number> = {
  high: 100,
  medium: 50,
  low: 10,
};

function flagScore(severity: FlagSeverity, ordinal: number): number {
  return FLAG_SEVERITY_WEIGHT[severity] + (10 - Math.min(ordinal, 10));
}

// --- Build canonical positions for funder ---

async function loadCanonicalPositions(funderAddress: string): Promise<{
  views: CanonicalPositionView[];
  matchedByMarketId: number;
  matchedByConditionId: number;
  matchedByAssetId: number;
  unresolved: number;
}> {
  const positions = await prisma.derivedPosition.findMany({
    where: { funderAddress: funderAddress.toLowerCase().trim() },
  });

  if (positions.length === 0) {
    return {
      views: [],
      matchedByMarketId: 0,
      matchedByConditionId: 0,
      matchedByAssetId: 0,
      unresolved: 0,
    };
  }

  const { enriched, diagnostics } = await enrichPositionsBatch(
    positions.map((p) => ({
      marketId: p.marketId,
      assetId: p.assetId,
      marketTitle: p.marketTitle,
      category: p.category,
      theme: p.theme,
    }))
  );

  const views = positions.map((p, i) =>
    buildCanonicalPositionView(
      {
        funderAddress: p.funderAddress,
        marketId: p.marketId,
        assetId: p.assetId,
        marketTitle: p.marketTitle ?? "",
        outcome: p.outcome,
        side: p.side,
        size: p.size,
        avgEntry: p.avgEntry,
        lastPrice: p.lastPrice,
        costBasis: p.costBasis,
        marketValue: p.marketValue,
        unrealizedPnl: p.unrealizedPnl,
        realizedPnl: p.realizedPnl,
        reservedOrderSize: p.reservedOrderSize,
        reservedOrderValue: p.reservedOrderValue,
        category: p.category,
        theme: p.theme,
        openedAt: p.openedAt,
      },
      enriched[i],
      { firstFillAt: p.openedAt }
    )
  );

  return {
    views,
    matchedByMarketId: diagnostics.matchedByMarketId,
    matchedByConditionId: diagnostics.matchedByConditionId,
    matchedByAssetId: diagnostics.matchedByAssetId,
    unresolved: diagnostics.unresolved,
  };
}

// --- Compute flags from aggregates ---

function computeFlags(
  summary: PortfolioIntelligenceSummary,
  buckets: PortfolioIntelligenceBuckets
): IntelligenceFlag[] {
  const flags: IntelligenceFlag[] = [];

  const totalExposure = summary.totalOpenExposure ?? 0;

  if (totalExposure > 0) {
    const topPct = summary.topConcentrationPct ?? 0;
    if (topPct >= HIGH_CONCENTRATION_PCT) {
      const severity: FlagSeverity =
        topPct >= 60 ? "high" : topPct >= 45 ? "medium" : "low";
      flags.push({
        code: "HIGH_CONCENTRATION",
        severity,
        score: flagScore(severity, 0),
        message: `Top concentration is ${topPct.toFixed(1)}% of portfolio.`,
        metadata: { topConcentrationPct: topPct },
      });
    }

    const totalPnl = summary.totalUnrealizedPnl ?? 0;
    const costBasis = totalExposure - totalPnl;
    if (costBasis > 0) {
      const pnlPct = (totalPnl / costBasis) * 100;
      if (pnlPct <= -LARGE_LOSS_PCT) {
        const sev: FlagSeverity = pnlPct <= -40 ? "high" : "medium";
        flags.push({
          code: "LARGE_LOSS",
          severity: sev,
          score: flagScore(sev, 0),
          message: `Unrealized loss ${pnlPct.toFixed(1)}% of cost basis.`,
          metadata: { pnlPct, totalUnrealizedPnl: totalPnl },
        });
      }
      if (pnlPct >= LARGE_GAIN_PCT) {
        const sev: FlagSeverity = pnlPct >= 50 ? "high" : "medium";
        flags.push({
          code: "LARGE_GAIN",
          severity: sev,
          score: flagScore(sev, 0),
          message: `Unrealized gain ${pnlPct.toFixed(1)}% of cost basis.`,
          metadata: { pnlPct, totalUnrealizedPnl: totalPnl },
        });
      }
    }
  }

  if (summary.nearResolutionPositions > 0) {
    const severity: FlagSeverity =
      summary.nearResolutionPositions >= 5
        ? "high"
        : summary.nearResolutionPositions >= 2
          ? "medium"
          : "low";
    flags.push({
      code: "NEAR_RESOLUTION_CLUSTER",
      severity,
      score: flagScore(severity, summary.nearResolutionPositions),
      message: `${summary.nearResolutionPositions} position(s) resolve within ${NEAR_RESOLUTION_HOURS}h.`,
      metadata: { count: summary.nearResolutionPositions },
    });
  }

  if (summary.stalePositions > 0) {
    const severity: FlagSeverity =
      summary.stalePositions >= 5 ? "high" : summary.stalePositions >= 2 ? "medium" : "low";
    flags.push({
      code: "STALE_SYNC_CLUSTER",
      severity,
      score: flagScore(severity, summary.stalePositions),
      message: `${summary.stalePositions} position(s) with stale sync (>${STALE_SYNC_HOURS}h).`,
      metadata: { count: summary.stalePositions },
    });
  }

  if (summary.unresolvedPositions > 0) {
    const severity: FlagSeverity =
      summary.unresolvedPositions >= 3 ? "medium" : "low";
    flags.push({
      code: "UNRESOLVED_CATALOG_POSITIONS",
      severity,
      score: flagScore(severity, summary.unresolvedPositions),
      message: `${summary.unresolvedPositions} position(s) not resolved to catalog.`,
      metadata: { count: summary.unresolvedPositions },
    });
  }

  return flags.sort((a, b) => b.score - a.score);
}

// --- Derive actions from flags ---

function deriveActions(flags: IntelligenceFlag[]): IntelligenceAction[] {
  const typeByCode: Record<IntelligenceFlagCode, { type: IntelligenceActionType; label: string }> = {
    HIGH_CONCENTRATION: { type: "trim", label: "Consider reducing concentration" },
    NEAR_RESOLUTION_CLUSTER: { type: "review", label: "Review positions resolving soon" },
    STALE_SYNC_CLUSTER: { type: "sync", label: "Sync portfolio data" },
    UNRESOLVED_CATALOG_POSITIONS: { type: "monitor", label: "Monitor unresolved positions" },
    LARGE_LOSS: { type: "review", label: "Review losing positions; consider trim or exit" },
    LARGE_GAIN: { type: "trim", label: "Consider taking partial profit" },
  };
  return flags.slice(0, 6).map((f, i) => {
    const { type, label } = typeByCode[f.code];
    return {
      type,
      label,
      priority: i + 1,
      flagCode: f.code,
      detail: f.message,
    };
  });
}

// --- Main service ---

/**
 * Get portfolio intelligence v1 for a funder.
 * Loads positions via canonical path, computes per-position insight, aggregates summary/buckets/flags/actions.
 */
export async function getPortfolioIntelligence(params: {
  funderAddress: string;
}): Promise<PortfolioIntelligence> {
  const funder = params.funderAddress?.trim()?.toLowerCase() ?? "";
  const {
    views,
    matchedByMarketId,
    matchedByConditionId,
    matchedByAssetId,
    unresolved,
  } = await loadCanonicalPositions(funder);

  const insightOptions = {
    nearResolutionHours: NEAR_RESOLUTION_HOURS,
    staleSyncHours: STALE_SYNC_HOURS,
  };

  const withInsight = views.map((v) => ({
    view: v,
    insight: computeCanonicalPositionInsight(v.timing, v.quality, insightOptions),
  }));

  const resolvedCount = matchedByMarketId + matchedByConditionId + matchedByAssetId;
  const staleCount = withInsight.filter((x) => x.insight.staleSync).length;
  const nearResolutionCount = withInsight.filter((x) => x.insight.nearResolution).length;
  const unresolvedCount = withInsight.filter((x) => x.insight.unresolvedCatalog).length;

  const getCurrentValue = (v: CanonicalPositionView) =>
    safeNum(v.economics.currentValue ?? v.economics.exposure);
  const totalOpenExposure = views.reduce((s, v) => s + getCurrentValue(v), 0);
  const totalUnrealizedPnl = views.reduce(
    (s, v) => s + safeNum(v.economics.unrealizedPnl),
    0
  );
  const yesExposure = views
    .filter((v) => v.token.side.toUpperCase() === "YES")
    .reduce((s, v) => s + getCurrentValue(v), 0);
  const noExposure = views
    .filter((v) => v.token.side.toUpperCase() === "NO")
    .reduce((s, v) => s + getCurrentValue(v), 0);

  const byMarket = aggregateExposure(
    views,
    (v) => v.market.id ?? v.market.conditionId ?? "unknown",
    getCurrentValue
  );
  const byCategory = aggregateExposure(
    views,
    (v) => v.market.category ?? "other",
    getCurrentValue
  );
  const byTheme = aggregateExposure(
    views,
    (v) => v.market.theme ?? "Other",
    getCurrentValue
  );

  const topConcentrationPct =
    byTheme.length > 0 ? byTheme[0].pct : totalOpenExposure > 0 ? 0 : null;

  const summary: PortfolioIntelligenceSummary = {
    totalPositions: views.length,
    resolvedPositions: resolvedCount,
    unresolvedPositions: unresolvedCount,
    stalePositions: staleCount,
    nearResolutionPositions: nearResolutionCount,
    totalOpenExposure: views.length > 0 ? totalOpenExposure : null,
    totalUnrealizedPnl: views.length > 0 ? totalUnrealizedPnl : null,
    topConcentrationPct: views.length > 0 ? topConcentrationPct : null,
    yesExposure: views.length > 0 ? yesExposure : null,
    noExposure: views.length > 0 ? noExposure : null,
  };

  const toRef = (v: CanonicalPositionView): PositionRef => ({
    id: v.id,
    assetId: v.token.assetId,
    marketTitle: v.market.title ?? null,
    exposure: getCurrentValue(v),
  });

  const buckets: PortfolioIntelligenceBuckets = {
    byMarket,
    byCategory,
    byTheme,
    nearResolution: withInsight
      .filter((x) => x.insight.nearResolution)
      .map((x) => toRef(x.view)),
    stale: withInsight.filter((x) => x.insight.staleSync).map((x) => toRef(x.view)),
    unresolved: withInsight
      .filter((x) => x.insight.unresolvedCatalog)
      .map((x) => toRef(x.view)),
  };

  const flags = computeFlags(summary, buckets);
  const actions = deriveActions(flags);

  const categoriesSet = new Set(views.map((v) => v.market.category ?? "other"));
  const themesSet = new Set(views.map((v) => v.market.theme ?? "Other"));

  const diagnostics: PortfolioIntelligenceDiagnostics = {
    totalPositions: views.length,
    resolvedPositions: resolvedCount,
    unresolvedPositions: unresolved,
    stalePositions: staleCount,
    nearResolutionPositions: nearResolutionCount,
    matchedByMarketId,
    matchedByConditionId,
    matchedByAssetId,
    categoriesCount: categoriesSet.size,
    themesCount: themesSet.size,
  };

  return {
    summary,
    buckets,
    flags,
    actions,
    diagnostics,
  };
}

// --- Legacy export for API route that may still reference EnrichedPosition ---

/** @deprecated Use canonical position view + insight instead. Kept for serialization compatibility. */
export interface EnrichedPosition {
  id?: string;
  funderAddress: string;
  marketId: string;
  assetId: string;
  marketTitle: string | null;
  outcome: string;
  side: string;
  marketValue: string;
  unrealizedPnl: string;
  endDate?: Date | null;
  hoursToEnd?: number | null;
  openedAt?: Date | null;
  [key: string]: unknown;
}
