import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";
import { getLiveOfficialPositions, getSourceOfTruth } from "@/lib/portfolio/live-portfolio-service";
import {
  getLiveOfficialOpenOrders,
  getOrderSourceOfTruth,
} from "@/lib/portfolio/live-open-orders-service";
import { buildOpenPositionsFromOfficial } from "@/lib/portfolio/open-positions-from-official";
import { enrichPositionsBatch } from "@/lib/portfolio/enrich-positions";
import { normalizeFreshnessForApi, unknownFreshness } from "@/lib/portfolio/freshness-contract";

export const dynamic = "force-dynamic";

function parseNum(s: string): number {
  const n = parseFloat(String(s).trim());
  return Number.isFinite(n) ? n : 0;
}

/** Safe date to ISO string; never throws. Invalid dates or null/undefined return null. Exported for regression tests. */
export function toIsoSafe(val: string | Date | null | undefined): string | null {
  if (val == null) return null;
  if (typeof val === "string") {
    const s = val.trim();
    return s === "" ? null : s;
  }
  try {
    const d = new Date(val);
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
  } catch {
    return null;
  }
}

export const OVERVIEW_STAGES = [
  "resolveFunder",
  "fetchData",
  "buildOpenPositions",
  "enrichPositions",
  "computeOverview",
  "buildResponse",
] as const;
export type OverviewStage = (typeof OVERVIEW_STAGES)[number];

export function safeErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Builds the structured 500 response for overview failures. Exported for regression tests. */
export function buildOverviewErrorResponse(stage: OverviewStage, err: unknown) {
  const message = safeErrorMessage(err);
  return NextResponse.json(
    { error: "overview_failed", stage, message },
    { status: 500 }
  );
}

/**
 * GET /api/portfolio/overview
 * Returns portfolio overview for the connected funder.
 * Default open portfolio = official positions feed only (derived-only excluded). Totals from merged rows with consistent math.
 * On failure returns 500 with structured JSON: { error: "overview_failed", stage, message }.
 */
