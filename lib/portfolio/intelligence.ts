/**
 * Portfolio Intelligence v1: aggregates canonical positions into a dashboard-ready payload.
 * Uses the same open truth model as overview/positions: official positions define open set, filter closed, derived fallback.
 */

import { prisma } from "@/lib/db";
import { getLiveOfficialPositions } from "@/lib/portfolio/live-portfolio-service";
import { getLiveOfficialOpenOrders, getOrderSourceOfTruth } from "@/lib/portfolio/live-open-orders-service";
import { buildOpenPositionsFromOfficial } from "@/lib/portfolio/open-positions-from-official";
import {
  buildCanonicalPositionView,
  type CanonicalPositionView,
  type PositionEnrichmentInput,
} from "@/lib/portfolio/canonical-position-view";
import { computeCanonicalPositionInsight } from "@/lib/portfolio/canonical-position-insight";
import { enrichPositionsBatch } from "@/lib/portfolio/enrich-positions";
import { getResolutionCounts } from "@/lib/portfolio/resolution-classifier";
import {
  normalizeFreshnessForApi,
  unknownFreshness,
  type FreshnessState,
} from "@/lib/portfolio/freshness-contract";
import type { MergedOpenRow } from "@/lib/portfolio/open-positions-from-official";
import {
  buildPortfolioRiskInputFromViews,
  calculatePortfolioRisk,
  setPortfolioRiskSnapshot,
  type PortfolioRiskSnapshot,
  type PortfolioRiskWorkingOrderInput,
} from "@/lib/portfolio-risk";

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
  /** Sum of costBasis only for rows with available basis; used for PnL % flags. */
  totalCostBasis: number | null;
  /** Largest theme % of portfolio (by exposure). */
  topThemeConcentrationPct: number | null;
  /** Largest single market % of portfolio (by exposure). */
  topMarketConcentrationPct: number | null;
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
  /** "official" when open set from official feed; "derived" when fallback. */
  openPortfolioSource?: "official" | "derived";
  /** Response-level source of truth for live-truth architecture. */
  sourceOfTruth?: "official" | "derived" | "mixed_fallback";
  asOf?: string;
  freshnessMs?: number | null;
  freshnessState?: FreshnessState;
  officialFetchFailed?: boolean;
  totalRowsBeforeFiltering?: number;
  totalRowsAfterFiltering?: number;
  closedOfficialExcluded?: number;
  rowsWithOfficialBasis?: number;
  rowsWithDerivedBasis?: number;
  rowsWithUnavailableBasis?: number;
  /** Open orders: "official" when from CLOB; "derived" when fallback. */
  orderSourceOfTruth?: "official" | "derived";
  ordersAsOf?: string;
  ordersFreshnessMs?: number | null;
  ordersFreshnessState?: FreshnessState;
  officialOrdersFetchFailed?: boolean;
  officialOrdersFetchStatus?: number;
  officialOrdersFetchError?: string;
}