export async function GET() {
  let currentStage: OverviewStage = "resolveFunder";
  try {
    currentStage = "resolveFunder";
    const funder = await getFunderForRecompute();
    if (!funder) {
      return NextResponse.json(
        { error: "No funder address. Connect wallet and save connection." },
        { status: 400 }
      );
    }

    currentStage = "fetchData";
    const [snapshot, positions, liveOfficial, liveOrders] = await Promise.all([
    prisma.portfolioSnapshot.findFirst({
      where: { funderAddress: funder },
      orderBy: { createdAt: "desc" },
      select: { id: true, createdAt: true },
    }),
    prisma.derivedPosition.findMany({
      where: { funderAddress: funder },
      include: { syncedMarket: { select: { status: true } } },
    }),
    getLiveOfficialPositions(funder),
    getLiveOfficialOpenOrders(funder),
  ]);
    const officialResult = liveOfficial.result;
    const fetchMetadata = liveOfficial.metadata;
    const useOfficialAsOpenSet = fetchMetadata.success;
    const officialFetchFailed = !fetchMetadata.success;

    currentStage = "buildOpenPositions";
    const merged = useOfficialAsOpenSet
    ? buildOpenPositionsFromOfficial(officialResult.positions, positions, funder, true)
    : null;
    let openRows = useOfficialAsOpenSet && merged
      ? merged.rows
      : positions.filter((p) => (p.syncedMarket?.status ?? "") !== "closed");

    let totalCurrentValue = 0;
  let totalCostBasis = 0;
  let totalMaxPayout = 0;
  let totalReserved = 0;
  let realizedPnl = 0;
  let unrealizedPnl = 0;
  let yesExposure = 0;
  let noExposure = 0;
    const byTheme = new Map<string, number>();
    const byMarket = new Map<string, number>();

    if (useOfficialAsOpenSet && merged) {
      currentStage = "enrichPositions";
      // Same closed filter as positions route: exclude status=closed and endDate in the past.
      const enrichInput = merged.rows.map((r) => ({
      marketId: r.enrichMarketId,
      assetId: r.assetId,
      marketTitle: r.marketTitle,
      category: r.category,
      theme: r.theme,
    }));
      const { enriched } = await enrichPositionsBatch(enrichInput);
      currentStage = "computeOverview";
      const excludedOfficialRows: {
      assetId: string;
      marketTitle: string | null;
      marketSlug: string | null;
      status: string | null;
      endDate: string | null;
      excludedReason: "status_closed" | "endDate_past";
      quantitySource: string;
      rowSource: string;
    }[] = [];
    let closedOfficialExcluded = 0;
    let rowsExcludedFromCostBasisTotal = 0;
    let rowsExcludedFromUnrealizedPnlTotal = 0;
    const now = Date.now();
    const openOnlyRows: typeof merged.rows = [];
    for (let i = 0; i < merged.rows.length; i++) {
      const r = merged.rows[i];
      const e = enriched[i];
      const statusRaw = e.status ?? null;
      const status = (statusRaw ?? "").toLowerCase();
      const endIso = toIsoSafe(e.endDate);
      const end = endIso ? new Date(endIso).getTime() : null;
      const isStatusClosed = status === "closed";
      const isEndPast = end != null && Number.isFinite(end) && end <= now;
      const isClosed = isStatusClosed || isEndPast;
      if (isClosed) {
        closedOfficialExcluded++;
        if (excludedOfficialRows.length < 20) {
          excludedOfficialRows.push({
            assetId: r.assetId,
            marketTitle: r.marketTitle ?? null,
            marketSlug: e.marketSlug ?? null,
            status: statusRaw,
            endDate: endIso,
            excludedReason: isStatusClosed ? "status_closed" : "endDate_past",
            quantitySource: r.quantitySource,
            rowSource: r.rowSource,
          });
        }
        continue;
      }
      openOnlyRows.push(r);
      const mv = parseNum(r.marketValue);
      const sizeNum = parseNum(r.size);
      totalCurrentValue += mv;
      totalMaxPayout += sizeNum;
      totalReserved += parseNum(r.reservedOrderValue);
      realizedPnl += parseNum(r.realizedPnl);
      if (r.costBasis != null) {
        totalCostBasis += parseNum(r.costBasis);
      } else {
        rowsExcludedFromCostBasisTotal++;
      }
      if (r.unrealizedPnl != null) {
        unrealizedPnl += parseNum(r.unrealizedPnl);
      } else {
        rowsExcludedFromUnrealizedPnlTotal++;
      }
      const theme = r.theme ?? "Other";
      const marketId = r.enrichMarketId || r.assetId;
      byTheme.set(theme, (byTheme.get(theme) ?? 0) + mv);
      byMarket.set(marketId, (byMarket.get(marketId) ?? 0) + mv);
      if (r.outcome?.toUpperCase() === "YES") yesExposure += mv;
      else if (r.outcome?.toUpperCase() === "NO") noExposure += mv;
    }
    openRows = openOnlyRows;
    (merged as {
      excludedOfficialRows?: typeof excludedOfficialRows;
      closedOfficialExcluded?: number;
      rowsExcludedFromCostBasisTotal?: number;
      rowsExcludedFromUnrealizedPnlTotal?: number;
    }).excludedOfficialRows = excludedOfficialRows;
    (merged as { closedOfficialExcluded?: number }).closedOfficialExcluded = closedOfficialExcluded;
    (merged as { rowsExcludedFromCostBasisTotal?: number }).rowsExcludedFromCostBasisTotal = rowsExcludedFromCostBasisTotal;
      (merged as { rowsExcludedFromUnrealizedPnlTotal?: number }).rowsExcludedFromUnrealizedPnlTotal = rowsExcludedFromUnrealizedPnlTotal;
    } else {
      currentStage = "computeOverview";
      for (const p of openRows) {
      const mv = parseNum(p.marketValue);
      const sizeNum = parseNum(p.size);
      totalCurrentValue += mv;
      totalMaxPayout += sizeNum;
      totalReserved += parseNum(p.reservedOrderValue);
      realizedPnl += parseNum(p.realizedPnl);
      const costBasisVal = (p as { costBasis?: string | null }).costBasis;
      if (costBasisVal != null) totalCostBasis += parseNum(costBasisVal);
      const unrealizedVal = (p as { unrealizedPnl?: string | null }).unrealizedPnl;
      if (unrealizedVal != null) unrealizedPnl += parseNum(unrealizedVal);
      const theme = p.theme ?? "Other";
      const marketId = (p as { marketId?: string }).marketId ?? p.assetId;
      byTheme.set(theme, (byTheme.get(theme) ?? 0) + mv);
      byMarket.set(marketId, (byMarket.get(marketId) ?? 0) + mv);
      if (p.outcome?.toUpperCase() === "YES") yesExposure += mv;
      else if (p.outcome?.toUpperCase() === "NO") noExposure += mv;
      }
    }

    currentStage = "buildResponse";
    const orderSourceOfTruth = getOrderSourceOfTruth(liveOrders.metadata);
    const openOrdersCount =
      liveOrders.metadata.success
        ? liveOrders.orders.length
        : await prisma.userOrder.count({ where: { funderAddress: funder } });
    const officialOrdersFetchFailed = !liveOrders.metadata.success;
    const topThemePct = totalCurrentValue > 0 && byTheme.size > 0
      ? (Math.max(...Array.from(byTheme.values())) / totalCurrentValue) * 100
      : 0;
    const topMarketPct = totalCurrentValue > 0 && byMarket.size > 0
      ? (Math.max(...Array.from(byMarket.values())) / totalCurrentValue) * 100
      : 0;
    const openPositionsCount = openRows.length;
    const sourceOfTruth = getSourceOfTruth(fetchMetadata, officialResult.positions.length);
    const posFresh = normalizeFreshnessForApi(fetchMetadata.fromCache, fetchMetadata.freshnessMs);
    const orderFresh = liveOrders.metadata.success
      ? normalizeFreshnessForApi(liveOrders.metadata.fromCache, liveOrders.metadata.freshnessMs)
      : unknownFreshness();
    const payload = {
    funderAddress: funder,
    sourceOfTruth,
    asOf: toIsoSafe(fetchMetadata.asOf) ?? fetchMetadata.asOf?.toISOString?.() ?? new Date().toISOString(),
    freshnessMs: posFresh.freshnessMs,
    freshnessState: posFresh.freshnessState,
    openPortfolioSource: useOfficialAsOpenSet ? "official" : "derived",
    orderSourceOfTruth,
    ordersAsOf: toIsoSafe(liveOrders.metadata.asOf) ?? liveOrders.metadata.asOf?.toISOString?.() ?? new Date().toISOString(),
    ordersFreshnessMs: orderFresh.freshnessMs,
    ordersFreshnessState: orderFresh.freshnessState,
    diagnostics: {
      ...(useOfficialAsOpenSet && merged
        ? {
            officialFetchFailed,
            officialFetchStatus: fetchMetadata.status,
            officialFetchError: fetchMetadata.error ?? undefined,
            officialPositionsUsed: merged.diagnostics.officialPositionsUsed,
            derivedRowsMatched: merged.diagnostics.derivedRowsMatched,
            officialOnlyIncluded: merged.diagnostics.officialOnlyIncluded,
            derivedOnlyExcluded: merged.diagnostics.derivedOnlyExcluded,
            rowsWithEstimatedBasis: merged.diagnostics.rowsWithEstimatedBasis,
            rowsWithMissingBasis: merged.diagnostics.rowsWithMissingBasis,
            rowsWithOfficialBasis: merged.diagnostics.rowsWithOfficialBasis,
            rowsWithDerivedBasis: merged.diagnostics.rowsWithDerivedBasis,
            rowsWithUnavailableBasis: merged.diagnostics.rowsWithUnavailableBasis,
            closedOfficialExcluded: (merged as { closedOfficialExcluded?: number }).closedOfficialExcluded ?? 0,
            excludedOfficialRows: (merged as { excludedOfficialRows?: unknown[] }).excludedOfficialRows ?? [],
            staleOfficialExcluded: merged.diagnostics.staleOfficialExcluded,
            excludedStaleOfficialRows: merged.diagnostics.excludedStaleOfficialRows,
            rowsExcludedFromCostBasisTotal: (merged as { rowsExcludedFromCostBasisTotal?: number }).rowsExcludedFromCostBasisTotal ?? 0,
            rowsExcludedFromUnrealizedPnlTotal: (merged as { rowsExcludedFromUnrealizedPnlTotal?: number }).rowsExcludedFromUnrealizedPnlTotal ?? 0,
          }
        : {}),
      orderSourceOfTruth,
      ordersAsOf: toIsoSafe(liveOrders.metadata.asOf) ?? liveOrders.metadata.asOf?.toISOString?.() ?? new Date().toISOString(),
      ordersFreshnessMs: orderFresh.freshnessMs ?? undefined,
      ordersFreshnessState: orderFresh.freshnessState,
      officialOrdersFetchFailed,
      officialOrdersFetchStatus: liveOrders.metadata.status,
      officialOrdersFetchError: liveOrders.metadata.error ?? undefined,
    },
    // Live-computed totals only. Use top-level asOf/freshnessMs for "last updated" — not persisted row metadata.
    snapshot: {
      totalOpenExposure: String(totalCurrentValue),
      totalCurrentValue: String(totalCurrentValue),
      totalCostBasis: String(totalCostBasis),
      totalMaxPayout: String(totalMaxPayout),
      totalReservedExposure: String(totalReserved),
      realizedPnl: String(realizedPnl),
      unrealizedPnl: String(unrealizedPnl),
      openPositionsCount,
      openOrdersCount,
      topThemeConcentrationPct: String(topThemePct),
      topMarketConcentrationPct: String(topMarketPct),
      yesExposure: String(yesExposure),
      noExposure: String(noExposure),
    },
    // Persisted DB snapshot row (audit/debug only). Never use for "last updated" when sourceOfTruth is live.
    ...(snapshot
      ? {
          persistedSnapshotMeta: {
            id: snapshot.id,
            createdAt: toIsoSafe(snapshot.createdAt) ?? snapshot.createdAt?.toISOString?.() ?? null,
          },
        }
      : {}),
  };
    if (!snapshot) {
      return NextResponse.json({
        ...payload,
        message: "Run portfolio recompute to refresh snapshot metadata. Totals are from current positions.",
      });
    }
    return NextResponse.json(payload);
  } catch (err) {
    console.error(
      "[GET /api/portfolio/overview]",
      "stage=" + currentStage,
      "error=" + safeErrorMessage(err),
      err instanceof Error ? err.stack : undefined
    );
    return buildOverviewErrorResponse(currentStage, err);
  }
}