export interface PortfolioIntelligence {
  summary: PortfolioIntelligenceSummary;
  buckets: PortfolioIntelligenceBuckets;
  flags: IntelligenceFlag[];
  actions: IntelligenceAction[];
  diagnostics: PortfolioIntelligenceDiagnostics;
  /** Deterministic portfolio risk snapshot (concentration, exposure, warnings). */
  portfolioRiskSnapshot?: PortfolioRiskSnapshot | null;
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

// --- Build canonical positions from same open truth model as overview/positions ---

function mergedRowToPositionInput(row: MergedOpenRow): Parameters<typeof buildCanonicalPositionView>[0] {
  return {
    funderAddress: row.funderAddress,
    marketId: row.enrichMarketId,
    assetId: row.assetId,
    marketTitle: row.marketTitle ?? "",
    outcome: row.outcome,
    side: row.side,
    size: row.size,
    avgEntry: row.avgEntry,
    lastPrice: row.lastPrice,
    costBasis: row.costBasis,
    marketValue: row.marketValue,
    unrealizedPnl: row.unrealizedPnl,
    realizedPnl: row.realizedPnl,
    reservedOrderSize: row.reservedOrderSize,
    reservedOrderValue: row.reservedOrderValue,
    category: row.category,
    theme: row.theme,
    openedAt: row.openedAt,
  };
}

async function loadOpenCanonicalPositions(funderAddress: string): Promise<{
  views: CanonicalPositionView[];
  matchedByMarketId: number;
  matchedByConditionId: number;
  matchedByAssetId: number;
  openPortfolioSource: "official" | "derived";
  totalRowsBeforeFiltering: number;
  totalRowsAfterFiltering: number;
  closedOfficialExcluded: number;
  rowsWithOfficialBasis: number;
  rowsWithDerivedBasis: number;
  rowsWithUnavailableBasis: number;
  sourceOfTruth: "official" | "derived" | "mixed_fallback";
  asOf: Date;
  freshnessMs: number | null;
  freshnessState: FreshnessState;
  officialFetchFailed: boolean;
}> {
  const funder = funderAddress.toLowerCase().trim();
  const [liveOfficial, positions] = await Promise.all([
    getLiveOfficialPositions(funder),
    prisma.derivedPosition.findMany({
      where: { funderAddress: funder },
      include: { syncedMarket: { select: { status: true } } },
    }),
  ]);
  const officialResult = liveOfficial.result;
  const fetchMetadata = liveOfficial.metadata;
  const useOfficialAsOpenSet = fetchMetadata.success;
  const officialFetchFailed = !fetchMetadata.success;
  const sourceOfTruth = useOfficialAsOpenSet ? "official" : "derived";
  const asOf = fetchMetadata.asOf;
  const posFresh = normalizeFreshnessForApi(fetchMetadata.fromCache, fetchMetadata.freshnessMs);

  if (useOfficialAsOpenSet) {
    const merged = buildOpenPositionsFromOfficial(
      officialResult.positions,
      positions,
      funder,
      true
    );
    const enrichInput = merged.rows.map((r) => ({
      marketId: r.enrichMarketId,
      assetId: r.assetId,
      marketTitle: r.marketTitle,
      category: r.category,
      theme: r.theme,
    }));
    const { enriched } = await enrichPositionsBatch(enrichInput);

    const now = Date.now();
    const openOnlyRows: MergedOpenRow[] = [];
    const openOnlyEnriched: PositionEnrichmentInput[] = [];
    let closedOfficialExcluded = 0;

    for (let i = 0; i < merged.rows.length; i++) {
      const r = merged.rows[i];
      const e = enriched[i];
      const statusRaw = e.status ?? null;
      const status = (String(statusRaw ?? "").toLowerCase());
      const endIso =
        e.endDate == null
          ? null
          : typeof e.endDate === "string"
            ? e.endDate
            : new Date(e.endDate).toISOString();
      const end = endIso ? new Date(endIso).getTime() : null;
      const isStatusClosed = status === "closed";
      const isEndPast = end != null && Number.isFinite(end) && end <= now;
      if (isStatusClosed || isEndPast) {
        closedOfficialExcluded++;
        continue;
      }
      openOnlyRows.push(r);
      openOnlyEnriched.push(e);
    }

    const views = openOnlyRows.map((row, i) =>
      buildCanonicalPositionView(
        mergedRowToPositionInput(row),
        openOnlyEnriched[i],
        { firstFillAt: row.openedAt }
      )
    );

    const matchedByMarketId = openOnlyEnriched.filter((e) => e.matchedBy === "marketId").length;
    const matchedByConditionId = openOnlyEnriched.filter((e) => e.matchedBy === "conditionId").length;
    const matchedByAssetId = openOnlyEnriched.filter((e) => e.matchedBy === "assetId").length;
    const rowsWithOfficialBasis = openOnlyRows.filter(
      (r) => r.basisSource === "official" || r.basisSource === "official_only"
    ).length;
    const rowsWithDerivedBasis = openOnlyRows.filter((r) => r.basisSource === "derived").length;
    const rowsWithUnavailableBasis = openOnlyRows.filter(
      (r) => r.basisSource === "unavailable"
    ).length;

    return {
      views,
      matchedByMarketId,
      matchedByConditionId,
      matchedByAssetId,
      openPortfolioSource: "official",
      totalRowsBeforeFiltering: merged.rows.length,
      totalRowsAfterFiltering: openOnlyRows.length,
      closedOfficialExcluded,
      rowsWithOfficialBasis,
      rowsWithDerivedBasis,
      rowsWithUnavailableBasis,
      sourceOfTruth: "official",
      asOf: fetchMetadata.asOf,
      freshnessMs: posFresh.freshnessMs,
      freshnessState: posFresh.freshnessState,
      officialFetchFailed: false,
    };
  }

  // Fallback: derived-only, filter out closed by syncedMarket.status
  const openPositions = positions.filter(
    (p) => (p.syncedMarket?.status ?? "").toLowerCase() !== "closed"
  );
  if (openPositions.length === 0) {
    const unknown = unknownFreshness();
    return {
      views: [],
      matchedByMarketId: 0,
      matchedByConditionId: 0,
      matchedByAssetId: 0,
      openPortfolioSource: "derived",
      totalRowsBeforeFiltering: positions.length,
      totalRowsAfterFiltering: 0,
      closedOfficialExcluded: 0,
      rowsWithOfficialBasis: 0,
      rowsWithDerivedBasis: 0,
      rowsWithUnavailableBasis: 0,
      sourceOfTruth: "derived",
      asOf: new Date(),
      freshnessMs: unknown.freshnessMs,
      freshnessState: unknown.freshnessState,
      officialFetchFailed,
    };
  }

  const { enriched, diagnostics } = await enrichPositionsBatch(
    openPositions.map((p) => ({
      marketId: p.marketId,
      assetId: p.assetId,
      marketTitle: p.marketTitle,
      category: p.category,
      theme: p.theme,
    }))
  );

  const views = openPositions.map((p, i) =>
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

  const unknown = unknownFreshness();
  return {
    views,
    matchedByMarketId: diagnostics.matchedByMarketId,
    matchedByConditionId: diagnostics.matchedByConditionId,
    matchedByAssetId: diagnostics.matchedByAssetId,
    openPortfolioSource: "derived",
    totalRowsBeforeFiltering: positions.length,
    totalRowsAfterFiltering: openPositions.length,
    closedOfficialExcluded: 0,
    rowsWithOfficialBasis: 0,
    rowsWithDerivedBasis: 0,
    rowsWithUnavailableBasis: 0,
    sourceOfTruth: "derived",
    asOf: new Date(),
    freshnessMs: unknown.freshnessMs,
    freshnessState: unknown.freshnessState,
    officialFetchFailed,
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
    const topThemePct = summary.topThemeConcentrationPct ?? 0;
    if (topThemePct >= HIGH_CONCENTRATION_PCT) {
      const severity: FlagSeverity =
        topThemePct >= 60 ? "high" : topThemePct >= 45 ? "medium" : "low";
      flags.push({
        code: "HIGH_CONCENTRATION",
        severity,
        score: flagScore(severity, 0),
        message: `Top theme concentration is ${topThemePct.toFixed(1)}% of portfolio.`,
        metadata: { topThemeConcentrationPct: topThemePct },
      });
    }

    const totalPnl = summary.totalUnrealizedPnl ?? 0;
    const totalCostBasis = summary.totalCostBasis ?? 0;
    if (totalCostBasis > 0) {
      const pnlPct = (totalPnl / totalCostBasis) * 100;
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
 * Uses the same filtered open set as overview/positions: official feed when available, filter closed, derived fallback.
 * Open-order diagnostics come from live official open orders when available.
 */
export async function getPortfolioIntelligence(params: {
  funderAddress: string;
}): Promise<PortfolioIntelligence> {
  const funder = params.funderAddress?.trim()?.toLowerCase() ?? "";
  const [loadResult, liveOrdersResult] = await Promise.all([
    loadOpenCanonicalPositions(funder),
    getLiveOfficialOpenOrders(funder),
  ]);
  const orderSourceOfTruth = getOrderSourceOfTruth(liveOrdersResult.metadata);
  const {
    views,
    matchedByMarketId,
    matchedByConditionId,
    matchedByAssetId,
    openPortfolioSource,
    totalRowsBeforeFiltering,
    totalRowsAfterFiltering,
    closedOfficialExcluded,
    rowsWithOfficialBasis,
    rowsWithDerivedBasis,
    rowsWithUnavailableBasis,
    sourceOfTruth,
    asOf,
    freshnessMs,
    freshnessState,
    officialFetchFailed,
  } = loadResult;
  const orderFresh = liveOrdersResult.metadata.success
    ? normalizeFreshnessForApi(liveOrdersResult.metadata.fromCache, liveOrdersResult.metadata.freshnessMs)
    : unknownFreshness();

  const insightOptions = {
    nearResolutionHours: NEAR_RESOLUTION_HOURS,
    staleSyncHours: STALE_SYNC_HOURS,
  };

  const withInsight = views.map((v) => ({
    view: v,
    insight: computeCanonicalPositionInsight(v.timing, v.quality, insightOptions),
  }));

  const { unresolvedCount: canonicalUnresolved, resolvedCount: canonicalResolved } = getResolutionCounts(
    views.map((v) => v.quality)
  );
  const resolvedCount = canonicalResolved;
  const unresolvedCount = canonicalUnresolved;
  const staleCount = withInsight.filter((x) => x.insight.staleSync).length;
  const nearResolutionCount = withInsight.filter((x) => x.insight.nearResolution).length;

  const getCurrentValue = (v: CanonicalPositionView) =>
    safeNum(v.economics.currentValue ?? v.economics.exposure);
  const totalOpenExposure = views.reduce((s, v) => s + getCurrentValue(v), 0);
  const totalUnrealizedPnl = views.reduce(
    (s, v) => s + (v.economics.unrealizedPnl != null ? safeNum(v.economics.unrealizedPnl) : 0),
    0
  );
  const totalCostBasis = views.reduce((s, v) => {
    const cb = v.economics.costBasis;
    if (cb != null && cb !== "") {
      const n = safeNum(cb);
      if (Number.isFinite(n)) return s + n;
    }
    return s;
  }, 0);
  const yesExposure = views
    .filter((v) => v.token.side.toUpperCase() === "YES")
    .reduce((s, v) => s + getCurrentValue(v), 0);
  const noExposure = views
    .filter((v) => v.token.side.toUpperCase() === "NO")
    .reduce((s, v) => s + getCurrentValue(v), 0);

  const byMarketRaw = aggregateExposure(
    views,
    (v) => v.market.id ?? v.market.conditionId ?? "unknown",
    getCurrentValue
  );
  const byCategoryRaw = aggregateExposure(
    views,
    (v) => v.market.category ?? "other",
    getCurrentValue
  );
  const byThemeRaw = aggregateExposure(
    views,
    (v) => v.market.theme ?? "Other",
    getCurrentValue
  );
  const byMarket = byMarketRaw.filter((b) => b.exposure > 0);
  const byCategory = byCategoryRaw.filter((b) => b.exposure > 0);
  const byTheme = byThemeRaw.filter((b) => b.exposure > 0);

  const topThemeConcentrationPct =
    byTheme.length > 0 ? byTheme[0].pct : totalOpenExposure > 0 ? 0 : null;
  const topMarketConcentrationPct =
    byMarket.length > 0 ? byMarket[0].pct : totalOpenExposure > 0 ? 0 : null;

  const summary: PortfolioIntelligenceSummary = {
    totalPositions: views.length,
    resolvedPositions: resolvedCount,
    unresolvedPositions: unresolvedCount,
    stalePositions: staleCount,
    nearResolutionPositions: nearResolutionCount,
    totalOpenExposure: views.length > 0 ? totalOpenExposure : null,
    totalUnrealizedPnl: views.length > 0 ? totalUnrealizedPnl : null,
    totalCostBasis: views.length > 0 && totalCostBasis > 0 ? totalCostBasis : null,
    topThemeConcentrationPct: views.length > 0 ? topThemeConcentrationPct : null,
    topMarketConcentrationPct: views.length > 0 ? topMarketConcentrationPct : null,
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
    unresolvedPositions: unresolvedCount,
    stalePositions: staleCount,
    nearResolutionPositions: nearResolutionCount,
    matchedByMarketId,
    matchedByConditionId,
    matchedByAssetId,
    categoriesCount: categoriesSet.size,
    themesCount: themesSet.size,
    openPortfolioSource,
    sourceOfTruth,
    asOf: asOf.toISOString(),
    freshnessMs,
    freshnessState,
    officialFetchFailed,
    totalRowsBeforeFiltering,
    totalRowsAfterFiltering,
    closedOfficialExcluded,
    rowsWithOfficialBasis,
    rowsWithDerivedBasis,
    rowsWithUnavailableBasis,
    orderSourceOfTruth,
    ordersAsOf: liveOrdersResult.metadata.asOf.toISOString(),
    ordersFreshnessMs: orderFresh.freshnessMs,
    ordersFreshnessState: orderFresh.freshnessState,
    officialOrdersFetchFailed: !liveOrdersResult.metadata.success,
    officialOrdersFetchStatus: liveOrdersResult.metadata.status,
    officialOrdersFetchError: liveOrdersResult.metadata.error ?? undefined,
  };

  const workingOrdersForRisk: PortfolioRiskWorkingOrderInput[] = (liveOrdersResult.orders ?? []).map(
    (o) => ({
      assetId: o.assetId,
      marketId: o.marketId,
      side: o.side,
      size: safeNum(o.remainingSize ?? o.size),
      price: safeNum(o.price),
      theme: null,
    })
  );

  const riskInput = buildPortfolioRiskInputFromViews(funder, views, workingOrdersForRisk, {
    nearResolutionHoursThreshold: NEAR_RESOLUTION_HOURS,
    correlationHeuristics: "theme",
  });
  const portfolioRiskSnapshot = calculatePortfolioRisk(riskInput);
  setPortfolioRiskSnapshot(portfolioRiskSnapshot, funder);

  return {
    summary,
    buckets,
    flags,
    actions,
    diagnostics,
    portfolioRiskSnapshot,
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
